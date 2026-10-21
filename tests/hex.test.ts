import { describe, expect, it } from 'vitest';
import { directionTo, hexDistance, hexLine, hexesInRadius, neighbor, type Dir } from '../src/core/hex';
import { nextU32, rollBp, seedRng } from '../src/core/rng';

describe('hex math', () => {
  it('counts hexes in a radius', () => {
    expect(hexesInRadius({ q: 0, r: 0 }, 6)).toHaveLength(127);
  });

  it('measures distance', () => {
    expect(hexDistance({ q: 0, r: 0 }, { q: 2, r: -4 })).toBe(4);
    expect(hexDistance({ q: -3, r: 1 }, { q: 3, r: -1 })).toBe(6);
  });

  it('finds the direction to each neighbor', () => {
    for (let d = 0; d < 6; d++) {
      expect(directionTo({ q: 0, r: 0 }, neighbor({ q: 0, r: 0 }, d as Dir))).toBe(d);
      expect(directionTo({ q: 1, r: 1 }, neighbor(neighbor({ q: 1, r: 1 }, d as Dir), d as Dir))).toBe(d);
    }
  });

  it('draws contiguous lines', () => {
    const line = hexLine({ q: 0, r: 0 }, { q: 4, r: -1 });
    expect(line).toHaveLength(4);
    let prev = { q: 0, r: 0 };
    for (const h of line) {
      expect(hexDistance(prev, h)).toBe(1);
      prev = h;
    }
    expect(prev).toEqual({ q: 4, r: -1 });
  });
});

describe('rng', () => {
  it('is reproducible from a seed', () => {
    const a = seedRng('wild');
    const b = seedRng('wild');
    const xs = Array.from({ length: 50 }, () => nextU32(a));
    const ys = Array.from({ length: 50 }, () => nextU32(b));
    expect(xs).toEqual(ys);
  });

  it('survives a JSON round-trip mid-stream', () => {
    const a = seedRng(42);
    for (let i = 0; i < 10; i++) nextU32(a);
    const b = JSON.parse(JSON.stringify(a));
    expect(nextU32(a)).toBe(nextU32(b));
  });

  it('rolls roughly uniform basis points', () => {
    const s = seedRng('dist');
    let under = 0;
    for (let i = 0; i < 20000; i++) if (rollBp(s) < 8500) under++;
    expect(under / 20000).toBeGreaterThan(0.83);
    expect(under / 20000).toBeLessThan(0.87);
  });
});
