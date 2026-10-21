import { nextAiAction } from '../src/core/ai';
import { applyAction, createMatch, newConfig } from '../src/core/engine';
import type { Replay } from '../src/core/replay';
import type { Action, GameState, StrategyId } from '../src/core/types';

/** Play a full AI-vs-AI match and return the final state plus its log. */
export function selfPlay(
  seed: string,
  teams: [string[], string[]],
  opts: { mapId?: string; strategies?: [StrategyId, StrategyId]; maxActions?: number } = {},
): { state: GameState; replay: Replay } {
  const strategies = opts.strategies ?? ['balanced', 'balanced'];
  const config = newConfig(seed, teams, opts.mapId ?? 'arena', strategies);
  const state = createMatch(config);
  const actions: Action[] = [];
  while (state.winner === null && actions.length < (opts.maxActions ?? 6000)) {
    const a = nextAiAction(state, strategies[state.units[state.turn!.unit].team]);
    applyAction(state, a);
    actions.push(a);
  }
  return { state, replay: { config, actions } };
}
