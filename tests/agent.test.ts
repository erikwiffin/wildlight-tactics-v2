import Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it } from 'vitest';
import { AgentError, apiRunner, sampleRunner, SYSTEM_PROMPT, type AgentClient, type SampleFn } from '../src/agent/agent';
import { beaconNames, turnBriefing } from '../src/agent/context';
import { activeUnit, applyAction, createMatch, newConfig, reachable } from '../src/core/engine';
import type { GameState } from '../src/core/types';

function match(): GameState {
  // Fox (id 0) acts first on Shattered Basin.
  return createMatch(newConfig('agent', [['fox', 'rhino', 'moth', 'eel'], ['lynx', 'porcupine', 'octopus', 'eel']], 'arena', [null, 'balanced']));
}

type Call = Anthropic.MessageCreateParamsNonStreaming;

/** A fake client that replays scripted responses and records requests. */
function fakeClient(script: ((req: Call) => Partial<Anthropic.Message> | Error)[]): AgentClient & { calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    messages: {
      async create(body: Call) {
        calls.push(structuredClone(body));
        const step = script[calls.length - 1];
        if (!step) throw new Error('script exhausted');
        const r = step(body);
        if (r instanceof Error) throw r;
        return { id: 'msg', type: 'message', role: 'assistant', model: 'claude-haiku-5-5', stop_reason: 'tool_use', content: [], ...r } as Anthropic.Message;
      },
    },
  };
}

const toolUse = (id: string, name: string, input: unknown) => ({ type: 'tool_use', id, name, input }) as Anthropic.ToolUseBlock;

function deps(state: GameState) {
  return {
    state: () => state,
    commit: async (a: Parameters<typeof applyAction>[1]) => applyAction(state, a),
  };
}

describe('agent briefing (what the agent can see)', () => {
  it('includes its own order, teammates’ orders, and previews', () => {
    const s = match();
    const b = turnBriefing(s, 0, { 0: 'Take B2', 2: 'Hold home', 4: 'Heal the fox' }, ['Pulse happened']);
    expect(b).toContain('YOUR ORDER: "Take B2"');
    expect(b).toContain('Order: "Heal the fox"');
    expect(b).toContain('Moves:');
    expect(b).toContain('Pulse happened');
  });

  it('never exposes the RNG state or enemy cooldowns', () => {
    const s = match();
    const enemy = s.units.find((u) => u.team === 1)!;
    enemy.cooldowns = { claw: 2 };
    s.units[0].cooldowns = { phase: 1 };
    const b = turnBriefing(s, 0, {}, []);
    for (const n of s.rng) expect(b).not.toContain(String(n));
    const enemyLine = b.split('\n').find((l) => l.includes(`#${enemy.id} (`))!;
    expect(enemyLine).not.toContain('cooldown');
    expect(b).toContain('cooldowns: phase 1'); // own team's cooldowns are shown, as in the ability list
  });
});

