import { hexDistance, hexesInRadius, hexKey, type Dir, type Hex } from './hex';
import type { MapDef, Terrain, Tile } from './types';
import { RULES_VERSION } from './version';

// Every map is point-symmetric: (q, r) mirrors to (-q, -r), and Team 1's
// spawns, facing and Beacons are Team 0's mirrored. Overrides are authored for
// one half and mirrored, so neither side ever gets a better map.

interface MapSpec {
  id: string;
  name: string;
  blurb: string;
  teamSize: number;
  scoreToWin: number;
  shape: Hex[];
  /** Height before overrides. Must itself be symmetric. */
  baseHeight: (h: Hex) => number;
  baseTerrain?: (h: Hex) => Terrain | undefined;
  heights?: [number, number, number][];
  terrain?: [number, number, Terrain][];
  /** Rules v3 additions: rock outcrops (impassable, block sight; applied last) and extra heights. */
  v3?: { rocks?: [number, number][]; heights?: [number, number, number][] };
  /** Beacons for one side (mirrored), plus any on the center hex. */
  beacons: Hex[];
  spawn0: Hex[];
  facing0: Dir;
}

const mirror = (h: Hex): Hex => ({ q: -h.q || 0, r: -h.r || 0 });
const isCenter = (h: Hex) => h.q === 0 && h.r === 0;

function buildMap(spec: MapSpec, version: number): MapDef {
  const heights = new Map<string, number>();
  const terrain = new Map<string, Terrain>();
  const v3 = version >= 3 ? spec.v3 : undefined;
  for (const [q, r, h] of [...(spec.heights ?? []), ...(v3?.heights ?? [])]) {
    heights.set(hexKey({ q, r }), h);
    heights.set(hexKey(mirror({ q, r })), h);
  }
  for (const [q, r, t] of [...(spec.terrain ?? []), ...(v3?.rocks ?? []).map(([q, r]) => [q, r, 'blocked'] as const)]) {
    terrain.set(hexKey({ q, r }), t);
    terrain.set(hexKey(mirror({ q, r })), t);
  }
  const tiles: Tile[] = spec.shape.map((hex) => {
    const k = hexKey(hex);
    return {
      q: hex.q,
      r: hex.r,
      h: heights.get(k) ?? spec.baseHeight(hex),
      terrain: terrain.get(k) ?? spec.baseTerrain?.(hex) ?? 'normal',
    };
  });
  const beacons: Hex[] = [];
  for (const b of spec.beacons) {
    beacons.push(b);
    if (!isCenter(b)) beacons.push(mirror(b));
  }
  return {
    id: spec.id,
    name: spec.name,
    blurb: spec.blurb,
    teamSize: spec.teamSize,
    scoreToWin: spec.scoreToWin,
    tiles,
    beacons,
    spawns: [spec.spawn0, spec.spawn0.map(mirror)],
    spawnFacing: [spec.facing0, ((spec.facing0 + 3) % 6) as Dir],
  };
}

const O = { q: 0, r: 0 };

/** Small duel map: two flank Beacons, a rock spine down the middle. */
const glassHollow: MapSpec = {
  id: 'hollow',
  name: 'Glass Hollow',
  blurb: 'Tight 3v3. Two flank Beacons and a rock spine that breaks sight lines.',
  teamSize: 3,
  scoreToWin: 10,
  shape: hexesInRadius(O, 4),
  baseHeight: () => 0,
  heights: [
    [-3, 0, 1], [-4, 1, 1], [-3, 1, 1], [2, 1, 2], [3, 1, 1], [3, 0, 1], [1, 3, 1],
  ],
  terrain: [
    [0, 0, 'blocked'], [1, 1, 'blocked'], [-1, 3, 'rough'], [-2, 2, 'rough'],
  ],
  v3: {
    rocks: [
      [-2, -1], [-3, -1], // Beacon pocket: open toward our side, walled toward theirs
      [-1, 2], [1, 2], // lane pillars between the spawns and the Beacons
    ],
    heights: [[0, 2, 2], [0, 3, 1]], // perch overlooking the center, ramp from our side
  },
  beacons: [{ q: -3, r: 0 }],
  spawn0: [{ q: -2, r: 4 }, { q: -1, r: 4 }, { q: -3, r: 4 }],
  facing0: 1,
};

