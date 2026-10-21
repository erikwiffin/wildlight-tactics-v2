// Axial hex coordinates, pointy-top. Everything here is integer math so the
// rules layer stays deterministic across engines.

export interface Hex {
  q: number;
  r: number;
}

/** 0..5, counter-clockwise starting East (on screen, with +r pointing "down"). */
export type Dir = 0 | 1 | 2 | 3 | 4 | 5;

export const DIRS: readonly Hex[] = [
  { q: 1, r: 0 },  // 0 E
  { q: 1, r: -1 }, // 1 NE
  { q: 0, r: -1 }, // 2 NW
  { q: -1, r: 0 }, // 3 W
  { q: -1, r: 1 }, // 4 SW
  { q: 0, r: 1 },  // 5 SE
];

export const hexKey = (h: Hex): string => `${h.q},${h.r}`;
export const hexEq = (a: Hex, b: Hex): boolean => a.q === b.q && a.r === b.r;
export const hexAdd = (a: Hex, b: Hex): Hex => ({ q: a.q + b.q, r: a.r + b.r });
export const hexSub = (a: Hex, b: Hex): Hex => ({ q: a.q - b.q, r: a.r - b.r });
export const hexScale = (a: Hex, k: number): Hex => ({ q: a.q * k, r: a.r * k });
export const neighbor = (h: Hex, d: Dir): Hex => hexAdd(h, DIRS[d]);
export const neighbors = (h: Hex): Hex[] => DIRS.map((d) => hexAdd(h, d));

export function hexDistance(a: Hex, b: Hex): number {
  const dq = a.q - b.q;
  const dr = a.r - b.r;
  return (Math.abs(dq) + Math.abs(dr) + Math.abs(dq + dr)) / 2;
}

export function hexesInRadius(center: Hex, radius: number): Hex[] {
  const out: Hex[] = [];
  for (let q = -radius; q <= radius; q++) {
    const r1 = Math.max(-radius, -q - radius);
    const r2 = Math.min(radius, -q + radius);
    for (let r = r1; r <= r2; r++) out.push({ q: center.q + q, r: center.r + r });
  }
  return out;
}

/**
 * Closest of the six directions pointing from `from` toward `to`.
 * The cube-coordinate plane is a scaled copy of the hex plane, so the
 * integer dot product with each direction vector ranks them by angle.
 * Exact ties (target sits on a 30° boundary) resolve to the lower index.
 */
export function directionTo(from: Hex, to: Hex): Dir {
  const dq = to.q - from.q;
  const dr = to.r - from.r;
  const ds = -dq - dr;
  let best: Dir = 0;
  let bestDot = -Infinity;
  for (let i = 0; i < 6; i++) {
    const d = DIRS[i];
    const dot = dq * d.q + dr * d.r + ds * (-d.q - d.r);
    if (dot > bestDot) {
      bestDot = dot;
      best = i as Dir;
    }
  }
  return best;
}

export const oppositeDir = (d: Dir): Dir => ((d + 3) % 6) as Dir;

/**
 * Hexes on the straight line from a to b (excluding a), using integer cube
 * interpolation. When the line runs exactly along a hex edge, `side` (+1/-1)
 * picks which neighbor it passes through; the nudge is far larger than any
 * float error, so results never depend on rounding.
 */
export function hexLine(a: Hex, b: Hex, side: 1 | -1 = 1): Hex[] {
  const n = hexDistance(a, b);
  const out: Hex[] = [];
  // Scale by 6n so every lerp lands on an integer, then round in cube space.
  const S = 6 * Math.max(n, 1);
  const e = side;
  const ax = a.q * S + e, az = a.r * S + e, ay = -a.q * S - a.r * S - 2 * e;
  const bx = b.q * S + e, bz = b.r * S + e, by = -b.q * S - b.r * S - 2 * e;
  for (let i = 1; i <= n; i++) {
    const x = ax + ((bx - ax) * i) / n;
    const z = az + ((bz - az) * i) / n;
    const y = ay + ((by - ay) * i) / n;
    out.push(cubeRound(x / S, y / S, z / S));
  }
  return out;
}

function cubeRound(x: number, y: number, z: number): Hex {
  let rx = Math.round(x), ry = Math.round(y), rz = Math.round(z);
  const dx = Math.abs(rx - x), dy = Math.abs(ry - y), dz = Math.abs(rz - z);
  if (dx > dy && dx > dz) rx = -ry - rz;
  else if (dy > dz) ry = -rx - rz;
  else rz = -rx - ry;
  return { q: rx, r: rz };
}
