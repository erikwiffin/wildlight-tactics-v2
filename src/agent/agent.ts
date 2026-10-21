// One unit's turn, played by Claude Haiku from the player's standing orders.
//
// The turn runs in the browser against the live game, on one of two backends:
// - the dev/preview-server proxy (server/anthropic-proxy.ts), which holds the
//   API key, via the Anthropic SDK and a manual tool-use loop; or
// - on claude.ai, the published artifact's `sample` capability, which calls
//   Claude on the viewer's own account with the same tools run in the page.
// Either way the tools only expose what the player could see or do: the
// briefing and previews in context.ts, the same legal actions the tap UI
// offers, and a "check a hex" tool equivalent to moving and pressing Undo.

import Anthropic from '@anthropic-ai/sdk';
import { abilityTargets, applyAction } from '../core/engine';
import { hexEq } from '../core/hex';
import { getAbility, MONSTER_BY_ID } from '../core/monsters';
import type { Action, GameEvent, GameState } from '../core/types';
import { DIR_NAMES, describeAbilities, describeFrom, describeMoves, dirFromName, hx, summarizeEvents, turnBriefing, type Orders } from './context';

export const AGENT_MODEL = 'claude-haiku-5-5';
const MAX_CALLS = 6;
const MAX_CHECKS = 3;

/** The slice of the SDK client the agent uses (lets tests pass a fake). */
export interface AgentClient {
  messages: {
    create(body: Anthropic.MessageCreateParamsNonStreaming, options?: { signal?: AbortSignal }): PromiseLike<Anthropic.Message>;
  };
}

export function browserClient(): AgentClient {
  // The key is added by the proxy; the page never holds it.
  return new Anthropic({
    baseURL: `${location.origin}/api/agent`,
    apiKey: 'added-by-dev-proxy',
    dangerouslyAllowBrowser: true,
    timeout: 30_000,
    maxRetries: 1,
  });
}

/** The parts of the artifact runtime's `sample` capability the agent uses. */
export interface SampleFn {
  (
    input: string,
    options: {
      tools: { name: string; description: string; inputSchema?: object; execute(input: Record<string, unknown>): unknown }[];
      model?: string;
      modelTier?: 'quick' | 'default' | 'complex';
      effort?: 'low' | 'medium' | 'high';
      signal?: AbortSignal;
    },
  ): Promise<{ text: string; truncated: boolean; modelTierApplied: string; modelApplied?: string }>;
  limits(): Promise<{ tools?: { maxCount: number } }>;
}

export type AgentBackend = { runner: TurnRunner; via: string } | { runner: null; reason: string };

let backend: Promise<AgentBackend> | null = null;

/**
 * Find a way to reach Claude: the local dev proxy first, then (inside a
 * claude.ai artifact viewer) the `sample` capability. Memoized.
 */
export function resolveAgent(): Promise<AgentBackend> {
  return (backend ??= (async (): Promise<AgentBackend> => {
    let reason = 'Orders mode needs the game open on claude.ai, or `npm run dev` with an API key in .env.local.';
    try {
      const r = await fetch('./api/agent/health');
      if (r.ok) {
        const j = (await r.json()) as { ok: boolean; reason?: string };
        if (j.ok) return { runner: apiRunner(browserClient()), via: 'the local dev server' };
        if (j.reason) reason = j.reason;
      } else if (r.status === 403) {
        reason = 'The agent proxy only serves the computer running the dev server.';
      }
    } catch {
      // No proxy here (static hosting, or the artifact sandbox).
    }
    const claude = (window as unknown as { claude?: { use(name: string): Promise<unknown> } }).claude;
    if (claude?.use) {
      const sample = (await claude.use('sample').catch(() => null)) as SampleFn | null;
      if (sample) {
        const limits = await sample.limits().catch(() => null);
        if (limits?.tools) return { runner: sampleRunner(sample), via: 'your Claude account' };
        reason = 'This Claude app can’t run game tools for Claude. Try claude.ai in a browser.';
      }
    }
    return { runner: null, reason };
  })());
}

export class AgentError extends Error {
  /** Tool calls made before the failure, for the match log. */
  trace: ToolCallRecord[] = [];
}

/** One tool call as recorded in the match log. */
export interface ToolCallRecord {
  tool: string;
  input: Record<string, unknown>;
  result: string;
  error?: boolean;
}

