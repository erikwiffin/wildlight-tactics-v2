import { describe, expect, it } from 'vitest';
import { nextAiAction } from '../src/core/ai';
import { applyAction, createMatch, newConfig } from '../src/core/engine';
import { directionTo, hexesInRadius } from '../src/core/hex';
import { flipAction, flipState } from '../src/core/perspective';
import { stateHash } from '../src/core/replay';
import type { GameState } from '../src/core/types';

describe('mirror symmetry', () => {
  it('direction ties resolve as mirror images (rules v3)', () => {
    const o = { q: 0, r: 0 };
    for (const h of hexesInRadius(o, 6)) {
      if (h.q === 0 && h.r === 0) continue;
      const d = directionTo(o, h);
      const m = directionTo(o, { q: -h.q, r: -h.r });
      expect(m, `(${h.q},${h.r})`).toBe((d + 3) % 6);
    }
  });

  function midGame(seed: string, mapId: string, team: string[]): GameState {
    const s = createMatch(newConfig(seed, [team, team], mapId));
    for (let i = 0; i < 40 && s.winner === null; i++) applyAction(s, nextAiAction(s));
    return s;
  }

  it('flipping twice gives back the same state', () => {
    const s = midGame('flip', 'arena', ['rhino', 'fox', 'moth', 'eel']);
    expect(stateHash(flipState(flipState(s)))).toBe(stateHash(s));
  });

  it("the AI's choice for one side is the mirror of its choice for the other", () => {
    for (const [mapId, team] of [['arena', ['rhino', 'fox', 'moth', 'eel']], ['caldera', ['lynx', 'octopus', 'eel', 'porcupine']], ['hollow', ['moth', 'rhino', 'eel']]] as const) {
      const s = midGame(`sym-${mapId}`, mapId, [...team]);
      const a = nextAiAction(s);
      expect(nextAiAction(flipState(s)), mapId).toEqual(flipAction(a));
    }
  });
});

describe('whole games are mirror-symmetric', () => {
  it('a game and its mirror image play out as exact mirror images', () => {
    for (const [mapId, team] of [['fault', ['rhino', 'fox', 'moth', 'eel', 'octopus']], ['arena', ['porcupine', 'lynx', 'eel', 'moth']], ['caldera', ['rhino', 'octopus', 'fox', 'eel']], ['hollow', ['moth', 'rhino', 'eel']]] as const) {
      const a = createMatch(newConfig(`mirror-${mapId}`, [[...team], [...team]], mapId));
      const b = flipState(a);
      for (let i = 0; i < 400 && a.winner === null; i++) {
        const act = nextAiAction(a);
        expect(nextAiAction(b), `${mapId} action ${i}`).toEqual(flipAction(act));
        applyAction(a, act);
        applyAction(b, flipAction(act));
      }
      // Hazard lists hold the same spikes in a different order; compare as sets.
      const norm = (s: GameState) => ({ ...s, hazards: [...s.hazards].sort((x, y) => x.pos.q - y.pos.q || x.pos.r - y.pos.r) });
      expect(stateHash(norm(flipState(b))), mapId).toBe(stateHash(norm(a)));
    }
  }, 120_000);
});
