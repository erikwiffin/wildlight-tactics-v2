import { describe, expect, it } from 'vitest';
import { DIRS, hexAdd, hexKey } from '../src/core/hex';
import { MAPS } from '../src/core/map';

const map = MAPS.arena;
const tiles = new Map(map.tiles.map((t) => [hexKey(t), t]));

describe('arena', () => {
  it('is point-symmetric', () => {
    for (const t of map.tiles) {
      const m = tiles.get(hexKey({ q: -t.q, r: -t.r }))!;
      expect([m.h, m.terrain]).toEqual([t.h, t.terrain]);
    }
  });

  it('keeps spawns and beacons on open ground', () => {
    for (const h of [...map.beacons, ...map.spawns[0], ...map.spawns[1]]) {
      expect(tiles.get(hexKey(h))?.terrain).toBe('normal');
    }
  });

  it('lets a jump-1 unit reach every open tile', () => {
    const start = map.spawns[0][0];
    const seen = new Set([hexKey(start)]);
    const queue = [start];
    while (queue.length) {
      const cur = queue.shift()!;
      const ch = tiles.get(hexKey(cur))!.h;
      for (const d of DIRS) {
        const n = hexAdd(cur, d);
        const t = tiles.get(hexKey(n));
        if (!t || t.terrain === 'blocked' || seen.has(hexKey(n)) || Math.abs(t.h - ch) > 1) continue;
        seen.add(hexKey(n));
        queue.push(n);
      }
    }
    const open = map.tiles.filter((t) => t.terrain !== 'blocked');
    expect(open.filter((t) => !seen.has(hexKey(t)))).toEqual([]);
  });
});