const BASIN_HEIGHTS: [number, number, number][] = [
  // Right-flank hill (Team 0 side), climbable from (4,2).
  [3, 1, 3], [4, 1, 2], [3, 2, 2], [4, 0, 2], [4, 2, 1], [2, 2, 1], [5, 0, 1],
  // Home beacon mound.
  [-2, 4, 1], [-3, 4, 1], [-1, 4, 1],
  // Rolling ground.
  [-5, 3, 1], [-4, 3, 1], [-6, 6, 1], [0, 5, 1],
];

/** The original arena: home Beacons plus a raised center. */
const shatteredBasin: MapSpec = {
  id: 'arena',
  name: 'Shattered Basin',
  blurb: 'The standard 4v4. Hold your home Beacon and fight for the raised center.',
  teamSize: 4,
  scoreToWin: 15,
  shape: hexesInRadius(O, 6),
  baseHeight: (h) => {
    const d = hexDistance(h, O);
    return d <= 1 ? 2 : d === 2 ? 1 : 0;
  },
  heights: BASIN_HEIGHTS,
  terrain: [
    [-3, 1, 'blocked'], [-4, 2, 'blocked'], [1, 3, 'blocked'], [6, -1, 'blocked'],
    [-1, 3, 'rough'], [0, 3, 'rough'], [-5, 5, 'rough'], [2, 3, 'rough'], [-4, 1, 'rough'],
  ],
  v3: {
    rocks: [
      [1, -1], // center Beacon: two of its six sides walled
      [-2, 0], // pillars on the plateau's rim (mirrored: west and east)
      [-1, 3], [-3, 4], // home Beacon pocket
      [-5, 1], [-4, 4], [0, 4], [3, 3], [5, -3], [-6, 3], // cover in the lanes
    ],
  },
  beacons: [{ q: -2, r: 4 }, O],
  spawn0: [{ q: -4, r: 6 }, { q: -3, r: 6 }, { q: -2, r: 6 }, { q: -3, r: 5 }],
  facing0: 1,
};

/** Ring around a lava vent: you can shoot across it but not walk it. */
const caldera: MapSpec = {
  id: 'caldera',
  name: 'Caldera',
  blurb: '4v4 around a lava vent. Four Beacons on the rim; shots fly across, feet go around.',
  teamSize: 4,
  scoreToWin: 15,
  shape: hexesInRadius(O, 7),
  baseHeight: (h) => {
    const d = hexDistance(h, O);
    return d <= 2 ? 0 : d === 3 ? 1 : d >= 6 ? 1 : 0;
  },
  baseTerrain: (h) => (hexDistance(h, O) <= 2 ? 'void' : undefined),
  heights: [
    [-3, 5, 1], [-4, 5, 1], [-2, 5, 1], [-6, 2, 2], [-6, 3, 2], [-5, 2, 1], [-7, 3, 2], [-7, 2, 2],
    [2, 4, 2], [3, 3, 2], [4, 2, 1],
  ],
  terrain: [
    [-4, 2, 'blocked'], [-1, 5, 'blocked'], [4, 3, 'blocked'], [-5, 6, 'rough'], [-6, 5, 'rough'], [1, 5, 'rough'],
  ],
  v3: {
    rocks: [
      [3, 0], [0, 3], [-3, 3], // teeth on the inner rim: they break sight across the lava
      [-5, 1], [-7, 3], // side Beacon pocket
      [-2, 4], [-4, 4], // home Beacon pocket
      [-5, 5], [2, 5], [5, 1], [-6, 6], // rim cover
    ],
  },
  beacons: [{ q: -3, r: 5 }, { q: -6, r: 2 }],
  spawn0: [{ q: -4, r: 7 }, { q: -3, r: 7 }, { q: -2, r: 7 }, { q: -3, r: 6 }],
  facing0: 1,
};

