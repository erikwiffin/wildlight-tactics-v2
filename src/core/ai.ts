// Greedy one-turn-lookahead AI. It only uses RNG-free queries (reachable,
// abilityTargets, previewAbility), so it plans on expected value and never
// sees the next roll. Same state + strategy in, same action out.
//
// Strategies are weight sets over the same scoring terms, so they share all
// the rules knowledge and differ only in what they care about.

import {
  abilityTargets,
  activeUnit,
  aliveOn,
  applyAction,
  computeDamage,
  defOf,
  previewAbility,
  reachable,
  tileAt,
  unitAt,
} from './engine';
import { DIRS, directionTo, hexAdd, hexDistance, type Dir, type Hex } from './hex';
import { getAbility } from './monsters';
import type { Action, GameState, Role, StrategyId, Unit } from './types';

export interface StrategyInfo {
  id: StrategyId;
  name: string;
  desc: string;
}

export const STRATEGIES: StrategyInfo[] = [
  { id: 'balanced', name: 'Balanced', desc: 'Takes Beacons, trades when the trade is good.' },
  { id: 'aggressive', name: 'Aggressive', desc: 'Dives for KOs and chases the enemy across the map.' },
  { id: 'defensive', name: 'Defensive', desc: 'Holds what it has, guards its healer, punishes overextension.' },
  { id: 'objective', name: 'Objective', desc: 'Races for Beacons and avoids fights it does not need.' },
];

interface Weights {
  damage: number; // per expected HP of damage
  ko: number; // bonus per expected KO
  control: number; // multiplier on status / displacement value
  support: number; // multiplier on heals and buffs
  capture: number; // ending on an unheld, uncontested Beacon
  hold: number; // standing on one of our Beacons
  beaconPull: number; // per hex to the nearest Beacon we don't hold
  guard: number; // per hex to our nearest threatened Beacon
  approach: number; // per hex to the nearest enemy (always on)
  cohesion: number; // per hex beyond 2 from the nearest ally
  risk: number; // multiplier on threat exposure
}

const WEIGHTS: Record<StrategyId, Weights> = {
  balanced: { damage: 1, ko: 70, control: 1, support: 1, capture: 80, hold: 18, beaconPull: 5, guard: 0, approach: 0, cohesion: 0, risk: 1 },
  aggressive: { damage: 1.35, ko: 130, control: 0.8, support: 0.7, capture: 40, hold: 6, beaconPull: 1.5, guard: 0, approach: 5, cohesion: 0, risk: 0.4 },
  defensive: { damage: 0.9, ko: 70, control: 1.3, support: 1.5, capture: 70, hold: 45, beaconPull: 2, guard: 5, approach: 0, cohesion: 2.5, risk: 1.7 },
  objective: { damage: 0.7, ko: 55, control: 1, support: 1, capture: 140, hold: 22, beaconPull: 9, guard: 1.5, approach: 0, cohesion: 0, risk: 1.25 },
};

interface Plan {
  score: number;
  first: Action;
}

const RISK: Record<Role, number> = {
  tank: 0.25,
  skirmisher: 0.7,
  support: 1.1,
  zoner: 0.6,
  ranged: 0.9,
  assassin: 0.7,
  controller: 0.8,
};

export function nextAiAction(state: GameState, strategy: StrategyId = 'balanced'): Action {
  const w = WEIGHTS[strategy];
  const u = activeUnit(state);
  if (!u || !state.turn) throw new Error('No active unit');
  const turn = state.turn;
  const plans: Plan[] = [];
  const endAction = (s: GameState, unit: Unit): Action => ({ type: 'end', unit: unit.id, facing: bestFacing(s, unit) });

  // Staying put (no move).
  const here = positionScore(state, u, 0, w);
  if (!turn.acted) {
    for (const opt of bestActs(state, u, w)) {
      // Act now; if we can still move, assume we will reach the best spot afterwards.
      const after = turn.moved ? here : Math.max(here, bestMoveScore(state, u, w));
      plans.push({ score: opt.score + after, first: opt.action });
    }
  }
  plans.push({ score: here, first: endAction(state, u) });

  if (!turn.moved) {
    for (const node of reachable(state, u).values()) {
      const s = structuredClone(state);
      const mv: Action = { type: 'move', unit: u.id, to: node.hex };
      applyAction(s, mv);
      const su = s.units[u.id];
      if (!su.alive) continue;
      const pos = positionScore(s, su, u.hp - su.hp, w);
      let best = pos;
      if (!turn.acted && s.turn) {
        for (const opt of bestActs(s, su, w)) best = Math.max(best, pos + opt.score);
      }
      plans.push({ score: best, first: mv });
    }
  }

  let pick = plans[0];
  for (const p of plans) if (p.score > pick.score) pick = p;
  return pick.first;
}

