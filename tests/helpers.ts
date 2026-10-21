import { nextAiAction } from '../src/core/ai';
import { applyAction, createMatch, newConfig } from '../src/core/engine';
import type { Replay } from '../src/core/replay';
import type { Action, GameState } from '../src/core/types';

/** Play a full AI-vs-AI match and return the final state plus its log. */
export function selfPlay(seed: string, teams: [string[], string[]], maxActions = 4000): { state: GameState; replay: Replay } {
  const config = newConfig(seed, teams);
  const state = createMatch(config);
  const actions: Action[] = [];
  while (state.winner === null && actions.length < maxActions) {
    const a = nextAiAction(state);
    applyAction(state, a);
    actions.push(a);
  }
  return { state, replay: { config, actions } };
}