export const SYSTEM_PROMPT = `You are the on-board intelligence of one nanite-infected animal in Wildlight Tactics, a turn-based tactics game on a hex grid. Your commander (the player) gives each animal a standing order in plain language. You take this unit's turn by calling tools.

How a turn works
- You may move once and use one ability once, in either order, then you must call end_turn exactly once. Moving and acting are both optional.
- Each tool result tells you what happened. Your turn ends the moment you call end_turn.
- Turn timing: a turn with no move and no action comes back around a little sooner.

Rules
- Coordinates are axial hex (q,r). Distances are in hexes. "h" is tile height (0-3).
- Beacons: you capture one only by ENDING your turn standing ON its hex with no enemy adjacent; pushing an enemy off is not enough. Each Pulse gives 1 point per Beacon held. First to the target score wins; a team that loses every unit loses. Knockouts are permanent.
- Facing: units face E, NE, NW, W, SW or SE. Attacks from the flank do +25% damage and +15% hit chance; from directly behind, +50% damage and they always hit. End your turn facing the biggest threat.
- Height: +10% damage per level above the target. Ranged attacks gain +1 range from 2+ levels up.
- Abilities marked "needs line of sight" are blocked by rock, high walls and any unit in the way, allies included.
- Enemy spike fields hurt and stop you when you enter them.
- Charged abilities land later on a fixed area. Never end your turn inside an enemy blast that lands before your next turn (marked "in incoming blast!"); step out of it.
- Hit chances are real odds; you only learn the result after acting.

Following orders
- Beacons win the match. Read every order in that light: "protect the healer" means protect it while the team fights for Beacons, not hide at the spawn. If the enemy holds more Beacons than we do, standing still is losing unless your order clearly says to hold where you are.
- Orders name Beacons the way the briefing does: center, home, enemy home, left flank, right flank. If an order names a Beacon this map doesn't have, act on the closest match (usually the nearest Beacon that is neutral or theirs) and name the one you chose in your report.
- Your own order comes first. Read your teammates' orders and support their plans: if the tank is ordered to hold a Beacon and you are ordered to protect the tank, stay near the tank and heal or defend it.
- Orders persist across turns. Apply them sensibly to the current situation; if an order can't be carried out this turn, do the most useful thing that serves it.
- Use only the briefing and tool results; never invent positions or numbers. check_position shows what you could do from a reachable hex without committing.
- Be quick. Usually call move and/or use_ability, then end_turn, in a single reply. Tools run one at a time in the order you call them. If one fails, the rest of that reply is skipped: read the error and call again.
- Self abilities (range "self") target your own hex: after moving, that is the hex you moved to.

end_turn's report is shown to your commander: one short first-person sentence (at most 20 words) saying what you actually did this turn and how it serves your order. Never claim a move or capture that didn't happen.`;

const coord = { type: 'integer' as const };

