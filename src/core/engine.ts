// The rules. Pure TypeScript, integer math only, no rendering. Given the same
// MatchConfig and the same list of Actions, this always produces the same state.

import {
  DIRS,
  directionTo,
  hexAdd,
  hexDistance,
  hexEq,
  hexKey,
  hexLine,
  hexScale,
  hexesInRadius,
  neighbor,
  type Dir,
  type Hex,
} from './hex';
import { getMap } from './map';
import { getAbility, MONSTER_BY_ID } from './monsters';
import { rollBp, seedRng } from './rng';
import type {
  AbilityDef,
  Action,
  Arc,
  Effect,
  GameEvent,
  GameState,
  MatchConfig,
  MonsterDef,
  StatusId,
  StrategyId,
  TeamId,
  Tile,
  Unit,
} from './types';

// v2: line of sight, per-map team size / score target, void terrain.
export const RULES_VERSION = 2;
export const PULSE_SPEED = 7;
export const MAX_PULSES = 40;
export const CT_FULL = 100;
export const COLLISION_DAMAGE = 10;
/** Global damage tuning knob, in percent. */
export const DAMAGE_SCALE = 150;

// ---------------------------------------------------------------------------
// Setup

export function createMatch(config: MatchConfig): GameState {
  const map = getMap(config.mapId).def;
  for (const team of config.teams) {
    if (team.length !== map.teamSize) throw new Error(`${map.name} needs ${map.teamSize} monsters per team`);
  }
  const units: Unit[] = [];
  const perTeam = Math.max(config.teams[0].length, config.teams[1].length);
  // Interleave ids (A0, B0, A1, B1, ...) so CT tie-breaks alternate between teams.
  for (let i = 0; i < perTeam; i++) {
    for (const team of [0, 1] as TeamId[]) {
      const defId = config.teams[team][i];
      if (!defId) continue;
      const def = MONSTER_BY_ID[defId];
      if (!def) throw new Error(`Unknown monster ${defId}`);
      const spawn = map.spawns[team][i];
      if (!spawn) throw new Error(`No spawn for team ${team} slot ${i}`);
      units.push({
        id: units.length,
        defId,
        team,
        pos: { ...spawn },
        facing: map.spawnFacing[team],
        hp: def.stats.hp,
        maxHp: def.stats.hp,
        ct: 0,
        alive: true,
        statuses: [],
        cooldowns: {},
      });
    }
  }
  const state: GameState = {
    config: structuredClone(config),
    rng: seedRng(`${config.rulesVersion}:${config.seed}`),
    tick: 0,
    units,
    beacons: map.beacons.map((pos) => ({ pos: { ...pos }, owner: null })),
    score: [0, 0],
    pulseCt: 0,
    pulses: 0,
    pending: [],
    nextCastId: 1,
    hazards: [],
    turn: null,
    winner: null,
    actionCount: 0,
  };
  advance(state, []);
  return state;
}

// ---------------------------------------------------------------------------
// Queries

export const defOf = (u: Unit): MonsterDef => MONSTER_BY_ID[u.defId];

export const scoreToWin = (state: GameState): number => getMap(state.config.mapId).def.scoreToWin;

export function tileAt(state: GameState, h: Hex): Tile | undefined {
  return getMap(state.config.mapId).tiles.get(hexKey(h));
}

export function unitAt(state: GameState, h: Hex): Unit | undefined {
  return state.units.find((u) => u.alive && hexEq(u.pos, h));
}

export function activeUnit(state: GameState): Unit | undefined {
  return state.turn ? state.units[state.turn.unit] : undefined;
}

export function hasStatus(u: Unit, id: StatusId): boolean {
  return u.statuses.some((s) => s.id === id);
}

function statusAmount(u: Unit, id: StatusId): number {
  return u.statuses.find((s) => s.id === id)?.amount ?? 0;
}

export function effectiveSpeed(u: Unit): number {
  const spd = defOf(u).stats.spd;
  return hasStatus(u, 'slow') ? Math.max(1, Math.floor(spd / 2)) : spd;
}

