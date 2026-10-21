import { applyAction, createMatch } from './engine';
import { hashString } from './rng';
import type { Action, GameState, MatchConfig } from './types';

export interface Replay {
  config: MatchConfig;
  actions: Action[];
}

/** Rebuild a match from its config and action log. */
export function replay(r: Replay, upTo = r.actions.length): GameState {
  const state = createMatch(r.config);
  for (let i = 0; i < upTo; i++) applyAction(state, r.actions[i]);
  return state;
}

/** Stable fingerprint of a state, for golden tests and desync checks. */
export function stateHash(state: GameState): string {
  return hashString(JSON.stringify(state)).toString(16).padStart(8, '0');
}

// Compact share code: the action log packed as short tuples, then base64.
type Packed = [MatchConfig, (string | number)[][]];

export function encodeReplay(r: Replay): string {
  const acts = r.actions.map((a) => {
    switch (a.type) {
      case 'move': return ['m', a.unit, a.to.q, a.to.r];
      case 'ability': return ['a', a.unit, a.ability, a.target.q, a.target.r];
      case 'end': return ['e', a.unit, a.facing];
    }
  });
  const json = JSON.stringify([r.config, acts] satisfies Packed);
  return btoa(unescape(encodeURIComponent(json)));
}

export function decodeReplay(code: string): Replay {
  const [config, acts] = JSON.parse(decodeURIComponent(escape(atob(code.trim())))) as Packed;
  const actions: Action[] = acts.map((t) => {
    const [kind, unit] = t as [string, number];
    if (kind === 'm') return { type: 'move', unit, to: { q: t[2] as number, r: t[3] as number } };
    if (kind === 'a') return { type: 'ability', unit, ability: t[2] as string, target: { q: t[3] as number, r: t[4] as number } };
    return { type: 'end', unit, facing: t[2] as 0 | 1 | 2 | 3 | 4 | 5 };
  });
  return { config, actions };
}
