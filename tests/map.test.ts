import { describe, expect, it } from 'vitest';
import { DIRS, hexAdd, hexKey, type Hex } from '../src/core/hex';
import { MAP_LIST } from '../src/core/map';

describe.each(MAP_LIST.map((m) => [m.name, m] as const))('%s', (_name, map) => {
  const tiles = new Map(map.tiles.map((t) => [hexKey(t), t]));
  const open = (h: Hex) => {
    const t = tiles.get(hexKey(h));
    return !!t && t.terrain !== 'blocked' && t.terrain !== 'void';
  };

  it('is point-symmetric', () => {
    for (const t of map.tiles) {
      const m = tiles.get(hexKey({ q: -t.q, r: -t.r }));
      expect(m, `mirror of ${t.q},${t.r}`).toBeDefined();
      expect([m!.h, m!.terrain]).toEqual([t.h, t.terrain]);
    }
    const key = (hs: Hex[]) => hs.map((h) => hexKey({ q: -h.q, r: -h.r })).sort();
    expect(key(map.beacons)).toEqual(map.beacons.map(hexKey).sort());
    expect(key(map.spawns[0])).toEqual(map.spawns[1].map(hexKey).sort());
  });

  it('has a spawn per team slot, all distinct, on normal ground', () => {
    for (const team of map.spawns) expect(team).toHaveLength(map.teamSize);
    const all = [...map.spawns[0], ...map.spawns[1], ...map.beacons].map(hexKey);
    expect(new Set(all).size).toBe(all.length);
    for (const h of [...map.spawns[0], ...map.spawns[1], ...map.beacons]) {
      expect(tiles.get(hexKey(h))?.terrain, hexKey(h)).toBe('normal');
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
        if (!open(n) || seen.has(hexKey(n)) || Math.abs(tiles.get(hexKey(n))!.h - ch) > 1) continue;
        seen.add(hexKey(n));
        queue.push(n);
      }
    }
    const unreachable = map.tiles.filter((t) => open(t) && !seen.has(hexKey(t))).map(hexKey);
    expect(unreachable).toEqual([]);
  });
});