function bestMoveScore(state: GameState, u: Unit, w: Weights): number {
  let best = -Infinity;
  for (const node of reachable(state, u).values()) {
    const s = structuredClone(state);
    applyAction(s, { type: 'move', unit: u.id, to: node.hex });
    const su = s.units[u.id];
    if (su.alive) best = Math.max(best, positionScore(s, su, u.hp - su.hp, w));
  }
  return best;
}

function bestActs(state: GameState, u: Unit, w: Weights): { score: number; action: Action }[] {
  const out: { score: number; action: Action }[] = [];
  for (const ab of defOf(u).abilities) {
    for (const target of abilityTargets(state, u, ab.id)) {
      const score = actionScore(state, u, ab.id, target, w);
      if (score > 0) out.push({ score, action: { type: 'ability', unit: u.id, ability: ab.id, target } });
    }
  }
  return out;
}

function enemiesNear(state: GameState, u: Unit, dist: number): number {
  return aliveOn(state, u.team === 0 ? 1 : 0).filter((e) => hexDistance(e.pos, u.pos) <= dist).length;
}

export function actionScore(state: GameState, u: Unit, abilityId: string, target: Hex, w: Weights = WEIGHTS.balanced): number {
  const ab = getAbility(u.defId, abilityId);
  let val = 0;
  for (const e of previewAbility(state, u, abilityId, target)) {
    const t = state.units[e.unit];
    const p = e.chance / 10000;
    if (t.team !== u.team) {
      const shield = t.statuses.find((s) => s.id === 'shield')?.amount ?? 0;
      val += p * Math.min(e.damage, t.hp + shield) * w.damage;
      if (e.damage >= t.hp + shield) val += p * w.ko;
      const onBeacon = state.beacons.some((b) => hexDistance(b.pos, t.pos) === 0);
      let cc = 0;
      for (const eff of e.effects) {
        if (eff.kind === 'status') {
          if (eff.status === 'stun') cc += 28;
          if (eff.status === 'slow') cc += 12;
          if (eff.status === 'poison') cc += eff.turns * (eff.amount ?? 0) * 0.6;
        }
        if (eff.kind === 'ctShift') cc += Math.abs(eff.amount) * 0.35;
        if (eff.kind === 'push' || eff.kind === 'pull') cc += onBeacon ? 25 : 5;
      }
      val += p * cc * w.control;
    } else {
      const missing = t.maxHp - t.hp;
      let sup = 0;
      if (e.heal) sup += Math.min(e.heal, missing) * 1.2;
      const threatened = enemiesNear(state, t, 5) > 0;
      for (const eff of e.effects) {
        if (eff.kind !== 'status' && eff.kind !== 'cleanse') continue;
        if (eff.kind === 'cleanse') {
          sup += t.statuses.filter((s) => s.id === 'slow' || s.id === 'poison' || s.id === 'stun').length * 12;
          continue;
        }
        if (t.statuses.some((s) => s.id === eff.status)) continue; // don't refresh buffs
        if (eff.status === 'regen') sup += Math.min(eff.turns * (eff.amount ?? 0), missing) * 0.7;
        if (!threatened) continue;
        if (eff.status === 'shield') sup += (eff.amount ?? 0) * 0.6;
        if (eff.status === 'fortify') sup += 14;
        if (eff.status === 'thorns') sup += enemiesNear(state, t, 2) * 10;
        if (eff.status === 'camo') sup += 12;
      }
      val += sup * w.support;
    }
  }
  for (const eff of ab.effects) {
    if (eff.kind !== 'hazard') continue;
    const enemies = aliveOn(state, u.team === 0 ? 1 : 0).filter((x) => hexDistance(x.pos, target) <= 2).length;
    const nearBeacon = state.beacons.some((b) => hexDistance(b.pos, target) <= 1);
    val += (enemies * 8 + (nearBeacon ? 10 : 0)) * w.control;
  }
  if (ab.chargeSpeed) val *= 0.6;
  if (ab.cooldown > 0) val -= 2; // keep cooldowns for when they matter
  return val;
}