function enemyHazardAt(state: GameState, h: Hex, team: TeamId) {
  return state.hazards.find((z) => z.team !== team && hexEq(z.pos, h));
}

function walkable(t: Tile | undefined): t is Tile {
  return !!t && t.terrain !== 'blocked' && t.terrain !== 'void';
}

/** Terrain that stops sight between hexes of heights hA and hB: rock, or a wall 2+ above both. */
function blocksSight(t: Tile, hA: number, hB: number): boolean {
  return t.terrain === 'blocked' || t.h >= Math.max(hA, hB) + 2;
}

/**
 * Clear line of sight from `from` to `to`: no rock, no wall 2+ levels above
 * both ends, and (unless ignoreUnits) no unit of either team in between.
 * A line that runs exactly along hex edges is clear if either side is.
 */
export function hasLineOfSight(state: GameState, from: Hex, to: Hex, ignoreUnits = false): boolean {
  const hA = tileAt(state, from)?.h ?? 0;
  const hB = tileAt(state, to)?.h ?? 0;
  const clear = (line: Hex[]) =>
    line.slice(0, -1).every((h) => {
      const t = tileAt(state, h);
      if (!t) return true;
      if (blocksSight(t, hA, hB)) return false;
      return ignoreUnits || !unitAt(state, h);
    });
  return clear(hexLine(from, to, 1)) || clear(hexLine(from, to, -1));
}

export interface ReachNode {
  hex: Hex;
  cost: number;
  prev: string | null;
}

/**
 * Hexes the unit can move to this turn (Dijkstra over integer costs).
 * Allies can be passed through, enemies cannot. Entering an enemy spike
 * field ends movement there.
 */
export function reachable(state: GameState, u: Unit): Map<string, ReachNode> {
  const out = new Map<string, ReachNode>();
  for (const [k, n] of reachGraph(state, u)) if (n.cost > 0 && !unitAt(state, n.hex)) out.set(k, n);
  return out;
}

/** Full search graph, including ally-occupied hexes we can pass through. */
function reachGraph(state: GameState, u: Unit): Map<string, ReachNode> {
  const stats = defOf(u).stats;
  const startKey = hexKey(u.pos);
  const best = new Map<string, ReachNode>([[startKey, { hex: u.pos, cost: 0, prev: null }]]);
  const buckets: string[][] = [[startKey]];
  for (let c = 0; c < buckets.length; c++) {
    const bucket = buckets[c];
    if (!bucket) continue;
    for (const key of bucket) {
      const node = best.get(key)!;
      if (node.cost !== c) continue;
      if (c > 0 && enemyHazardAt(state, node.hex, u.team)) continue; // stopped by spikes
      const here = tileAt(state, node.hex)!;
      for (let d = 0; d < 6; d++) {
        const nh = hexAdd(node.hex, DIRS[d]);
        const t = tileAt(state, nh);
        if (!walkable(t)) continue;
        if (Math.abs(t.h - here.h) > stats.jump) continue;
        const occ = unitAt(state, nh);
        if (occ && occ.team !== u.team) continue;
        const cost = c + (t.terrain === 'rough' ? 2 : 1);
        if (cost > stats.move) continue;
        const nk = hexKey(nh);
        const prev = best.get(nk);
        if (prev && prev.cost <= cost) continue;
        best.set(nk, { hex: nh, cost, prev: key });
        (buckets[cost] ??= []).push(nk);
      }
    }
  }
  return best;
}

function pathTo(nodes: Map<string, ReachNode>, start: Hex, dest: Hex): Hex[] {
  const path: Hex[] = [];
  let k: string | null = hexKey(dest);
  while (k && k !== hexKey(start)) {
    const n: ReachNode = nodes.get(k)!;
    path.unshift(n.hex);
    k = n.prev;
  }
  return path;
}

