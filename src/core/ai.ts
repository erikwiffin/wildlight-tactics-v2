// Greedy one-turn-lookahead AI. It only uses RNG-free queries (reachable,
// abilityTargets, previewAbility), so it plans on expected value and never
// sees the next roll. Same state in, same action out.

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
import type { Action, GameState, Role, Unit } from './types';

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

export function nextAiAction(state: GameState): Action {
  const u = activeUnit(state);
  if (!u || !state.turn) throw new Error('No active unit');
  const turn = state.turn;
  const plans: Plan[] = [];
  const endAction = (s: GameState, unit: Unit): Action => ({ type: 'end', unit: unit.id, facing: bestFacing(s, unit) });

  // Staying put (no move).
  const here = positionScore(state, u, 0);
  if (!turn.acted) {
    for (const opt of bestActs(state, u)) {
      // Act now; if we can still move, assume we will reach the best spot afterwards.
      const after = turn.moved ? here : Math.max(here, bestMoveScore(state, u));
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
      const pos = positionScore(s, su, u.hp - su.hp);
      let best = pos;
      if (!turn.acted && s.turn) {
        for (const opt of bestActs(s, su)) best = Math.max(best, pos + opt.score);
      }
      plans.push({ score: best, first: mv });
    }
  }

  let pick = plans[0];
  for (const p of plans) if (p.score > pick.score) pick = p;
  return pick.first;
}

function bestMoveScore(state: GameState, u: Unit): number {
  let best = -Infinity;
  for (const node of reachable(state, u).values()) {
    const s = structuredClone(state);
    applyAction(s, { type: 'move', unit: u.id, to: node.hex });
    const su = s.units[u.id];
    if (su.alive) best = Math.max(best, positionScore(s, su, u.hp - su.hp));
  }
  return best;
}

function bestActs(state: GameState, u: Unit): { score: number; action: Action }[] {
  const out: { score: number; action: Action }[] = [];
  for (const ab of defOf(u).abilities) {
    for (const target of abilityTargets(state, u, ab.id)) {
      const score = actionScore(state, u, ab.id, target);
      if (score > 0) out.push({ score, action: { type: 'ability', unit: u.id, ability: ab.id, target } });
    }
  }
  return out;
}

function enemiesNear(state: GameState, u: Unit, dist: number): number {
  return aliveOn(state, u.team === 0 ? 1 : 0).filter((e) => hexDistance(e.pos, u.pos) <= dist).length;
}

export function actionScore(state: GameState, u: Unit, abilityId: string, target: Hex): number {
  const ab = getAbility(u.defId, abilityId);
  let val = 0;
  for (const e of previewAbility(state, u, abilityId, target)) {
    const t = state.units[e.unit];
    const p = e.chance / 10000;
    if (t.team !== u.team) {
      const shield = t.statuses.find((s) => s.id === 'shield')?.amount ?? 0;
      val += p * Math.min(e.damage, t.hp + shield);
      if (e.damage >= t.hp + shield) val += p * 70;
      const onBeacon = state.beacons.some((b) => hexDistance(b.pos, t.pos) === 0);
      for (const eff of e.effects) {
        if (eff.kind === 'status') {
          if (eff.status === 'stun') val += p * 28;
          if (eff.status === 'slow') val += p * 12;
          if (eff.status === 'poison') val += p * eff.turns * (eff.amount ?? 0) * 0.6;
        }
        if (eff.kind === 'ctShift') val += p * Math.abs(eff.amount) * 0.35;
        if (eff.kind === 'push' || eff.kind === 'pull') val += p * (onBeacon ? 25 : 5);
      }
    } else {
      const missing = t.maxHp - t.hp;
      if (e.heal) val += Math.min(e.heal, missing) * 1.2;
      const threatened = enemiesNear(state, t, 5) > 0;
      for (const eff of e.effects) {
        if (eff.kind !== 'status' && eff.kind !== 'cleanse') continue;
        if (eff.kind === 'cleanse') {
          val += t.statuses.filter((s) => s.id === 'slow' || s.id === 'poison' || s.id === 'stun').length * 12;
          continue;
        }
        if (t.statuses.some((s) => s.id === eff.status)) continue; // don't refresh buffs
        if (eff.status === 'regen') val += Math.min(eff.turns * (eff.amount ?? 0), missing) * 0.7;
        if (!threatened) continue;
        if (eff.status === 'shield') val += (eff.amount ?? 0) * 0.6;
        if (eff.status === 'fortify') val += 14;
        if (eff.status === 'thorns') val += enemiesNear(state, t, 2) * 10;
        if (eff.status === 'camo') val += 12;
      }
    }
  }
  for (const eff of ab.effects) {
    if (eff.kind !== 'hazard') continue;
    const center = target;
    const enemies = aliveOn(state, u.team === 0 ? 1 : 0).filter((x) => hexDistance(x.pos, center) <= 2).length;
    const nearBeacon = state.beacons.some((b) => hexDistance(b.pos, center) <= 1);
    val += enemies * 8 + (nearBeacon ? 10 : 0);
  }
  if (ab.chargeSpeed) val *= 0.6;
  if (ab.cooldown > 0) val -= 2; // keep cooldowns for when they matter
  return val;
}

/** How good it is for `u` to end its turn here. `hpLost` is damage taken getting here. */
function positionScore(state: GameState, u: Unit, hpLost: number): number {
  const def = defOf(u);
  const team = u.team;
  const enemies = aliveOn(state, team === 0 ? 1 : 0);
  let score = -hpLost * 2;

  for (const b of state.beacons) {
    if (hexDistance(b.pos, u.pos) !== 0) continue;
    const contested = DIRS.some((d) => {
      const o = unitAt(state, hexAdd(u.pos, d));
      return o && o.team !== team;
    });
    if (b.owner !== team) score += contested ? 30 : 80;
    else score += 18;
  }
  // Pull toward Beacons we don't hold, spreading the team across them.
  const allies = aliveOn(state, team).filter((a) => a.id !== u.id);
  const targets = state.beacons.filter(
    (b) => b.owner !== team && !allies.some((a) => hexDistance(a.pos, b.pos) === 0),
  );
  if (targets.length) {
    const d = Math.min(...targets.map((b) => hexDistance(b.pos, u.pos)));
    score -= d * 5;
  } else if (enemies.length) {
    score -= Math.min(...enemies.map((e) => hexDistance(e.pos, u.pos))) * 2;
  }

  if (def.role === 'support') {
    const hurt = allies.filter((a) => a.hp < a.maxHp);
    if (hurt.length) score -= Math.min(...hurt.map((a) => hexDistance(a.pos, u.pos))) * 3;
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
  score -= threat * RISK[def.role] * (1.6 - hpFrac);
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

/** Deterministic AI team pick: one of a few balanced squads, chosen by seed. */
export function aiTeam(seed: string, playerTeam: string[]): string[] {
  const squads = [
    ['rhino', 'eel', 'lynx', 'moth'],
    ['porcupine', 'fox', 'octopus', 'moth'],
    ['rhino', 'octopus', 'fox', 'eel'],
    ['porcupine', 'lynx', 'eel', 'moth'],
  ];
  let h = 0;
  for (const ch of seed + playerTeam.join()) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return squads[h % squads.length];
}