/** How good it is for `u` to end its turn here. `hpLost` is damage taken getting here. */
function positionScore(state: GameState, u: Unit, hpLost: number, w: Weights): number {
  const def = defOf(u);
  const team = u.team;
  const enemies = aliveOn(state, team === 0 ? 1 : 0);
  const allies = aliveOn(state, team).filter((a) => a.id !== u.id);
  let score = -hpLost * 2;

  for (const b of state.beacons) {
    if (hexDistance(b.pos, u.pos) !== 0) continue;
    const contested = DIRS.some((d) => {
      const o = unitAt(state, hexAdd(u.pos, d));
      return o && o.team !== team;
    });
    if (b.owner !== team) score += contested ? w.capture * 0.4 : w.capture;
    else score += w.hold;
  }
  // Pull toward Beacons we don't hold, spreading the team across them.
  const targets = state.beacons.filter(
    (b) => b.owner !== team && !allies.some((a) => hexDistance(a.pos, b.pos) === 0),
  );
  if (targets.length) {
    score -= Math.min(...targets.map((b) => hexDistance(b.pos, u.pos))) * w.beaconPull;
  } else if (enemies.length) {
    score -= Math.min(...enemies.map((e) => hexDistance(e.pos, u.pos))) * 2;
  }
  if (w.approach && enemies.length) {
    score -= Math.min(...enemies.map((e) => hexDistance(e.pos, u.pos))) * w.approach;
  }
  if (w.guard) {
    const threatened = state.beacons.filter(
      (b) => b.owner === team && enemies.some((e) => hexDistance(e.pos, b.pos) <= 4),
    );
    if (threatened.length) score -= Math.min(...threatened.map((b) => hexDistance(b.pos, u.pos))) * w.guard;
  }
  if (w.cohesion && allies.length) {
    const d = Math.min(...allies.map((a) => hexDistance(a.pos, u.pos)));
    score -= Math.max(0, d - 2) * w.cohesion;
  }

  if (def.role === 'support') {
    const hurt = allies.filter((a) => a.hp < a.maxHp);
    if (hurt.length) score -= Math.min(...hurt.map((a) => hexDistance(a.pos, u.pos))) * 3 * w.support;
  }
  if (def.role === 'ranged' || def.role === 'support') score += (tileAt(state, u.pos)?.h ?? 0) * 3;

  // Exposure: expected basic-attack damage from every enemy that could reach us.
  const hpFrac = u.hp / u.maxHp;
  let threat = 0;
  for (const e of enemies) {
    const ed = defOf(e);
    const basic = ed.abilities[0];
    const reach = ed.stats.move + basic.maxRange + 1;
    if (hexDistance(e.pos, u.pos) > reach) continue;
    const dmgEff = basic.effects.find((x) => x.kind === 'damage');
    if (dmgEff && dmgEff.kind === 'damage') threat += computeDamage(state, e, e.pos, u, dmgEff).amount;
  }
  score -= threat * RISK[def.role] * (1.6 - hpFrac) * w.risk;
  return score;
}

/** Face so the fewest threats sit on our flank or rear; nearest enemy breaks ties. */
export function bestFacing(state: GameState, u: Unit): Dir {
  const enemies = aliveOn(state, u.team === 0 ? 1 : 0)
    .filter((e) => hexDistance(e.pos, u.pos) <= defOf(e).stats.move + 3)
    .sort((a, b) => hexDistance(a.pos, u.pos) - hexDistance(b.pos, u.pos) || a.id - b.id);
  if (!enemies.length) return u.facing;
  const toward = directionTo(u.pos, enemies[0].pos);
  let best: Dir = toward;
  let bestPenalty = Infinity;
  for (let i = 0; i < 6; i++) {
    const f = ((toward + i) % 6) as Dir;
    let pen = 0;
    for (const e of enemies) {
      const off = (directionTo(u.pos, e.pos) - f + 6) % 6;
      pen += off === 3 ? 3 : off === 2 || off === 4 ? 2 : 0;
    }
    if (pen < bestPenalty) {
      bestPenalty = pen;
      best = f;
    }
  }
  return best;
}

// Each strategy drafts in preference order; the seed picks one of two lists.
const DRAFTS: Record<StrategyId, [string[], string[]]> = {
  balanced: [['rhino', 'eel', 'moth', 'lynx', 'octopus'], ['porcupine', 'fox', 'moth', 'octopus', 'eel']],
  aggressive: [['lynx', 'fox', 'eel', 'rhino', 'octopus'], ['lynx', 'octopus', 'fox', 'eel', 'rhino']],
  defensive: [['rhino', 'moth', 'porcupine', 'eel', 'octopus'], ['porcupine', 'moth', 'rhino', 'octopus', 'eel']],
  objective: [['fox', 'rhino', 'moth', 'eel', 'lynx'], ['fox', 'octopus', 'moth', 'rhino', 'porcupine']],
};

/** Deterministic AI draft for a strategy and team size. `salt` separates the two sides. */
export function aiTeam(seed: string, strategy: StrategyId, size: number, salt = ''): string[] {
  let h = 0;
  for (const ch of seed + salt + strategy) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return DRAFTS[strategy][h % 2].slice(0, size);
}