export const AGENT_TOOLS: Anthropic.Tool[] = [
  {
    name: 'check_position',
    description:
      'Preview a reachable hex without moving: what each ability could hit from there (hit %, damage, arc) and which enemies could reach you there. Same as your commander moving there, looking, and pressing Undo. At most 3 per turn.',
    input_schema: { type: 'object', properties: { q: coord, r: coord }, required: ['q', 'r'], additionalProperties: false },
    strict: true,
  },
  {
    name: 'move',
    description: 'Move to a reachable hex listed under Moves. Once per turn; cannot be undone. Returns your abilities from the new hex.',
    input_schema: { type: 'object', properties: { q: coord, r: coord }, required: ['q', 'r'], additionalProperties: false },
    strict: true,
  },
  {
    name: 'use_ability',
    description: 'Use one of your abilities on a target hex. Once per turn. Self abilities target your own hex. Returns what happened (hits, misses, damage, knockouts).',
    input_schema: {
      type: 'object',
      properties: { ability: { type: 'string', description: 'Ability id from your list, e.g. "gore".' }, q: coord, r: coord },
      required: ['ability', 'q', 'r'],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    name: 'end_turn',
    description: 'End your turn and choose your facing. Call exactly once, last.',
    input_schema: {
      type: 'object',
      properties: {
        facing: { type: 'string', enum: [...DIR_NAMES] },
        report: { type: 'string', description: 'One short first-person sentence for your commander.' },
      },
      required: ['facing', 'report'],
      additionalProperties: false,
    },
    strict: true,
  },
];

export interface TurnDeps {
  state: () => GameState;
  /** Apply an action through the game screen (animates) and return its events. */
  commit: (a: Action) => Promise<GameEvent[]>;
  /** Live progress for the feed. */
  onStep?: (text: string) => void;
  signal?: AbortSignal;
}

export interface TurnResult {
  report: string;
  steps: string[];
  /** Something the player should know about how the turn was played (e.g. a model substitution). */
  note?: string;
  /** Every tool call this turn, for the match log. */
  trace: ToolCallRecord[];
  /** What the unit actually did, from the game, not from Claude: "moved to (q,r), used X" or "stayed at (q,r), no action". */
  facts: string;
  /** The model that played, when known. */
  model?: string;
}

/** Play one unit's turn. Throws AgentError when it can't finish; the turn may be partly done. */
export type TurnRunner = (deps: TurnDeps, unitId: number, orders: Orders, recent: string[]) => Promise<TurnResult>;

type ToolOutcome = { text: string; error?: boolean; ended?: boolean };

/** The four tools, bound to one unit's turn. Shared by both backends. */
function turnTools(deps: TurnDeps, unitId: number) {
  const steps: string[] = [];
  const trace: ToolCallRecord[] = [];
  const startPos = { ...deps.state().units[unitId].pos };
  let movedTo: { q: number; r: number } | null = null;
  let usedAbility: string | null = null;
  const facts = () =>
    `${movedTo ? `moved to ${hx(movedTo)}` : `stayed at ${hx(startPos)}`}, ${usedAbility ? `used ${usedAbility}` : 'no action'}`;
  let checks = 0;
  let report = '';
  const myTurn = () => {
    const s = deps.state();
    return s.winner === null && s.turn?.unit === unitId;
  };

  const exec = async (name: string, input: Record<string, unknown>): Promise<ToolOutcome> => {
    if (!myTurn()) return { text: 'Your turn is already over.', ended: true };
    const state = deps.state();
    const u = state.units[unitId];
    const q = Number(input.q), r = Number(input.r);
    switch (name) {
      case 'check_position': {
        if (state.turn!.moved) return { text: 'You already moved this turn.', error: true };
        if (++checks > MAX_CHECKS) return { text: 'Check limit reached for this turn. Decide and act.', error: true };
        try {
          return { text: describeFrom(state, u, { q, r }) };
        } catch {
          return { text: `(${q},${r}) is not a hex you can move to. Moves: ${describeMoves(state, u)}`, error: true };
        }
      }
      case 'move': {
        const action: Action = { type: 'move', unit: unitId, to: { q, r } };
        try {
          applyAction(structuredClone(state), action); // validate without side effects
        } catch (e) {
          return { text: `Can't move to (${q},${r}): ${(e as Error).message}. Moves: ${describeMoves(state, u)}`, error: true };
        }
        const events = await deps.commit(action);
        movedTo = { q, r };
        const done = summarizeEvents(deps.state(), events);
        steps.push(...done);
        done.forEach((d) => deps.onStep?.(d));
        if (!myTurn()) return { text: `${done.join('. ')}. Your turn is over.`, ended: true };
        const s2 = deps.state();
        return { text: `${done.join('. ')}.\nAbilities from ${hx(s2.units[unitId].pos)}:\n${describeAbilities(s2, s2.units[unitId])}` };
      }
      case 'use_ability': {
        const id = String(input.ability);
        const def = MONSTER_BY_ID[u.defId];
        if (!def.abilities.some((a) => a.id === id)) {
          return { text: `Unknown ability "${id}". Yours: ${def.abilities.map((a) => a.id).join(', ')}.`, error: true };
        }
        const action: Action = { type: 'ability', unit: unitId, ability: id, target: { q, r } };
        // Legality via the same target query the tap UI highlights; nothing is resolved early.
        if (state.turn!.acted) return { text: 'You already used an ability this turn.', error: true };
        const blocked: { q: number; r: number }[] = [];
        if (!abilityTargets(state, u, id, blocked).some((h) => hexEq(h, { q, r }))) {
          const why = (u.cooldowns[id] ?? 0) > 0 ? 'it is on cooldown' : blocked.some((h) => hexEq(h, { q, r })) ? 'no line of sight' : 'not a legal target';
          return { text: `Can't use ${getAbility(u.defId, id).name} on (${q},${r}): ${why}.\n${describeAbilities(state, u)}`, error: true };
        }
        const events = await deps.commit(action);
        usedAbility = getAbility(u.defId, id).name;
        const done = summarizeEvents(deps.state(), events);
        steps.push(...done);
        done.forEach((d) => deps.onStep?.(d));
        return myTurn() ? { text: done.join('. ') + '.' } : { text: `${done.join('. ')}. Your turn is over.`, ended: true };
      }
      case 'end_turn': {
        const facing = dirFromName(String(input.facing));
        if (facing === null) return { text: `facing must be one of ${DIR_NAMES.join(', ')}.`, error: true };
        report = String(input.report ?? '').trim();
        await deps.commit({ type: 'end', unit: unitId, facing });
        return { text: 'Turn ended.', ended: true };
      }
      default:
        return { text: `Unknown tool ${name}.`, error: true };
    }
  };

  // Claude can call several tools in one reply, and claude.ai runs a reply's
  // calls concurrently. Game actions must happen in the order Claude wrote
  // them, so calls queue here and run one at a time. If an action fails, the
  // calls already issued in that reply (planned assuming it worked) are
  // skipped, and Claude re-plans from the error on its next round.
  let queue: Promise<unknown> = Promise.resolve();
  let issued = 0;
  let skipBefore = 0;
  const record = (name: string, input: Record<string, unknown>, out: ToolOutcome) =>
    trace.push({ tool: name, input, result: out.text.length > 500 ? out.text.slice(0, 500) + '…' : out.text, ...(out.error ? { error: true } : {}) });
  const recorded = (name: string, input: Record<string, unknown>): Promise<ToolOutcome> => {
    const seq = issued++;
    const run = queue.then(async (): Promise<ToolOutcome> => {
      let out: ToolOutcome;
      if (seq < skipBefore) {
        out = { text: 'Skipped: an earlier call in the same reply failed, so this one was not run. Re-plan from that error.', error: true };
      } else {
        try {
          out = await exec(name, input);
        } catch (e) {
          out = { text: `Error: ${(e as Error).message}`, error: true };
        }
        if (out.error && name !== 'check_position') skipBefore = issued;
      }
      record(name, input, out);
      return out;
    });
    queue = run;
    return run;
  };
  /** Mark the end of a reply (sequential callers): later calls belong to a new round. */
  const newRound = () => {
    skipBefore = 0;
  };
  const fail = (msg: string): AgentError => {
    const e = new AgentError(msg);
    e.trace = trace;
    return e;
  };

  return {
    exec: recorded,
    newRound,
    fail,
    myTurn,
    steps,
    ended: () => !myTurn(),
    result: (): TurnResult => ({ report: report || steps[steps.length - 1] || 'Done.', steps, trace, facts: facts() }),
  };
}

/** Backend 1: the Anthropic SDK through the dev proxy, with a manual loop that stops at end_turn. */
export function apiRunner(client: AgentClient): TurnRunner {
  return async (deps, unitId, orders, recent) => {
  const { exec, newRound, myTurn, result, fail } = turnTools(deps, unitId);
  const done = (): TurnResult => ({ ...result(), model: AGENT_MODEL });
  const messages: Anthropic.MessageParam[] = [{ role: 'user', content: turnBriefing(deps.state(), unitId, orders, recent) }];
  let nudged = false;
  for (let call = 0; call < MAX_CALLS; call++) {
    let res: Anthropic.Message;
    try {
      res = await client.messages.create(
        {
          model: AGENT_MODEL,
          max_tokens: 4000,
          output_config: { effort: 'low' },
          system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
          tools: AGENT_TOOLS,
          tool_choice: { type: 'auto' },
          messages,
        },
        { signal: deps.signal },
      );
    } catch (e) {
      if (e instanceof Anthropic.APIUserAbortError) throw e;
      if (e instanceof Anthropic.AuthenticationError) throw fail('The API key was rejected. Check ANTHROPIC_API_KEY in .env.local.');
      if (e instanceof Anthropic.RateLimitError) throw fail('Rate limited by the API. Wait a moment, then retry.');
      if (e instanceof Anthropic.APIConnectionTimeoutError) throw fail('The model took too long to answer.');
      if (e instanceof Anthropic.APIError) throw fail(`API error${e.status ? ' ' + e.status : ''}: ${e.message}`);
      throw fail(`Could not reach the agent: ${(e as Error).message}`);
    }
    if (res.stop_reason === 'refusal') throw fail('The model declined to play this turn.');
    if (res.stop_reason === 'max_tokens') throw fail('The model ran out of room before finishing its turn.');
    messages.push({ role: 'assistant', content: res.content });

    const uses = res.content.filter((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use');
    if (!uses.length) {
      if (nudged || !myTurn()) break;
      nudged = true;
      messages.push({ role: 'user', content: 'Act through the tools now, and finish with end_turn.' });
      continue;
    }
    const results: Anthropic.ToolResultBlockParam[] = [];
    let ended = false;
    let failed = false;
    newRound();
    for (const tu of uses) {
      if (ended || failed) {
        const why = ended ? 'your turn already ended.' : 'an earlier call in this reply failed, so this one was not run. Re-plan from that error.';
        results.push({ type: 'tool_result', tool_use_id: tu.id, content: `Skipped: ${why}`, is_error: true });
        continue;
      }
      const out = await exec(tu.name, (tu.input ?? {}) as Record<string, unknown>);
      if (out.error && tu.name !== 'check_position') failed = true;
      results.push({ type: 'tool_result', tool_use_id: tu.id, content: out.text, ...(out.error ? { is_error: true } : {}) });
      if (out.ended) ended = true;
    }
    if (ended || !myTurn()) return done();
    messages.push({ role: 'user', content: results });
  }
  if (!myTurn()) return done();
  throw fail(`The agent did not finish its turn (no end_turn after ${MAX_CALLS} calls).`);
  };
}

const SAMPLE_ERRORS: Record<string, string> = {
  not_granted: 'Claude isn’t allowed for this game. Allow it from the artifact’s Permissions menu, then press Retry.',
  sampling_disabled: 'Claude isn’t available for this account.',
  rate_limited: 'Claude usage limit or rate limit reached. Wait a bit, then press Retry.',
  session_expired: 'Your claude.ai session expired. Sign in again, then press Retry.',
  refused: 'Claude declined to play this turn.',
  empty_completion: 'Claude returned nothing for this turn.',
  tools_unavailable: 'This Claude app can’t run game tools. Try claude.ai in a browser.',
  prompt_too_large: 'The turn briefing was too large.',
};

/**
 * Backend 2: the claude.ai artifact's `sample` capability, on the viewer's
 * own account. The platform runs the tool rounds; our tools execute here.
 * The call is left to finish after end_turn (one short wrap-up round) so its
 * result can confirm which model actually played; any tool call after the
 * turn ended is answered "Your turn is already over." and changes nothing.
 */
export function sampleRunner(sample: SampleFn): TurnRunner {
  return async (deps, unitId, orders, recent) => {
    const t = turnTools(deps, unitId);
    const ctl = new AbortController();
    const onOuterAbort = () => ctl.abort();
    deps.signal?.addEventListener('abort', onOuterAbort);
    const tools = AGENT_TOOLS.map((def) => ({
      name: def.name,
      description: def.description ?? def.name,
      inputSchema: def.input_schema,
      execute: async (input: Record<string, unknown>) => {
        const out = await t.exec(def.name, input ?? {});
        if (out.error) throw new Error(out.text); // reaches Claude as "Error: ..."
        return out.text;
      },
    }));
    const prompt = `${SYSTEM_PROMPT}\n\n---\n\n${turnBriefing(deps.state(), unitId, orders, recent)}\n\nTake this unit's turn now with the tools, and finish with end_turn.`;
    let note: string | undefined;
    let model: string | undefined;
    try {
      const res = await sample(prompt, { tools, model: AGENT_MODEL, modelTier: 'quick', effort: 'low', signal: ctl.signal });
      model = res.modelApplied ?? `${res.modelTierApplied} tier`;
      if (res.modelApplied !== AGENT_MODEL) note = `Claude Haiku 5.5 wasn't available for this account, so Claude's ${res.modelTierApplied} tier played this turn.`;
    } catch (e) {
      const code = (e as { code?: string }).code;
      if (code === 'cancelled' && deps.signal?.aborted) throw t.fail('Stopped.');
      if (code !== 'cancelled' || !t.ended()) {
        if (t.ended()) return t.result(); // the turn finished; a late failure doesn't matter
        throw t.fail(SAMPLE_ERRORS[code ?? ''] ?? `Claude couldn't finish this turn (${code ?? 'unknown error'}).`);
      }
    } finally {
      deps.signal?.removeEventListener('abort', onOuterAbort);
    }
    if (!t.ended()) throw t.fail('Claude stopped without ending its turn.');
    return { ...t.result(), note, model };
  };
}