/** Max range including the high-ground bonus (ranged abilities only). */
function rangeBonus(state: GameState, from: Hex, to: Hex, ab: AbilityDef): number {
  if (ab.maxRange < 2) return 0;
  const dh = (tileAt(state, from)?.h ?? 0) - (tileAt(state, to)?.h ?? 0);
  return dh >= 2 ? 1 : 0;
}

/** Where a leaping attacker lands next to `target`, or null if boxed in. */
export function leapLanding(state: GameState, caster: Unit, target: Hex): Hex | null {
  let best: Hex | null = null;
  let bestD = Infinity;
  for (let d = 0; d < 6; d++) {
    const h = neighbor(target, d as Dir);
    if (!walkable(tileAt(state, h))) continue;
    const occ = unitAt(state, h);
    if (occ && occ.id !== caster.id) continue;
    const dist = hexDistance(h, caster.pos);
    if (dist < bestD) {
      bestD = dist;
      best = h;
    }
  }
  return best;
}

function isOffensive(ab: AbilityDef): boolean {
  return ab.affects === 'enemies' || ab.affects === 'all';
}

/**
 * Every hex this unit could legally target with the ability right now.
 * Targets that are only illegal because of line of sight go into `blocked`.
 */
export function abilityTargets(state: GameState, u: Unit, abilityId: string, blocked?: Hex[]): Hex[] {
  const ab = getAbility(u.defId, abilityId);
  if ((u.cooldowns[abilityId] ?? 0) > 0) return [];
  if (ab.affects === 'self') return [u.pos];
  const out: Hex[] = [];
  const reach = ab.maxRange + 1; // +1 covers the high-ground bonus; filtered below
  for (const h of hexesInRadius(u.pos, reach)) {
    const t = tileAt(state, h);
    if (!t) continue;
    const dist = hexDistance(u.pos, h);
    if (dist < ab.minRange || dist > ab.maxRange + rangeBonus(state, u.pos, h, ab)) continue;
    if (ab.vertical !== undefined && ab.maxRange === 1) {
      const dh = Math.abs(t.h - tileAt(state, u.pos)!.h);
      if (dh > ab.vertical) continue;
    }
    const occ = unitAt(state, h);
    if (ab.needsEmptyTarget && occ) continue;
    if (ab.needsUnitTarget) {
      if (!occ) continue;
      if (ab.affects === 'enemies' && occ.team === u.team) continue;
      if (ab.affects === 'allies' && occ.team !== u.team) continue;
      if (occ.team !== u.team && hasStatus(occ, 'camo') && dist > 1) continue;
    }
    if (ab.affects === 'tiles' && !walkable(t)) continue;
    if (ab.effects.some((e) => e.kind === 'leap') && !leapLanding(state, u, h)) continue;
    if (ab.los && dist > 1 && !hasLineOfSight(state, u.pos, h)) {
      blocked?.push(h);
      continue;
    }
    out.push(h);
  }
  return out;
}

/** Hexes an ability's area covers when aimed at `target` from `from`. */
export function abilityArea(state: GameState, ab: AbilityDef, from: Hex, target: Hex): Hex[] {
  const area = ab.area;
  let hexes: Hex[];
  if (area.shape === 'single') hexes = [target];
  else if (area.shape === 'radius') hexes = hexesInRadius(target, area.radius);
  else {
    // Rays pierce units but stop at rock and at walls 2+ above the caster.
    const d = directionTo(from, target);
    const h0 = tileAt(state, from)?.h ?? 0;
    hexes = [];
    for (let i = 1; i <= area.length; i++) {
      const h = hexAdd(from, hexScale(DIRS[d], i));
      const t = tileAt(state, h);
      if (!t || blocksSight(t, h0, h0)) break;
      hexes.push(h);
    }
  }
  return hexes.filter((h) => !!tileAt(state, h));
}

