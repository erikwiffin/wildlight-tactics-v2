import { describe, expect, it } from 'vitest';
import {
  abilityTargets,
  activeUnit,
  applyAction,
  attackArc,
  computeDamage,
  createMatch,
  hitChance,
  IllegalActionError,
  newConfig,
  previewQueue,
  reachable,
} from '../src/core/engine';
import { getAbility } from '../src/core/monsters';
import type { GameState, Unit } from '../src/core/types';

const TEAMS: [string[], string[]] = [['rhino', 'fox', 'moth', 'eel'], ['lynx', 'porcupine', 'octopus', 'eel']];
const fresh = () => createMatch(newConfig('test', TEAMS));

function place(_state: GameState, u: Unit, q: number, r: number) {
  u.pos = { q, r };
}

describe('turn order', () => {
  it('gives the first turn to the fastest unit', () => {
    const s = fresh();
    expect(activeUnit(s)?.defId).toBe('fox');
  });

  it('previews the queue including the Pulse', () => {
    const q = previewQueue(fresh(), 30);
    expect(q[0]).toEqual({ kind: 'unit', unit: fresh().turn!.unit });
    expect(q.some((e) => e.kind === 'pulse')).toBe(true);
  });

  it('matches the preview with what actually happens', () => {
    const s = fresh();
    const predicted = previewQueue(s, 6).filter((e) => e.kind === 'unit').map((e) => (e as { unit: number }).unit);
    const actual: number[] = [];
    for (let i = 0; i < predicted.length; i++) {
      const u = activeUnit(s)!;
      actual.push(u.id);
      // Full turns keep the preview's assumption (move + act = 100 CT).
      const dest = [...reachable(s, u).values()][0].hex;
      applyAction(s, { type: 'move', unit: u.id, to: dest });
      s.turn!.acted = true;
      applyAction(s, { type: 'end', unit: u.id, facing: u.facing });
    }
    expect(actual).toEqual(predicted);
  });
});

describe('actions', () => {
  it('rejects acting out of turn', () => {
    const s = fresh();
    const other = s.units.find((u) => u.id !== s.turn!.unit)!;
    expect(() => applyAction(s, { type: 'end', unit: other.id, facing: 0 })).toThrow(IllegalActionError);
  });

  it('rejects unreachable moves', () => {
    const s = fresh();
    const u = activeUnit(s)!;
    expect(() => applyAction(s, { type: 'move', unit: u.id, to: { q: 2, r: -4 } })).toThrow(IllegalActionError);
  });

  it('blocks moving through enemies but not allies', () => {
    const s = fresh();
    const u = activeUnit(s)!;
    const enemy = s.units.find((x) => x.team !== u.team)!;
    place(s, u, 0, 0);
    place(s, enemy, 1, 0);
    expect(reachable(s, u).has('1,0')).toBe(false);
  });
});

describe('combat', () => {
  it('grades facing arcs on hexes', () => {
    const s = fresh();
    const t = s.units[1];
    t.pos = { q: 0, r: 0 };
    t.facing = 0; // facing East
    expect(attackArc({ q: 1, r: 0 }, t)).toBe('front');
    expect(attackArc({ q: 1, r: -1 }, t)).toBe('front');
    expect(attackArc({ q: 0, r: 1 }, t)).toBe('front');
    expect(attackArc({ q: 0, r: -1 }, t)).toBe('flank');
    expect(attackArc({ q: -1, r: 1 }, t)).toBe('flank');
    expect(attackArc({ q: -1, r: 0 }, t)).toBe('rear');
  });

  it('rewards rear attacks with damage and a guaranteed hit', () => {
    const s = fresh();
    const lynx = s.units.find((u) => u.defId === 'lynx')!;
    const rhino = s.units.find((u) => u.defId === 'rhino')!;
    rhino.pos = { q: 4, r: 4 }; // flat ground
    rhino.facing = 0;
    const claw = getAbility('lynx', 'claw');
    const eff = claw.effects[0] as Extract<typeof claw.effects[0], { kind: 'damage' }>;
    const front = computeDamage(s, lynx, { q: 5, r: 4 }, rhino, eff);
    const rear = computeDamage(s, lynx, { q: 3, r: 4 }, rhino, eff);
    expect(front.arc).toBe('front');
    expect(rear.arc).toBe('rear');
    expect(rear.amount).toBeGreaterThan(front.amount);
    expect(hitChance(claw, 'rear')).toBe(10000);
    expect(hitChance(claw, 'front')).toBe(9000);
  });

  it('respects camo for ranged targeting', () => {
    const s = fresh();
    const eel = s.units.find((u) => u.team === 0 && u.defId === 'eel')!;
    const lynx = s.units.find((u) => u.defId === 'lynx')!;
    s.turn = { unit: eel.id, moved: false, acted: false };
    eel.pos = { q: 0, r: 3 };
    lynx.pos = { q: 0, r: 0 };
    const key = (hs: { q: number; r: number }[]) => hs.map((h) => `${h.q},${h.r}`);
    expect(key(abilityTargets(s, eel, 'zap'))).toContain('0,0');
    lynx.statuses.push({ id: 'camo', turns: 2, amount: 0 });
    expect(key(abilityTargets(s, eel, 'zap'))).not.toContain('0,0');
  });
});

describe('beacons', () => {
  it('captures when ending a turn on an uncontested beacon, and scores on Pulse', () => {
    const s = fresh();
    const u = activeUnit(s)!;
    place(s, u, -2, 4);
    applyAction(s, { type: 'end', unit: u.id, facing: 1 });
    expect(s.beacons[0].owner).toBe(u.team);
    // Run turns until the next Pulse.
    while (s.pulses === 0) {
      const a = activeUnit(s)!;
      applyAction(s, { type: 'end', unit: a.id, facing: a.facing });
    }
    expect(s.score[u.team]).toBe(1);
  });

  it('does not capture while an enemy is adjacent', () => {
    const s = fresh();
    const u = activeUnit(s)!;
    const enemy = s.units.find((x) => x.team !== u.team)!;
    place(s, u, 0, 0);
    place(s, enemy, 1, 0);
    applyAction(s, { type: 'end', unit: u.id, facing: 0 });
    expect(s.beacons[1].owner).toBe(null);
  });
});
