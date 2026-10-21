import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createMatch, newConfig, RULES_VERSION } from '../src/core/engine';
import { getMap } from '../src/core/map';
import { decodeReplay, replay } from '../src/core/replay';

describe('older rules versions still replay', () => {
  it('replays a real v2 orders-mode game (old maps, old tie-break) to its recorded result', () => {
    const r = decodeReplay(readFileSync(new URL('./fixtures/v2-hollow-orders.replay.txt', import.meta.url), 'utf8'));
    expect(r.config.rulesVersion).toBe(2);
    const s = replay(r);
    expect(r.actions).toHaveLength(148);
    expect(s.score).toEqual([10, 7]);
    expect(s.winner).toBe(0);
    expect(s.tieTeam).toBeUndefined();
  });

  it('keeps the v2 layout for v2 and adds rock for current matches', () => {
    const rocks = (v: number) => getMap('hollow', v).def.tiles.filter((t) => t.terrain === 'blocked').length;
    expect(rocks(2)).toBe(3);
    expect(rocks(RULES_VERSION)).toBe(11);
  });
});

describe('speed ties (rules v3)', () => {
  it('alternate between teams, starting from a seeded coin flip', () => {
    const firsts = new Set<number>();
    for (const seed of ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']) {
      // Mirror teams: every unit ties with its counterpart, so turn order exposes the tie rule.
      const s = createMatch(newConfig(seed, [['rhino', 'moth', 'eel'], ['rhino', 'moth', 'eel']], 'hollow'));
      firsts.add(s.units[s.turn!.unit].team);
      expect(s.tieTeam).toBeDefined();
    }
    expect([...firsts].sort()).toEqual([0, 1]); // across seeds, either side can get the first tie
  });
});
