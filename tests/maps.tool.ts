// Map report: `TOOL=1 npx vitest run tests/maps.tool.ts` -> map-report.txt
// Draws each map as text and measures how much terrain shapes positioning.
import { writeFileSync } from 'node:fs';
import { it } from 'vitest';
import { hexDistance, hexKey, hexLine, type Hex } from '../src/core/hex';
import { MAP_LIST } from '../src/core/map';
import type { MapDef, Tile } from '../src/core/types';

export function mapStats(m: MapDef) {
  const tiles = new Map(m.tiles.map((t) => [hexKey(t), t]));
  const open = m.tiles.filter((t) => t.terrain !== 'blocked' && t.terrain !== 'void');
  const blocks = (t: Tile | undefined, a: number, b: number) => !!t && (t.terrain === 'blocked' || t.h >= Math.max(a, b) + 2);
  const clear = (a: Tile, b: Tile, side: 1 | -1) => hexLine(a, b, side).slice(0, -1).every((h) => !blocks(tiles.get(hexKey(h)), a.h, b.h));
  let pairs = 0, blind = 0;
  for (const a of open) for (const b of open) {
    const d = hexDistance(a, b);
    if (d < 2 || d > 4) continue;
    pairs++;
    if (!clear(a, b, 1) && !clear(a, b, -1)) blind++;
  }
  // Exposure of each Beacon: how many of its 6 neighbors a jump-1 unit can stand on.
  const approaches = m.beacons.map((bk) => {
    const bt = tiles.get(hexKey(bk))!;
    return [[1, 0], [1, -1], [0, -1], [-1, 0], [-1, 1], [0, 1]].filter(([dq, dr]) => {
      const n = tiles.get(hexKey({ q: bk.q + dq, r: bk.r + dr }));
      return n && n.terrain !== 'blocked' && n.terrain !== 'void' && Math.abs(n.h - bt.h) <= 1;
    }).length;
  });
  return {
    tiles: m.tiles.length,
    obstaclePct: Math.round((100 * m.tiles.filter((t) => t.terrain === 'blocked').length) / m.tiles.length),
    highGroundPct: Math.round((100 * open.filter((t) => t.h >= 2).length) / open.length),
    blindPct: Math.round((100 * blind) / pairs),
    beaconApproaches: approaches,
  };
}

function draw(m: MapDef): string {
  const tiles = new Map(m.tiles.map((t) => [hexKey(t), t]));
  const beacon = new Set(m.beacons.map(hexKey));
  const s0 = new Set(m.spawns[0].map(hexKey)), s1 = new Set(m.spawns[1].map(hexKey));
  const rs = m.tiles.map((t) => t.r), qs = m.tiles.map((t) => t.q + t.r / 2);
  const lines: string[] = [];
  for (let r = Math.min(...rs); r <= Math.max(...rs); r++) {
    let line = '';
    const xmin = Math.min(...qs);
    for (let x2 = Math.round(xmin * 2); x2 <= Math.round(Math.max(...qs) * 2); x2++) {
      const qd = x2 / 2 - r / 2;
      if (!Number.isInteger(qd)) { line += ' '; continue; }
      const h: Hex = { q: qd, r };
      const t = tiles.get(hexKey(h));
      const k = hexKey(h);
      line += !t ? ' ' : beacon.has(k) ? 'B' : s0.has(k) ? 'a' : s1.has(k) ? 'b' : t.terrain === 'blocked' ? '#' : t.terrain === 'void' ? '~' : t.terrain === 'rough' ? ',' : t.h === 0 ? '.' : String(t.h);
    }
    lines.push(line.replace(/\s+$/, ''));
  }
  return lines.join('\n');
}

it('map report', () => {
  const out = MAP_LIST.map((m) => `== ${m.name} ==\n${JSON.stringify(mapStats(m))}\n${draw(m)}`);
  writeFileSync(process.env.MAP_OUT ?? 'map-report.txt', out.join('\n\n') + '\n\nLegend: # rock  ~ lava  , rough  . flat  1-3 height  B beacon  a/b spawns\n');
});
