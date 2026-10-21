import Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it } from 'vitest';
import { AgentError, runUnitTurn, SYSTEM_PROMPT, type AgentClient } from '../src/agent/agent';
import { turnBriefing } from '../src/agent/context';
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

function deps(state: GameState, client: AgentClient) {
  return {
    client,
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
  it('runs move, ability and end_turn from one reply, in order, and returns the report', async () => {
    const s = match();
    const dest = [...reachable(s, s.units[0]).values()][0].hex;
    const client = fakeClient([
      () => ({
        content: [
          toolUse('a', 'move', dest),
          toolUse('b', 'use_ability', { ability: 'bite', q: 99, r: 99 }), // illegal: reported, not fatal
          toolUse('c', 'end_turn', { facing: 'NE', report: 'Moved up toward B2.' }),
        ],
      }),
    ]);
    const res = await runUnitTurn(deps(s, client), 0, { 0: 'Take B2' }, []);
    expect(res.report).toBe('Moved up toward B2.');
    expect(s.units[0].pos).toEqual(dest);
    expect(activeUnit(s)?.id).not.toBe(0);
    expect(client.calls).toHaveLength(1);
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
    const res = await runUnitTurn(deps(s, client), 0, { 0: 'x' }, []);
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
    await runUnitTurn(deps(s, client), 0, { 0: 'x' }, []);
  });

  it('fails clearly when the model never ends its turn', async () => {
    const s = match();
    const client = fakeClient(Array(6).fill(() => ({ content: [toolUse('x', 'check_position', { q: 0, r: 0 })] })));
    await expect(runUnitTurn(deps(s, client), 0, { 0: 'x' }, [])).rejects.toThrow(AgentError);
  });

  it('turns API errors into a readable AgentError', async () => {
    const s = match();
    const client = fakeClient([() => new Anthropic.RateLimitError(429, undefined, 'slow down', new Headers())]);
    await expect(runUnitTurn(deps(s, client), 0, { 0: 'x' }, [])).rejects.toThrow(/Rate limited/);
  });

  it('treats a refusal as a failure, not a turn', async () => {
    const s = match();
    const client = fakeClient([() => ({ stop_reason: 'refusal', content: [] })]);
    await expect(runUnitTurn(deps(s, client), 0, { 0: 'x' }, [])).rejects.toThrow(/declined/);
  });
});