// Fault Lines is a wide rectangle: rows r=-7..7, alternating 13 and 12 hexes,
// centered on x=0. Two rock ridges split it into three lanes.
function rectShape(rows: number, even: number): Hex[] {
  const out: Hex[] = [];
  for (let r = -rows; r <= rows; r++) {
    const [a, b] = r % 2 === 0
      ? [-(even >> 1) - r / 2, (even >> 1) - r / 2]
      : [(-r - (even - 2)) / 2, (-r + (even - 2)) / 2];
    for (let q = a; q <= b; q++) out.push({ q, r });
  }
  return out;
}

const RIDGE: [number, number, Terrain][] = [];
for (const r of [-5, -4, -3, -2, 2, 3, 4, 5]) RIDGE.push([Math.round(2.4 - r / 2), r, 'blocked']);

const faultLines: MapSpec = {
  id: 'fault',
  name: 'Fault Lines',
  blurb: 'Big 5v5 with three lanes and five Beacons. Split up or lose the map.',
  teamSize: 5,
  scoreToWin: 20,
  shape: rectShape(7, 13),
  baseHeight: (h) => {
    const d = hexDistance(h, O);
    return d <= 1 ? 2 : d === 2 ? 1 : 0;
  },
  heights: [
    [-3, 5, 1], [-4, 5, 1], [-2, 5, 1], [-3, 6, 1],
    [-5, 1, 1], [-4, 1, 1], [-6, 1, 1], [5, 2, 1], [6, 1, 2], [6, 2, 1], [7, 1, 1],
  ],
  terrain: [
    ...RIDGE,
    [-1, 3, 'rough'], [0, 3, 'rough'], [-7, 4, 'rough'], [4, 4, 'rough'], [-8, 7, 'rough'],
  ],
  v3: {
    rocks: [
      [1, -1], // center Beacon pocket
      [-4, -1], [-6, 1], // lane Beacon pocket
      [-2, 4], [-4, 4], // home Beacon pocket
      [-7, 3], [-5, 3], [-8, 6], [6, 4], [4, 3], [-6, -2], // cover in the lanes
    ],
    heights: [[-6, 4, 2], [-6, 5, 1]], // left-lane perch
  },
  beacons: [{ q: -3, r: 5 }, { q: -5, r: 0 }, O],
  spawn0: [{ q: -5, r: 7 }, { q: -4, r: 7 }, { q: -3, r: 7 }, { q: -2, r: 7 }, { q: -4, r: 6 }],
  facing0: 1,
};

const SPECS: MapSpec[] = [glassHollow, shatteredBasin, caldera, faultLines];

/** The maps as they are under the current rules (what new matches use). */
export const MAP_LIST: MapDef[] = SPECS.map((s) => buildMap(s, RULES_VERSION));
export const MAPS: Record<string, MapDef> = Object.fromEntries(MAP_LIST.map((m) => [m.id, m]));

export interface MapIndex {
  def: MapDef;
  tiles: Map<string, Tile>;
}

const indexCache = new Map<string, MapIndex>();

/** A map as it was under a given rules version (old replays use old layouts). */
export function getMap(id: string, version: number = RULES_VERSION): MapIndex {
  const key = `${version}:${id}`;
  let idx = indexCache.get(key);
  if (!idx) {
    const spec = SPECS.find((s) => s.id === id);
    if (!spec) throw new Error(`Unknown map ${id}`);
    const def = version === RULES_VERSION ? MAPS[id] : buildMap(spec, version);
    idx = { def, tiles: new Map(def.tiles.map((t) => [hexKey(t), t])) };
    indexCache.set(key, idx);
  }
  return idx;
}