describe('agent turn loop', () => {
  it('runs a reply\'s calls in order; a failed action skips the rest of the reply so Claude can retry', async () => {
    const s = match();
    const dest = [...reachable(s, s.units[0]).values()][0].hex;
    const client = fakeClient([
      () => ({
        content: [
          toolUse('a', 'move', dest),
          toolUse('b', 'use_ability', { ability: 'bite', q: 99, r: 99 }), // illegal
          toolUse('c', 'end_turn', { facing: 'NE', report: 'Moved up toward B2.' }), // skipped
        ],
      }),
      (req) => {
        const results = req.messages.at(-1)!.content as Anthropic.ToolResultBlockParam[];
        expect(results.map((r) => !!r.is_error)).toEqual([false, true, true]);
        expect(String(results[2].content)).toContain('Skipped');
        expect(activeUnit(s)?.id).toBe(0); // turn still ours
        return { content: [toolUse('d', 'end_turn', { facing: 'NE', report: 'Moved up toward B2.' })] };
      },
    ]);
    const res = await apiRunner(client)(deps(s), 0, { 0: 'Take B2' }, []);
    expect(res.report).toBe('Moved up toward B2.');
    expect(s.units[0].pos).toEqual(dest);
    expect(res.facts).toBe(`moved to (${dest.q},${dest.r}), no action`);
    expect(activeUnit(s)?.id).not.toBe(0);
    expect(client.calls).toHaveLength(2);
    expect(client.calls[0].model).toBe('claude-haiku-5-5');
    expect(client.calls[0].system).toEqual([{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }]);
  });

  it('feeds tool errors back and lets the model correct itself', async () => {
    const s = match();
    const client = fakeClient([
      () => ({ content: [toolUse('a', 'move', { q: 6, r: -6 })] }),
      (req) => {
        const last = req.messages[req.messages.length - 1];
        const result = (last.content as Anthropic.ToolResultBlockParam[])[0];
        expect(result.is_error).toBe(true);
        expect(String(result.content)).toContain("Can't move");
        return { content: [toolUse('b', 'end_turn', { facing: 'E', report: 'Holding.' })] };
      },
    ]);
    const res = await apiRunner(client)(deps(s), 0, { 0: 'x' }, []);
    expect(res.report).toBe('Holding.');
    expect(client.calls).toHaveLength(2);
  });

  it('check_position previews without changing the game', async () => {
    const s = match();
    const before = JSON.stringify(s);
    const dest = [...reachable(s, s.units[0]).values()][2].hex;
    const client = fakeClient([
      () => ({ content: [toolUse('a', 'check_position', dest)] }),
      (req) => {
        const res = (req.messages.at(-1)!.content as Anthropic.ToolResultBlockParam[])[0];
        expect(String(res.content)).toContain(`From (${dest.q},${dest.r})`);
        expect(JSON.stringify(s)).toBe(before);
        return { content: [toolUse('b', 'end_turn', { facing: 'E', report: 'Waiting.' })] };
      },
    ]);
    await apiRunner(client)(deps(s), 0, { 0: 'x' }, []);
  });

  it('fails clearly when the model never ends its turn', async () => {
    const s = match();
    const client = fakeClient(Array(6).fill(() => ({ content: [toolUse('x', 'check_position', { q: 0, r: 0 })] })));
    await expect(apiRunner(client)(deps(s), 0, { 0: 'x' }, [])).rejects.toThrow(AgentError);
  });

  it('turns API errors into a readable AgentError', async () => {
    const s = match();
    const client = fakeClient([() => new Anthropic.RateLimitError(429, undefined, 'slow down', new Headers())]);
    await expect(apiRunner(client)(deps(s), 0, { 0: 'x' }, [])).rejects.toThrow(/Rate limited/);
  });

  it('treats a refusal as a failure, not a turn', async () => {
    const s = match();
    const client = fakeClient([() => ({ stop_reason: 'refusal', content: [] })]);
    await expect(apiRunner(client)(deps(s), 0, { 0: 'x' }, [])).rejects.toThrow(/declined/);
  });
});

