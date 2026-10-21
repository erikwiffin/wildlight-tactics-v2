import { describe, expect, it } from 'vitest';
import { MONSTERS } from '../src/core/monsters';
import { VFX_ABILITIES, VFX_CHARGES } from '../src/render/vfx';

describe('ability effects', () => {
  const abilities = MONSTERS.flatMap((m) => m.abilities);
  it('every ability has its own effect, and no effect is orphaned', () => {
    expect([...VFX_ABILITIES].sort()).toEqual(abilities.map((a) => a.id).sort());
  });
  it('ability ids are unique across the roster (effects look them up by id)', () => {
    expect(new Set(abilities.map((a) => a.id)).size).toBe(abilities.length);
  });
  it('every charged ability also has a charge-up effect', () => {
    expect([...VFX_CHARGES].sort()).toEqual(abilities.filter((a) => a.chargeSpeed).map((a) => a.id).sort());
  });
});
