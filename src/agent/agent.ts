// One unit's turn, played by Claude Haiku from the player's standing orders.
//
// The loop runs in the browser against the live game; API calls go through
// the dev-server proxy (server/anthropic-proxy.ts), which holds the key.
// The tools only expose what the player could see or do: the briefing and
// previews in context.ts, the same legal actions the tap UI offers, and a
// "check a hex" tool equivalent to moving and pressing Undo.

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

export async function agentAvailable(): Promise<{ ok: boolean; reason?: string }> {
  try {
    const r = await fetch('./api/agent/health');
    if (!r.ok) return { ok: false, reason: r.status === 403 ? 'The agent proxy only serves the computer running the dev server.' : 'No agent proxy here. Run `npm run dev` locally.' };
    const j = (await r.json()) as { ok: boolean; reason?: string };
    return j;
  } catch {
    return { ok: false, reason: 'No agent proxy here. Run `npm run dev` locally.' };
  }
}

export class AgentError extends Error {}

export const SYSTEM_PROMPT = `You are the on-board intelligence of one nanite-infected animal in Wildlight Tactics, a turn-based tactics game on a hex grid. Your commander (the player) gives each animal a standing order in plain language. You take this unit's turn by calling tools.

How a turn works
- You may move once and use one ability once, in either order, then you must call end_turn exactly once. Moving and acting are both optional.
- Each tool result tells you what happened. Your turn ends the moment you call end_turn.
- Doing less makes your next turn come sooner: a turn with no move and no action costs the least time.

Rules
- Coordinates are axial hex (q,r). Distances are in hexes. "h" is tile height (0-3).
- Beacons: end your turn standing on one with no enemy adjacent to capture it. Each Pulse gives 1 point per Beacon held. First to the target score wins; a team that loses every unit loses. Knockouts are permanent.
- Facing: units face E, NE, NW, W, SW or SE. Attacks from the flank do +25% damage and +15% hit chance; from directly behind, +50% damage and they always hit. End your turn facing the biggest threat.
- Height: +10% damage per level above the target. Ranged attacks gain +1 range from 2+ levels up.
- Abilities marked "needs line of sight" are blocked by rock, high walls and any unit in the way, allies included.
- Enemy spike fields hurt and stop you when you enter them.
- Hit chances are real odds; you only learn the result after acting.

Following orders
- Your own order comes first. Read your teammates' orders and support their plans: if the tank is ordered to hold a Beacon and you are ordered to protect the tank, stay near the tank and heal or defend it.
- Orders persist across turns. Apply them sensibly to the current situation; if an order can't be carried out this turn, do the most useful thing that serves it.
- Use only the briefing and tool results; never invent positions or numbers. check_position shows what you could do from a reachable hex without committing.
- Be quick. Usually call move and/or use_ability, then end_turn, in a single reply; tools run in the order you call them.

end_turn's report is shown to your commander: one short first-person sentence (at most 20 words) saying what you did and how it serves your order.`;

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
  client: AgentClient;
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
}

type ToolOutcome = { text: string; error?: boolean; ended?: boolean };

/** Play one unit's turn. Throws AgentError when it can't finish; the turn may be partly done. */
export async function runUnitTurn(deps: TurnDeps, unitId: number, orders: Orders, recent: string[]): Promise<TurnResult> {
  const steps: string[] = [];
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

  const messages: Anthropic.MessageParam[] = [{ role: 'user', content: turnBriefing(deps.state(), unitId, orders, recent) }];
  let nudged = false;
  for (let call = 0; call < MAX_CALLS; call++) {
    let res: Anthropic.Message;
    try {
      res = await deps.client.messages.create(
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
      if (e instanceof Anthropic.AuthenticationError) throw new AgentError('The API key was rejected. Check ANTHROPIC_API_KEY in .env.local.');
      if (e instanceof Anthropic.RateLimitError) throw new AgentError('Rate limited by the API. Wait a moment, then retry.');
      if (e instanceof Anthropic.APIConnectionTimeoutError) throw new AgentError('The model took too long to answer.');
      if (e instanceof Anthropic.APIError) throw new AgentError(`API error${e.status ? ' ' + e.status : ''}: ${e.message}`);
      throw new AgentError(`Could not reach the agent: ${(e as Error).message}`);
    }
    if (res.stop_reason === 'refusal') throw new AgentError('The model declined to play this turn.');
    if (res.stop_reason === 'max_tokens') throw new AgentError('The model ran out of room before finishing its turn.');
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
    for (const tu of uses) {
      if (ended) {
        results.push({ type: 'tool_result', tool_use_id: tu.id, content: 'Skipped: your turn already ended.', is_error: true });
        continue;
      }
      const out = await exec(tu.name, (tu.input ?? {}) as Record<string, unknown>);
      results.push({ type: 'tool_result', tool_use_id: tu.id, content: out.text, ...(out.error ? { is_error: true } : {}) });
      if (out.ended) ended = true;
    }
    if (ended || !myTurn()) return { report: report || steps[steps.length - 1] || 'Done.', steps };
    messages.push({ role: 'user', content: results });
  }
  if (!myTurn()) return { report: report || 'Done.', steps };
  throw new AgentError(`The agent did not finish its turn (no end_turn after ${MAX_CALLS} calls).`);
}

