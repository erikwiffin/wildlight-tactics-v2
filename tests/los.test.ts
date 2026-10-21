import { describe, expect, it } from 'vitest';
import { abilityArea, abilityTargets, createMatch, hasLineOfSight, newConfig } from '../src/core/engine';
import { hexKey } from '../src/core/hex';
import { getAbility } from '../src/core/monsters';
import type { GameState, Unit } from '../src/core/types';

// Glass Hollow has rock at (0,0) and (1,1) / (-1,-1).
function setup(): { s: GameState; eel: Unit; moth: Unit; foe: Unit; other: Unit } {
  const s = createMatch(newConfig('los', [['eel', 'moth', 'rhino'], ['rhino', 'fox', 'lynx']], 'hollow'));
  const eel = s.units.find((u) => u.team === 0 && u.defId === 'eel')!;
  const moth = s.units.find((u) => u.team === 0 && u.defId === 'moth')!;
  const foe = s.units.find((u) => u.team === 1 && u.defId === 'rhino')!;
  const other = s.units.find((u) => u.team === 1 && u.defId === 'fox')!;
  s.turn = { unit: eel.id, moved: false, acted: false };
  return { s, eel, moth, foe, other };
}
const keys = (hs: { q: number; r: number }[]) => hs.map(hexKey);

describe('line of sight', () => {
  it('is blocked by rock', () => {
    const { s, eel, foe } = setup();
    eel.pos = { q: -2, r: 0 };
    foe.pos = { q: 2, r: 0 }; // straight through the (0,0) rock
    const blocked: { q: number; r: number }[] = [];
    expect(keys(abilityTargets(s, eel, 'zap', blocked))).not.toContain('2,0');
    expect(keys(blocked)).toContain('2,0');
  });

  it('is blocked by units of either team, and clears when they move', () => {
    const { s, eel, moth, foe } = setup();
    eel.pos = { q: -3, r: 3 };
    foe.pos = { q: -3, r: 0 };
    expect(hasLineOfSight(s, eel.pos, foe.pos)).toBe(true);
    moth.pos = { q: -3, r: 2 }; // ally in the way
    expect(hasLineOfSight(s, eel.pos, foe.pos)).toBe(false);
    expect(keys(abilityTargets(s, eel, 'zap'))).not.toContain('-3,0');
    moth.pos = { q: 4, r: -4 };
    expect(keys(abilityTargets(s, eel, 'zap'))).toContain('-3,0');
  });

  it('lets arcing abilities and heals ignore it', () => {
    const { s, eel, moth, foe } = setup();
    eel.pos = { q: -2, r: 0 };
    foe.pos = { q: 2, r: 0 };
    expect(keys(abilityTargets(s, eel, 'storm'))).toContain('2,0'); // arcs over the rock
    moth.pos = { q: 1, r: 0 };
    s.turn = { unit: moth.id, moved: false, acted: false };
    eel.pos = { q: -1, r: 0 };
    expect(hasLineOfSight(s, moth.pos, eel.pos)).toBe(false);
    expect(keys(abilityTargets(s, moth, 'mend'))).toContain('-1,0');
  });

  it('is clear when either side of an edge-aligned line is clear', () => {
    const { s, moth, foe } = setup();
    // (-3,2) -> (-2,3) runs exactly along the edge between (-2,2) and (-3,3).
    const a = { q: -3, r: 2 }, b = { q: -2, r: 3 };
    moth.pos = { q: -2, r: 2 };
    expect(hasLineOfSight(s, a, b)).toBe(true); // one side still open
    foe.pos = { q: -3, r: 3 };
    expect(hasLineOfSight(s, a, b)).toBe(false); // both sides blocked
  });

  it('stops Arc Lance at rock but pierces units', () => {
    const { s, eel } = setup();
    eel.pos = { q: -3, r: 0 };
    const lance = getAbility('eel', 'lance');
    const area = keys(abilityArea(s, lance, eel.pos, { q: -2, r: 0 }));
    expect(area).toEqual(['-2,0', '-1,0']); // (0,0) is rock
  });
});