function affectedUnits(state: GameState, caster: Unit, ab: AbilityDef, hexes: Hex[]): Unit[] {
  if (ab.affects === 'self') return [caster];
  if (ab.affects === 'tiles') return [];
  const out: Unit[] = [];
  for (const h of hexes) {
    const u = unitAt(state, h);
    if (!u) continue;
    if (ab.affects === 'enemies' && u.team === caster.team) continue;
    if (ab.affects === 'allies' && u.team !== caster.team) continue;
    out.push(u);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Combat math (shared by resolution, UI preview and AI)

export function attackArc(attackerPos: Hex, target: Unit): Arc {
  if (hexEq(attackerPos, target.pos)) return 'front';
  const d = directionTo(target.pos, attackerPos);
  const off = (d - target.facing + 6) % 6;
  if (off === 3) return 'rear';
  if (off === 2 || off === 4) return 'flank';
  return 'front';
}

export function hitChance(ab: AbilityDef, arc: Arc): number {
  if (ab.acc === undefined) return 10000;
  if (arc === 'rear') return 10000;
  const c = ab.acc + (arc === 'flank' ? 1500 : 0);
  return Math.max(0, Math.min(10000, c));
}

export function computeDamage(
  state: GameState,
  attacker: Unit,
  attackerPos: Hex,
  target: Unit,
  eff: Extract<Effect, { kind: 'damage' }>,
): { amount: number; arc: Arc } {
  const as = defOf(attacker).stats;
  const ts = defOf(target).stats;
  const stat = eff.stat === 'atk' ? as.atk : as.mag;
  let defStat = eff.stat === 'atk' ? ts.def : ts.res;
  if (eff.stat === 'atk' && hasStatus(target, 'fortify')) {
    defStat = Math.floor((defStat * (100 + statusAmount(target, 'fortify'))) / 100);
  }
  const raw = Math.floor((stat * eff.power * DAMAGE_SCALE) / 10000);
  let dmg = Math.floor((raw * 100) / (100 + 5 * defStat));
  const arc = attackArc(attackerPos, target);
  let mult = arc === 'rear' ? 150 + (eff.rearBonus ?? 0) : arc === 'flank' ? 125 : 100;
  const dh = (tileAt(state, attackerPos)?.h ?? 0) - (tileAt(state, target.pos)?.h ?? 0);
  mult += 10 * Math.max(-3, Math.min(3, dh));
  dmg = Math.floor((dmg * mult) / 100);
  return { amount: Math.max(1, dmg), arc };
}

export function computeHeal(caster: Unit, power: number): number {
  return Math.floor((defOf(caster).stats.mag * power) / 100);
}

export interface PreviewEntry {
  unit: number;
  chance: number; // basis points
  arc: Arc;
  damage: number;
  heal: number;
  effects: Effect[];
}

/**
 * What an ability would do if aimed at `target` now: per-unit hit chance,
 * damage and heal. Deterministic and RNG-free, so the UI can show "85%" and
 * the AI can plan on expected value without peeking at the next roll.
 */
export function previewAbility(state: GameState, u: Unit, abilityId: string, target: Hex): PreviewEntry[] {
  const ab = getAbility(u.defId, abilityId);
  let from = u.pos;
  if (ab.effects.some((e) => e.kind === 'leap')) from = leapLanding(state, u, target) ?? u.pos;
  const hexes = abilityArea(state, ab, u.pos, target);
  return affectedUnits(state, u, ab, hexes).map((t) => {
    const arc = attackArc(from, t);
    let damage = 0;
    let heal = 0;
    for (const e of ab.effects) {
      if (e.kind === 'damage') damage += computeDamage(state, u, from, t, e).amount;
      if (e.kind === 'heal') heal += computeHeal(u, e.power);
    }
    return { unit: t.id, chance: t.team !== u.team ? hitChance(ab, arc) : 10000, arc, damage, heal, effects: ab.effects };
  });
}

// ---------------------------------------------------------------------------
// Turn order preview (for the UI turn bar)

export type QueueEntry =
  | { kind: 'unit'; unit: number }
  | { kind: 'pulse' }
  | { kind: 'cast'; castId: number; unit: number; ability: string };

export function previewQueue(state: GameState, count: number): QueueEntry[] {
  const out: QueueEntry[] = [];
  if (state.winner !== null) return out;
  const units = state.units.filter((u) => u.alive).map((u) => ({ id: u.id, ct: u.ct, spd: effectiveSpeed(u) }));
  const casts = state.pending.map((p) => ({ ...p }));
  let pulseCt = state.pulseCt;
  if (state.turn) {
    out.push({ kind: 'unit', unit: state.turn.unit });
    const a = units.find((x) => x.id === state.turn!.unit)!;
    a.ct = Math.min(a.ct - CT_FULL, 60);
  }
  for (let guard = 0; out.length < count && guard < 10000; guard++) {
    const cast = casts.find((c) => c.charge >= CT_FULL);
    if (cast) {
      out.push({ kind: 'cast', castId: cast.id, unit: cast.caster, ability: cast.ability });
      casts.splice(casts.indexOf(cast), 1);
      continue;
    }
    if (pulseCt >= CT_FULL) {
      out.push({ kind: 'pulse' });
      pulseCt -= CT_FULL;
      continue;
    }
    const ready = pickReady(units);
    if (ready) {
      out.push({ kind: 'unit', unit: ready.id });
      ready.ct = Math.min(ready.ct - CT_FULL, 60);
      continue;
    }
    for (const c of casts) c.charge += c.speed;
    pulseCt += PULSE_SPEED;
    for (const x of units) x.ct += x.spd;
  }
  return out;
}

function pickReady<T extends { id: number; ct: number }>(units: T[]): T | undefined {
  let best: T | undefined;
  for (const u of units) {
    if (u.ct < CT_FULL) continue;
    if (!best || u.ct > best.ct || (u.ct === best.ct && u.id < best.id)) best = u;
  }
  return best;
}

// ---------------------------------------------------------------------------
// Applying actions

export class IllegalActionError extends Error {}

function fail(msg: string): never {
  throw new IllegalActionError(msg);
}

/** Apply one action, mutating `state`. Returns events for the renderer. */
export function applyAction(state: GameState, action: Action): GameEvent[] {
  const events: GameEvent[] = [];
  if (state.winner !== null) fail('Game is over');
  const turn = state.turn;
  if (!turn || turn.unit !== action.unit) fail('Not this unit\'s turn');
  const u = state.units[turn.unit];

  switch (action.type) {
    case 'move': {
      if (turn.moved) fail('Already moved');
      if (!reachable(state, u).has(hexKey(action.to))) fail('Destination not reachable');
      const path = pathTo(reachGraph(state, u), u.pos, action.to);
      const last = path.length >= 2 ? path[path.length - 2] : u.pos;
      u.facing = directionTo(last, action.to);
      u.pos = { ...action.to };
      turn.moved = true;
      events.push({ type: 'move', unit: u.id, path });
      const hz = enemyHazardAt(state, u.pos, u.team);
      if (hz) {
        events.push({ type: 'hazardHit', unit: u.id, amount: hz.damage });
        damageUnit(state, u, hz.damage, events);
      }
      break;
    }
    case 'ability': {
      if (turn.acted) fail('Already acted');
      const ab = getAbility(u.defId, action.ability);
      const legal = abilityTargets(state, u, ab.id);
      if (!legal.some((h) => hexEq(h, action.target))) fail('Illegal target');
      u.cooldowns[ab.id] = ab.cooldown > 0 ? ab.cooldown + 1 : 0;
      turn.acted = true;
      if (!hexEq(action.target, u.pos)) u.facing = directionTo(u.pos, action.target);
      if (isOffensive(ab)) removeStatus(u, 'camo');
      events.push({ type: 'abilityUsed', unit: u.id, ability: ab.id, target: action.target });
      if (ab.chargeSpeed) {
        const cast = {
          id: state.nextCastId++,
          caster: u.id,
          ability: ab.id,
          target: { ...action.target },
          charge: 0,
          speed: ab.chargeSpeed,
        };
        state.pending.push(cast);
        events.push({ type: 'castStart', cast: { ...cast } });
      } else {
        resolveAbility(state, u, ab, action.target, events);
      }
      break;
    }
    case 'end': {
      if (!(action.facing >= 0 && action.facing <= 5 && Number.isInteger(action.facing))) fail('Bad facing');
      u.facing = action.facing;
      events.push({ type: 'facing', unit: u.id, facing: u.facing });
      endTurn(state, u, events);
      break;
    }
    default:
      fail('Unknown action');
  }
  state.actionCount++;
  // If the active unit died mid-turn (spikes, thorns), its turn is over.
  if (state.turn && !state.units[state.turn.unit].alive && state.winner === null) {
    state.turn = null;
    advance(state, events);
  }
  return events;
}

function endTurn(state: GameState, u: Unit, events: GameEvent[]): void {
  const turn = state.turn!;
  // Beacon capture: end your turn on it with no enemy adjacent.
  const bi = state.beacons.findIndex((b) => hexEq(b.pos, u.pos));
  if (bi >= 0 && state.beacons[bi].owner !== u.team) {
    const contested = DIRS.some((d) => {
      const o = unitAt(state, hexAdd(u.pos, d));
      return o && o.team !== u.team;
    });
    if (!contested) {
      state.beacons[bi].owner = u.team;
      events.push({ type: 'capture', beacon: bi, team: u.team });
    }
  }
  for (const s of u.statuses) s.turns--;
  u.statuses = u.statuses.filter((s) => s.turns > 0);
  const cost = turn.moved && turn.acted ? 100 : turn.moved || turn.acted ? 80 : 60;
  u.ct = Math.min(u.ct - cost, 60);
  state.turn = null;
  advance(state, events);
}

/** Run the clock until a unit is ready for input or the game ends. */
function advance(state: GameState, events: GameEvent[]): void {
  for (let guard = 0; guard < 100000; guard++) {
    if (state.winner !== null) return;
    const cast = state.pending.find((c) => c.charge >= CT_FULL);
    if (cast) {
      state.pending.splice(state.pending.indexOf(cast), 1);
      const caster = state.units[cast.caster];
      const ab = getAbility(caster.defId, cast.ability);
      events.push({ type: 'castResolve', castId: cast.id, unit: caster.id, ability: ab.id, target: cast.target });
      resolveAbility(state, caster, ab, cast.target, events);
      continue;
    }
    if (state.pulseCt >= CT_FULL) {
      state.pulseCt -= CT_FULL;
      pulse(state, events);
      continue;
    }
    const ready = pickReady(state.units.filter((u) => u.alive));
    if (ready) {
      if (startTurn(state, ready, events)) return;
      continue;
    }
    state.tick++;
    state.hazards = state.hazards.filter((z) => z.expiresAt > state.tick);
    for (const c of state.pending) c.charge += c.speed;
    state.pulseCt += PULSE_SPEED;
    for (const u of state.units) if (u.alive) u.ct += effectiveSpeed(u);
  }
  throw new Error('Clock did not converge');
}

/** Returns true if the unit now awaits input. */
function startTurn(state: GameState, u: Unit, events: GameEvent[]): boolean {
  for (const k of Object.keys(u.cooldowns)) if (u.cooldowns[k] > 0) u.cooldowns[k]--;
  for (const s of u.statuses) {
    if (s.id === 'poison') {
      events.push({ type: 'statusTick', unit: u.id, status: 'poison', amount: s.amount });
      damageUnit(state, u, s.amount, events);
    } else if (s.id === 'regen') {
      const amt = Math.min(s.amount, u.maxHp - u.hp);
      u.hp += amt;
      events.push({ type: 'statusTick', unit: u.id, status: 'regen', amount: amt });
    }
  }
  if (!u.alive || state.winner !== null) return false;
  if (hasStatus(u, 'stun')) {
    removeStatus(u, 'stun');
    events.push({ type: 'stunned', unit: u.id });
    u.ct = Math.min(u.ct - 60, 60);
    return false;
  }
  state.turn = { unit: u.id, moved: false, acted: false };
  events.push({ type: 'turnStart', unit: u.id });
  return true;
}

function pulse(state: GameState, events: GameEvent[]): void {
  const gained: [number, number] = [0, 0];
  for (const b of state.beacons) if (b.owner !== null) gained[b.owner]++;
  state.score[0] += gained[0];
  state.score[1] += gained[1];
  state.pulses++;
  events.push({ type: 'pulse', score: [...state.score], gained });
  const [a, b] = state.score;
  if (Math.max(a, b) >= scoreToWin(state) && a !== b) setWinner(state, a > b ? 0 : 1, events);
  else if (state.pulses >= MAX_PULSES) setWinner(state, a === b ? 'draw' : a > b ? 0 : 1, events);
}

function setWinner(state: GameState, w: TeamId | 'draw', events: GameEvent[]): void {
  state.winner = w;
  state.turn = null;
  events.push({ type: 'gameOver', winner: w });
}

function damageUnit(state: GameState, u: Unit, amount: number, events: GameEvent[]): void {
  if (!u.alive) return;
  const shield = u.statuses.find((s) => s.id === 'shield');
  if (shield) {
    const absorbed = Math.min(shield.amount, amount);
    shield.amount -= absorbed;
    amount -= absorbed;
    if (absorbed > 0) events.push({ type: 'shieldAbsorb', unit: u.id, amount: absorbed });
    if (shield.amount <= 0) removeStatus(u, 'shield');
  }
  u.hp = Math.max(0, u.hp - amount);
  if (u.hp === 0) {
    u.alive = false;
    events.push({ type: 'ko', unit: u.id });
    for (const c of state.pending.filter((p) => p.caster === u.id)) {
      events.push({ type: 'castFizzle', castId: c.id });
    }
    state.pending = state.pending.filter((p) => p.caster !== u.id);
    for (const team of [0, 1] as TeamId[]) {
      if (!state.units.some((x) => x.team === team && x.alive)) {
        setWinner(state, team === 0 ? 1 : 0, events);
        return;
      }
    }
  }
}

function removeStatus(u: Unit, id: StatusId): void {
  u.statuses = u.statuses.filter((s) => s.id !== id);
}

function addStatus(u: Unit, id: StatusId, turns: number, amount: number, events: GameEvent[]): void {
  const existing = u.statuses.find((s) => s.id === id);
  if (existing) {
    existing.turns = Math.max(existing.turns, turns);
    existing.amount = Math.max(existing.amount, amount);
  } else {
    u.statuses.push({ id, turns, amount });
  }
  events.push({ type: 'statusAdd', unit: u.id, status: id });
}

/** Shove `u` up to `dist` hexes in direction `dir`. */
function displace(state: GameState, u: Unit, dir: Dir, dist: number, events: GameEvent[]): void {
  const path: Hex[] = [];
  for (let i = 0; i < dist; i++) {
    const next = hexAdd(u.pos, DIRS[dir]);
    const t = tileAt(state, next);
    const cur = tileAt(state, u.pos)!;
    if (!walkable(t) || unitAt(state, next) || t.h - cur.h > 1) {
      if (path.length) events.push({ type: 'displace', unit: u.id, path: [...path] });
      events.push({ type: 'collision', unit: u.id, amount: COLLISION_DAMAGE });
      damageUnit(state, u, COLLISION_DAMAGE, events);
      return;
    }
    u.pos = next;
    path.push(next);
    const hz = enemyHazardAt(state, next, u.team);
    if (hz) {
      events.push({ type: 'displace', unit: u.id, path: [...path] });
      events.push({ type: 'hazardHit', unit: u.id, amount: hz.damage });
      damageUnit(state, u, hz.damage, events);
      return;
    }
  }
  if (path.length) events.push({ type: 'displace', unit: u.id, path });
}

function resolveAbility(state: GameState, caster: Unit, ab: AbilityDef, target: Hex, events: GameEvent[]): void {
  if (!caster.alive) return;
  if (ab.effects.some((e) => e.kind === 'leap')) {
    const land = leapLanding(state, caster, target);
    if (land && !hexEq(land, caster.pos)) {
      caster.pos = land;
      events.push({ type: 'displace', unit: caster.id, path: [land] });
    }
    caster.facing = directionTo(caster.pos, target);
  }
  const hexes = abilityArea(state, ab, caster.pos, target);
  for (const e of ab.effects) {
    if (e.kind !== 'hazard') continue;
    const tiles = hexes.filter((h) => walkable(tileAt(state, h)));
    state.hazards = state.hazards.filter((z) => !tiles.some((h) => hexEq(h, z.pos)));
    for (const h of tiles) {
      state.hazards.push({ pos: h, team: caster.team, damage: e.damage, expiresAt: state.tick + e.ticks });
    }
    events.push({ type: 'hazardPlaced', tiles, team: caster.team });
  }
  for (const t of affectedUnits(state, caster, ab, hexes)) {
    if (!t.alive || !caster.alive) continue;
    const hostile = t.team !== caster.team;
    const arc = attackArc(caster.pos, t);
    if (hostile && ab.acc !== undefined) {
      if (rollBp(state.rng) >= hitChance(ab, arc)) {
        events.push({ type: 'miss', unit: t.id, source: caster.id });
        continue;
      }
    }
    for (const e of ab.effects) {
      if (!t.alive) break;
      switch (e.kind) {
        case 'damage': {
          const { amount } = computeDamage(state, caster, caster.pos, t, e);
          events.push({ type: 'hit', unit: t.id, source: caster.id, amount, arc });
          damageUnit(state, t, amount, events);
          if (hostile && hexDistance(caster.pos, t.pos) === 1 && hasStatus(t, 'thorns') && caster.alive) {
            const thorns = statusAmount(t, 'thorns');
            events.push({ type: 'hit', unit: caster.id, source: t.id, amount: thorns, arc: 'front' });
            damageUnit(state, caster, thorns, events);
          }
          break;
        }
        case 'heal': {
          const amt = Math.min(computeHeal(caster, e.power), t.maxHp - t.hp);
          t.hp += amt;
          events.push({ type: 'heal', unit: t.id, amount: amt });
          break;
        }
        case 'push':
          displace(state, t, directionTo(caster.pos, t.pos), e.dist, events);
          break;
        case 'pull': {
          // Pull stops one hex short of the caster (the caster's hex is occupied).
          const steps = Math.min(e.dist, hexDistance(caster.pos, t.pos) - 1);
          if (steps > 0) displace(state, t, directionTo(t.pos, caster.pos), steps, events);
          break;
        }
        case 'status':
          addStatus(t, e.status, e.turns, e.amount ?? 0, events);
          break;
        case 'ctShift':
          t.ct = Math.max(0, t.ct + e.amount);
          events.push({ type: 'ctShift', unit: t.id, amount: e.amount });
          break;
        case 'cleanse':
          t.statuses = t.statuses.filter((s) => s.id !== 'slow' && s.id !== 'stun' && s.id !== 'poison');
          break;
        case 'hazard':
        case 'leap':
          break;
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Utilities

/** Units still standing on a team. */
export const aliveOn = (state: GameState, team: TeamId): Unit[] =>
  state.units.filter((u) => u.alive && u.team === team);

export function newConfig(
  seed: string,
  teams: [string[], string[]],
  mapId = 'arena',
  ai?: [StrategyId | null, StrategyId | null],
): MatchConfig {
  return ai ? { rulesVersion: RULES_VERSION, seed, mapId, teams, ai } : { rulesVersion: RULES_VERSION, seed, mapId, teams };
}
