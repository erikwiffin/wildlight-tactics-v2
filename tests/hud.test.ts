import { describe, expect, it } from 'vitest';
import { attackArc, createMatch, movePath, newConfig, reachable, tileAt } from '../src/core/engine';
import { hexDistance, hexEq } from '../src/core/hex';
import { logLine, safestFacing, threat } from '../src/ui/hud';

const match = () => createMatch(newConfig('hud', [['rhino', 'fox', 'moth', 'eel'], ['lynx', 'octopus', 'porcupine', 'rhino']], 'arena'));

describe('HUD helpers', () => {
  it('safest facing never leaves the nearest enemy behind the unit', () => {
    const s = match();
    for (const u of s.units) {
      const enemies = s.units.filter((e) => e.team !== u.team);
      const nearest = enemies.reduce((a, b) => (hexDistance(a.pos, u.pos) <= hexDistance(b.pos, u.pos) ? a : b));
      const facing = safestFacing(s, u);
      expect(attackArc(nearest.pos, { ...u, facing })).not.toBe('rear');
    }
  });

  it('threat covers where an enemy can move, plus walkable hexes in its reach', () => {
    const s = match();
    const u = s.units.find((x) => x.team === 1)!;
    const t = threat(s, u);
    expect(t.move.length).toBe(reachable(s, u).size);
    expect(t.hit.every((h) => tileAt(s, h)?.terrain !== 'blocked')).toBe(true);
    expect(t.hit.some((h) => t.move.some((m) => hexEq(m, h)))).toBe(false);
  });

  it('move paths end at the destination and step one hex at a time', () => {
    const s = match();
    const u = s.units[0];
    for (const n of reachable(s, u).values()) {
      const path = movePath(s, u, n.hex);
      expect(hexEq(path[path.length - 1], n.hex)).toBe(true);
      [u.pos, ...path].slice(1).forEach((h, i) => expect(hexDistance(h, [u.pos, ...path][i])).toBe(1));
    }
  });

  it('writes battle-log lines with team names', () => {
    const s = match();
    expect(logLine(s, { type: 'capture', beacon: 0, team: 1 }, ['You', 'Balanced AI'])).toBe('◆ AI took a Beacon');
    expect(logLine(s, { type: 'hit', unit: 0, source: 4, amount: 12, arc: 'rear' }, ['You', 'AI'])).toContain('12 (rear)');
    expect(logLine(s, { type: 'turnStart', unit: 0 }, ['You', 'AI'])).toBeNull();
  });
});
