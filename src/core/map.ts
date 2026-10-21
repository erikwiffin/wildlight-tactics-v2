import { hexDistance, hexesInRadius, hexKey, type Hex } from './hex';
import type { MapDef, Terrain, Tile } from './types';

// The arena is point-symmetric: (q, r) mirrors to (-q, -r). Overrides are
// authored for one half and mirrored, so neither team gets a better map.

const HEIGHTS: [number, number, number][] = [
  // Right-flank hill (Team 0 side), climbable from (4,2).
  [3, 1, 3], [4, 1, 2], [3, 2, 2], [4, 0, 2], [4, 2, 1], [2, 2, 1], [5, 0, 1],
  // Home beacon mound.
  [-2, 4, 1], [-3, 4, 1], [-1, 4, 1],
  // Rolling ground.
  [-5, 3, 1], [-4, 3, 1], [-6, 6, 1], [0, 5, 1],
];

const TERRAIN: [number, number, Terrain][] = [
  [-3, 1, 'blocked'], [-4, 2, 'blocked'], [1, 3, 'blocked'], [6, -1, 'blocked'],
  [-1, 3, 'rough'], [0, 3, 'rough'], [-5, 5, 'rough'], [2, 3, 'rough'], [-4, 1, 'rough'],
];

function buildArena(): MapDef {
  const radius = 6;
  const center = { q: 0, r: 0 };
  const heights = new Map<string, number>();
  const terrain = new Map<string, Terrain>();
  for (const [q, r, h] of HEIGHTS) {
    heights.set(hexKey({ q, r }), h);
    heights.set(hexKey({ q: -q, r: -r }), h);
  }
  for (const [q, r, t] of TERRAIN) {
    terrain.set(hexKey({ q, r }), t);
    terrain.set(hexKey({ q: -q, r: -r }), t);
  }
  const tiles: Tile[] = hexesInRadius(center, radius).map((hex) => {
    const d = hexDistance(hex, center);
    const k = hexKey(hex);
    // Central plateau: the contested Beacon sits on high ground.
    const base = d <= 1 ? 2 : d === 2 ? 1 : 0;
    return { q: hex.q, r: hex.r, h: heights.get(k) ?? base, terrain: terrain.get(k) ?? 'normal' };
  });

  const spawn0: Hex[] = [{ q: -4, r: 6 }, { q: -3, r: 6 }, { q: -2, r: 6 }, { q: -3, r: 5 }];
  return {
    id: 'arena',
    name: 'Shattered Basin',
    radius,
    tiles,
    beacons: [{ q: -2, r: 4 }, { q: 0, r: 0 }, { q: 2, r: -4 }],
    spawns: [spawn0, spawn0.map((h) => ({ q: -h.q, r: -h.r }))],
    spawnFacing: [1, 4],
  };
}

export const MAPS: Record<string, MapDef> = { arena: buildArena() };

export interface MapIndex {
  def: MapDef;
  tiles: Map<string, Tile>;
}

const indexCache = new Map<string, MapIndex>();

export function getMap(id: string): MapIndex {
  let idx = indexCache.get(id);
  if (!idx) {
    const def = MAPS[id];
    if (!def) throw new Error(`Unknown map ${id}`);
    idx = { def, tiles: new Map(def.tiles.map((t) => [hexKey(t), t])) };
    indexCache.set(id, idx);
  }
  return idx;
}
