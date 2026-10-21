import { nextAiAction } from './ai';
import { applyAction, createMatch } from './engine';
import type { Action, GameState, MatchConfig, StrategyId } from './types';

export const MAX_SIM_ACTIONS = 8000;

export function strategiesOf(config: MatchConfig): [StrategyId, StrategyId] {
  const [a, b] = config.ai ?? [null, null];
  return [a ?? 'balanced', b ?? 'balanced'];
}

/** Play the next AI action on `state` (mutates). */
export function stepAi(state: GameState, strategies: [StrategyId, StrategyId]): Action {
  const a = nextAiAction(state, strategies[state.units[state.turn!.unit].team]);
  applyAction(state, a);
  return a;
}

/** Synchronously play a whole AI-vs-AI match, reporting actions in batches. */
export function runSimulation(config: MatchConfig, emit: (actions: Action[]) => void): void {
  const strategies = strategiesOf(config);
  const state = createMatch(config);
  let batch: Action[] = [];
  for (let n = 0; state.winner === null && n < MAX_SIM_ACTIONS; n++) {
    batch.push(stepAi(state, strategies));
    if (batch.length >= 6) {
      emit(batch);
      batch = [];
    }
  }
  emit(batch);
}