describe('claude.ai sample backend', () => {
  /** Simulates the platform: runs scripted tool calls through the page's execute functions. */
  function fakeSample(script: { tool: string; input: Record<string, unknown> }[], opts: { modelApplied?: string; reject?: string } = {}) {
    const seen: { prompt: string; errors: string[]; aborted: boolean; options?: Parameters<SampleFn>[1] } = { prompt: '', errors: [], aborted: false };
    const fn = (async (prompt, options) => {
      seen.prompt = prompt;
      seen.options = options;
      if (opts.reject) throw { code: opts.reject, message: 'x' };
      for (const step of script) {
        if (options.signal?.aborted) throw { code: 'cancelled', message: 'stopped' };
        const tool = options.tools.find((t) => t.name === step.tool)!;
        try {
          await tool.execute(step.input);
        } catch (e) {
          seen.errors.push((e as Error).message);
        }
        await new Promise((r) => setTimeout(r, 1)); // the next round starts later
      }
      seen.aborted = !!options.signal?.aborted;
      if (options.signal?.aborted) throw { code: 'cancelled', message: 'stopped' };
      return { text: 'ok', truncated: false, modelTierApplied: 'quick', modelApplied: opts.modelApplied };
    }) as SampleFn;
    fn.limits = async () => ({ tools: { maxCount: 8 } });
    return { fn, seen };
  }

  it('plays a turn with page tools, pinned to Haiku; tool calls after end_turn change nothing', async () => {
    const s = match();
    const dest = [...reachable(s, s.units[0]).values()][0].hex;
    const { fn, seen } = fakeSample(
      [
        { tool: 'move', input: { ...dest } },
        { tool: 'end_turn', input: { facing: 'NE', report: 'Advanced.' } },
        { tool: 'move', input: { q: 0, r: 0 } }, // after the turn: must be a no-op
      ],
      { modelApplied: 'claude-haiku-5-5' },
    );
    const res = await sampleRunner(fn)(deps(s), 0, { 0: 'Advance' }, []);
    expect(res.report).toBe('Advanced.');
    expect(res.note).toBeUndefined();
    expect(s.units[0].pos).toEqual(dest);
    expect(s.units.every((u) => !(u.pos.q === 0 && u.pos.r === 0))).toBe(true);
    expect(seen.options?.model).toBe('claude-haiku-5-5');
    expect(seen.options?.effort).toBe('low');
    expect(seen.prompt).toContain('YOUR ORDER: "Advance"');
  });

  it('reports tool errors to Claude by throwing, and keeps going', async () => {
    const s = match();
    const { fn, seen } = fakeSample([
      { tool: 'move', input: { q: 6, r: -6 } },
      { tool: 'end_turn', input: { facing: 'E', report: 'Held.' } },
    ]);
    const res = await sampleRunner(fn)(deps(s), 0, { 0: 'x' }, []);
    expect(seen.errors[0]).toContain("Can't move");
    expect(res.report).toBe('Held.');
    expect(res.note).toContain('wasn');
  });

  it('turns a refused permission into a clear pause message', async () => {
    const s = match();
    const { fn } = fakeSample([], { reject: 'not_granted' });
    await expect(sampleRunner(fn)(deps(s), 0, { 0: 'x' }, [])).rejects.toThrow(/Permissions/);
  });

  it('fails if Claude stops without ending the turn', async () => {
    const s = match();
    const { fn } = fakeSample([{ tool: 'check_position', input: { q: 0, r: 0 } }]);
    await expect(sampleRunner(fn)(deps(s), 0, { 0: 'x' }, [])).rejects.toThrow(AgentError);
  });
});

describe('beacon names (how orders refer to Beacons)', () => {
  const names = (mapId: string, team: 0 | 1, size: number) => {
    const t = ['rhino', 'fox', 'moth', 'eel', 'lynx'].slice(0, size);
    return beaconNames(createMatch(newConfig('n', [t, t], mapId)), team);
  };
  it('names home, enemy home and center on Shattered Basin, mirrored per side', () => {
    expect(names('arena', 0, 4)).toEqual(['home', 'enemy home', 'center']);
    expect(names('arena', 1, 4)).toEqual(['enemy home', 'home', 'center']);
  });
  it('names flanks as each side sees them on Glass Hollow, which has no center or home', () => {
    expect(names('hollow', 0, 3)).toEqual(['left flank', 'right flank']);
    expect(names('hollow', 1, 3)).toEqual(['right flank', 'left flank']);
    const s = createMatch(newConfig('n', [['rhino', 'fox', 'moth'], ['rhino', 'fox', 'moth']], 'hollow'));
    expect(turnBriefing(s, 0, {}, [])).toContain('It has no center or home or enemy home Beacon');
  });
  it('covers the lane and ring maps', () => {
    expect(names('fault', 0, 5)).toEqual(['home', 'enemy home', 'left flank', 'right flank', 'center']);
    expect(names('caldera', 0, 4)).toEqual(['home', 'enemy home', 'left flank', 'right flank']);
  });
});

describe('tool calls that arrive at the same time (claude.ai runs a round concurrently)', () => {
  /** Like the platform: one round, every tool call started at once. */
  function concurrentSample(calls: { tool: string; input: Record<string, unknown> }[]) {
    const seen: { results: string[] } = { results: [] };
    const fn = (async (_prompt, options) => {
      const results = await Promise.all(
        calls.map((c) =>
          Promise.resolve()
            .then(() => options.tools.find((t) => t.name === c.tool)!.execute(c.input))
            .then((r) => String(r), (e) => `Error: ${(e as Error).message}`),
        ),
      );
      seen.results = results;
      return { text: 'ok', truncated: false, modelTierApplied: 'quick', modelApplied: 'claude-haiku-5-5' };
    }) as SampleFn;
    fn.limits = async () => ({ tools: { maxCount: 8 } });
    return { fn, seen };
  }
  /** Like the game screen: moves and abilities animate (take time), ending a turn doesn't. */
  function animatedDeps(state: GameState) {
    return {
      state: () => state,
      commit: async (a: Parameters<typeof applyAction>[1]) => {
        if (a.type !== 'end') await new Promise((r) => setTimeout(r, 20));
        return applyAction(state, a);
      },
    };
  }

  it('runs them one at a time, in the order Claude called them', async () => {
    const s = match();
    const rhino = s.units.find((u) => u.team === 0 && u.defId === 'rhino')!;
    s.turn = { unit: rhino.id, moved: false, acted: false };
    const dest = [...reachable(s, rhino).values()].at(-1)!.hex;
    const { fn } = concurrentSample([
      { tool: 'move', input: { ...dest } },
      { tool: 'use_ability', input: { ability: 'plate', ...dest } },
      { tool: 'end_turn', input: { facing: 'NE', report: 'Moved up and shielded.' } },
    ]);
    const res = await sampleRunner(fn)(animatedDeps(s), rhino.id, { [rhino.id]: 'Advance' }, []);
    expect(rhino.pos).toEqual(dest);
    expect(rhino.statuses.map((x) => x.id)).toContain('shield');
    expect(res.trace.map((c) => c.tool)).toEqual(['move', 'use_ability', 'end_turn']);
    expect(res.facts).toBe(`moved to (${dest.q},${dest.r}), used Plate Up`);
  });

  it('skips the rest of a round after a failed action, so Claude can re-plan', async () => {
    const s = match();
    const rhino = s.units.find((u) => u.team === 0 && u.defId === 'rhino')!;
    s.turn = { unit: rhino.id, moved: false, acted: false };
    const { fn, seen } = concurrentSample([
      { tool: 'use_ability', input: { ability: 'plate', q: 6, r: -6 } }, // wrong target
      { tool: 'end_turn', input: { facing: 'NE', report: 'Shielded.' } },
    ]);
    await expect(sampleRunner(fn)(animatedDeps(s), rhino.id, { [rhino.id]: 'x' }, [])).rejects.toThrow(AgentError);
    expect(seen.results[1]).toContain('Skipped');
    expect(s.turn?.unit).toBe(rhino.id); // the turn did not end behind Claude's back
  });

  it('records actions that throw instead of losing them from the log', async () => {
    const s = match();
    const failing = {
      state: () => s,
      commit: async () => {
        throw new Error('boom');
      },
    };
    const client = fakeClient([
      () => ({ content: [toolUse('a', 'move', { ...[...reachable(s, s.units[0]).values()][0].hex })] }),
      () => ({ content: [toolUse('b', 'end_turn', { facing: 'E', report: 'x' })] }),
    ]);
    const err = await apiRunner(client)(failing, 0, { 0: 'x' }, []).catch((e) => e);
    expect(err).toBeInstanceOf(AgentError);
    expect(err.trace[0]).toMatchObject({ tool: 'move', error: true, result: 'Error: boom' });
  });
});
