// What an order-following agent can see. Everything here is derived from
// information the player's own screen shows: the board, unit cards, the turn
// bar, ability lists with hit % / damage previews, and sight lines. It never
// reads the RNG state, enemy cooldowns, or anything the scripted AI computes.

import {
  abilityArea,
  abilityTargets,
  aliveOn,
  applyAction,
  defOf,
  previewAbility,
  previewQueue,
  reachable,
  scoreToWin,
  tileAt,
} from '../core/engine';
import { directionTo, hexDistance, hexEq, type Dir, type Hex } from '../core/hex';
import { getMap } from '../core/map';
import { getAbility, MONSTER_BY_ID } from '../core/monsters';
import type { GameEvent, GameState, Unit } from '../core/types';

export const DIR_NAMES = ['E', 'NE', 'NW', 'W', 'SW', 'SE'] as const;
export type DirName = (typeof DIR_NAMES)[number];

const SIDE = ['Blue', 'Orange'];
export const hx = (h: Hex) => `(${h.q},${h.r})`;
export const unitName = (u: Unit) => `${MONSTER_BY_ID[u.defId].name} #${u.id}`;
const pct = (bp: number) => `${Math.round(bp / 100)}%`;

function statusText(u: Unit): string {
  return u.statuses.map((s) => `${s.id}${s.amount ? ' ' + s.amount : ''} (${s.turns} turn${s.turns === 1 ? '' : 's'})`).join(', ');
}

function beaconLabel(state: GameState, h: Hex): string {
  const i = state.beacons.findIndex((b) => hexEq(b.pos, h));
  return i >= 0 ? ` [Beacon B${i + 1}]` : '';
}

/** One line per unit, as its card shows it. Cooldowns are shown only for your own team. */
function unitLine(state: GameState, u: Unit, viewer: Unit): string {
  const def = defOf(u);
  const t = tileAt(state, u.pos);
  const parts = [
    `${unitName(u)} (${def.role}) at ${hx(u.pos)} h${t?.h ?? 0}${beaconLabel(state, u.pos)}`,
    `HP ${u.hp}/${u.maxHp}`,
    `facing ${DIR_NAMES[u.facing]}`,
  ];
  const st = statusText(u);
  if (st) parts.push(`statuses: ${st}`);
  if (u.id !== viewer.id) parts.push(`${hexDistance(u.pos, viewer.pos)} hexes ${DIR_NAMES[directionTo(viewer.pos, u.pos)]} of you`);
  if (u.team === viewer.team) {
    const cds = Object.entries(u.cooldowns).filter(([, v]) => v > 0).map(([k, v]) => `${k} ${v}`);
    if (cds.length) parts.push(`cooldowns: ${cds.join(', ')}`);
  }
  return parts.join(', ');
}

/** The turn bar: who acts next, Pulses and charging abilities. */
function queueLine(state: GameState, viewer: Unit): string {
  return previewQueue(state, 10)
    .map((e) => {
      if (e.kind === 'pulse') return 'PULSE';
      const u = state.units[e.unit];
      const who = `${MONSTER_BY_ID[u.defId].name.split(' ')[1]}#${u.id}${u.team === viewer.team ? '' : '(enemy)'}`;
      return e.kind === 'cast' ? `${who} casts ${getAbility(u.defId, e.ability).name}` : who;
    })
    .join(' → ');
}

/**
 * What each ability can do from the unit's current position: targets with
 * hit chance, damage and arc (the same preview the player sees before
 * confirming), plus targets in range but out of sight.
 */
export function describeAbilities(state: GameState, u: Unit): string {
  const lines: string[] = [];
  for (const ab of defOf(u).abilities) {
    const cd = u.cooldowns[ab.id] ?? 0;
    const head = `- ${ab.id} "${ab.name}": ${ab.desc}`;
    if (state.turn?.acted) {
      lines.push(`${head} (you already acted this turn)`);
      continue;
    }
    if (cd > 0) {
      lines.push(`${head} ON COOLDOWN for ${cd} more turn${cd === 1 ? '' : 's'}.`);
      continue;
    }
    const blocked: Hex[] = [];
    const targets = abilityTargets(state, u, ab.id, blocked);
    const range = ab.maxRange === 0 ? 'self' : `range ${ab.minRange}-${ab.maxRange}`;
    const meta = [range, ab.chargeSpeed ? 'charges first (resolves later on the target hex)' : '', ab.los ? 'needs line of sight' : '']
      .filter(Boolean)
      .join(', ');
    const scored = targets
      .map((h) => {
        const rows = previewAbility(state, u, ab.id, h);
        const value = rows.reduce((s, r) => {
          const t = state.units[r.unit];
          return s + (t.team !== u.team ? (r.damage * r.chance) / 10000 : r.heal + 5);
        }, 0);
        const what = rows
          .map((r) => {
            const t = state.units[r.unit];
            const bits = [unitName(t)];
            if (r.damage) bits.push(`${r.damage} dmg`);
            if (r.heal) bits.push(`+${r.heal} heal`);
            else if (t.team === u.team && ab.effects.some((e) => e.kind === 'heal')) bits.push('already at full HP: heals nothing');
            if (t.team !== u.team) bits.push(`${pct(r.chance)} hit`, `${r.arc}`);
            if (t.team !== u.team && r.damage >= t.hp) bits.push('WOULD KO');
            return bits.join(' ');
          })
          .join('; ');
        return { h, rows, value, what };
      })
      .filter((x) => x.rows.length || ab.affects === 'tiles' || ab.affects === 'self');
    if (!targets.length) {
      lines.push(`${head} [${meta}] no legal targets now${blocked.length ? ` (out of sight: ${blocked.map(hx).join(' ')})` : ''}.`);
      continue;
    }
    if (ab.affects === 'tiles') {
      const near = targets
        .map((h) => ({ h, d: Math.min(...aliveOn(state, u.team === 0 ? 1 : 0).map((e) => hexDistance(e.pos, h)), 99) }))
        .sort((a, b) => a.d - b.d)
        .slice(0, 6);
      lines.push(`${head} [${meta}] ${targets.length} valid hexes; closest to enemies: ${near.map((n) => hx(n.h) + beaconLabel(state, n.h)).join(' ')}.`);
      continue;
    }
    const best = scored.sort((a, b) => b.value - a.value).slice(0, 6);
    const list = best.map((x) => `${hx(x.h)} → ${x.what || 'no one affected'}`).join(' | ');
    const more = scored.length > best.length ? ` (+${scored.length - best.length} more)` : '';
    const hidden = blocked.length ? ` Out of sight: ${blocked.map(hx).join(' ')}.` : '';
    lines.push(`${head} [${meta}] targets: ${list || 'none useful'}${more}.${hidden}`);
  }
  return lines.join('\n');
}

function turnMoves(state: GameState, u: Unit): Hex[] {
  return state.turn?.moved ? [] : [...reachable(state, u).values()].map((n) => n.hex);
}

export interface IncomingCast {
  hexes: Hex[];
  hostile: boolean;
  /** Lands before `viewer` acts again. */
  beforeNextTurn: boolean;
  line: string;
}

/**
 * Charged abilities waiting to go off, where they land and when: the same
 * areas the board shows the player. Enemy damage areas are danger zones.
 */
export function incomingCasts(state: GameState, viewer: Unit): IncomingCast[] {
  const queue = previewQueue(state, 24);
  // The viewer's next turn: its first entry after the current one (if it is acting now).
  const start = state.turn?.unit === viewer.id ? 1 : 0;
  const nextTurn = queue.findIndex((e, i) => i >= start && e.kind === 'unit' && e.unit === viewer.id);
  return state.pending.map((c) => {
    const caster = state.units[c.caster];
    const ab = getAbility(caster.defId, c.ability);
    const hexes = abilityArea(state, ab, caster.pos, c.target);
    const hostile = caster.team !== viewer.team && (ab.affects === 'enemies' || ab.affects === 'all');
    const at = queue.findIndex((e) => e.kind === 'cast' && e.castId === c.id);
    const unitTurnsFirst = queue.slice(0, at < 0 ? queue.length : at).filter((e) => e.kind === 'unit').length;
    const beforeNextTurn = at >= 0 && (nextTurn < 0 || at < nextTurn);
    const who = `${unitName(caster)}'s ${ab.name}`;
    const when = beforeNextTurn ? 'BEFORE your next turn' : 'after your next turn';
    const line = `${hostile ? 'DANGER: enemy' : caster.team === viewer.team ? 'Friendly' : 'Enemy'} ${who} lands on ${hexes.map(hx).join(' ')} after ${unitTurnsFirst} more unit turn${unitTurnsFirst === 1 ? '' : 's'} (${when}).`;
    return { hexes, hostile, beforeNextTurn, line };
  });
}

const dangerAt = (casts: IncomingCast[], h: Hex) => casts.find((c) => c.hostile && c.beforeNextTurn && c.hexes.some((x) => hexEq(x, h)));

/** Hexes the unit can move to (as highlighted in blue), with notable features. */
export function describeMoves(state: GameState, u: Unit): string {
  if (state.turn?.moved) return 'You already moved this turn.';
  const nodes = [...reachable(state, u).values()];
  if (!nodes.length) return 'No reachable hexes.';
  const mapTiles = getMap(state.config.mapId, state.config.rulesVersion).tiles;
  const casts = incomingCasts(state, u);
  return nodes
    .map((n) => {
      const t = mapTiles.get(`${n.hex.q},${n.hex.r}`)!;
      const spikes = state.hazards.some((z) => z.team !== u.team && hexEq(z.pos, n.hex)) ? ' [enemy spikes!]' : '';
      const blast = dangerAt(casts, n.hex) ? ' [in incoming blast!]' : '';
      return `${hx(n.hex)}h${t.h}${beaconLabel(state, n.hex)}${spikes}${blast}`;
    })
    .join(' ');
}

/** Which enemies could reach a hex next turn: what the player sees by counting moves. */
export function threatsAt(state: GameState, u: Unit, h: Hex): string {
  const blast = dangerAt(incomingCasts(state, u), h);
  const warn = blast ? `${hx(h)} is inside an incoming enemy blast that lands before your next turn. ` : '';
  return warn + threatsAtInner(state, u, h);
}

function threatsAtInner(state: GameState, u: Unit, h: Hex): string {
  const foes = aliveOn(state, u.team === 0 ? 1 : 0).filter((e) => {
    const d = defOf(e);
    const reach = d.stats.move + Math.max(...d.abilities.map((a) => a.maxRange));
    return hexDistance(e.pos, h) <= reach;
  });
  return foes.length ? `Enemies that could reach ${hx(h)} next turn: ${foes.map(unitName).join(', ')}.` : `No enemy can reach ${hx(h)} next turn.`;
}

/** Look at a hex as if moved there (the player can do the same with move + undo; moving uses no randomness). */
export function describeFrom(state: GameState, u: Unit, to: Hex): string {
  const s = structuredClone(state);
  applyAction(s, { type: 'move', unit: u.id, to });
  const su = s.units[u.id];
  if (!su.alive) return `Moving to ${hx(to)} would KO you (enemy spikes).`;
  const hurt = u.hp - su.hp;
  return [
    `From ${hx(to)} h${tileAt(s, to)?.h ?? 0}${beaconLabel(s, to)}${hurt ? ` (you would take ${hurt} spike damage getting there)` : ''}:`,
    describeAbilities(s, su),
    threatsAt(s, su, to),
  ].join('\n');
}

const SQRT3 = Math.sqrt(3);

/**
 * Names for each Beacon as one side sees the map: "center", "home",
 * "enemy home", or "left/right flank" (left as seen from that side's spawn).
 * Players say "hold the center Beacon"; these names let the agent match that.
 */
export function beaconNames(state: GameState, team: 0 | 1): string[] {
  const map = getMap(state.config.mapId, state.config.rulesVersion).def;
  const near = (h: Hex, spawns: Hex[]) => Math.min(...spawns.map((s) => hexDistance(h, s)));
  // Lean > 0: closer to our spawn. Only the single most one-sided Beacon per side is a "home".
  const lean = state.beacons.map((b) => near(b.pos, map.spawns[team === 0 ? 1 : 0]) - near(b.pos, map.spawns[team]));
  const homeIdx = lean.indexOf(Math.max(...lean));
  const enemyIdx = lean.indexOf(Math.min(...lean));
  const names = state.beacons.map((b, i) => {
    if (b.pos.q === 0 && b.pos.r === 0) return 'center';
    if (i === homeIdx && lean[i] >= 2) return 'home';
    if (i === enemyIdx && lean[i] <= -2) return 'enemy home';
    const x = SQRT3 * (b.pos.q + b.pos.r / 2);
    // Team 0 spawns at the bottom of the board looking up; Team 1 looks down, so its left is mirrored.
    return (team === 0 ? x < 0 : x > 0) ? 'left flank' : 'right flank';
  });
  // Disambiguate any repeats (e.g. two left-flank Beacons on a lane map).
  return names.map((n, i) => (names.filter((m) => m === n).length > 1 ? `${n} ${names.slice(0, i + 1).filter((m) => m === n).length}` : n));
}

/** One line listing the map's Beacons by name, and which common names it lacks. */
export function beaconSummary(state: GameState, team: 0 | 1): string {
  const names = beaconNames(state, team);
  const missing = ['center', 'home', 'enemy home'].filter((n) => !names.includes(n));
  return `This map has ${names.length} Beacons: ${names.map((n, i) => `B${i + 1} = ${n}`).join(', ')}.${missing.length ? ` It has no ${missing.join(' or ')} Beacon; if an order names one, use the closest match.` : ''}`;
}

export interface Orders {
  [unitId: number]: string;
}

/** The per-turn briefing: the full board as the player sees it, plus this unit's orders and options. */
export function turnBriefing(state: GameState, unitId: number, orders: Orders, recent: string[]): string {
  const u = state.units[unitId];
  const map = getMap(state.config.mapId, state.config.rulesVersion).def;
  const my = u.team;
  const foe = my === 0 ? 1 : 0;
  const moves = turnMoves(state, u);
  const names = beaconNames(state, my);
  const held = [state.beacons.filter((b) => b.owner === my).length, state.beacons.filter((b) => b.owner === foe).length];
  const target = scoreToWin(state);
  const pressure =
    held[1] > held[0]
      ? `The enemy holds more Beacons (${held[1]} vs ${held[0]}): at this rate they reach ${target} in about ${Math.ceil((target - state.score[foe]) / held[1])} Pulses. Taking or contesting a Beacon matters.`
      : held[0] > held[1]
        ? `We hold more Beacons (${held[0]} vs ${held[1]}).`
        : `Beacons are even (${held[0]} each).`;
  const beacons = state.beacons
    .map((b, i) => {
      const d = hexDistance(u.pos, b.pos);
      const owner = b.owner === null ? 'neutral' : b.owner === my ? 'ours' : 'THEIRS';
      const holder = state.units.find((x) => x.alive && hexEq(x.pos, b.pos));
      const on = holder ? `, ${unitName(holder)} on it` : '';
      let toward = '';
      if (d > 0 && moves.length) {
        const best = moves.reduce((a, h) => (hexDistance(h, b.pos) < hexDistance(a, b.pos) ? h : a));
        const left = hexDistance(best, b.pos);
        toward = left === 0 ? ', you can reach it this turn' : `, closest you can get this turn: ${hx(best)} (${left} away)`;
      }
      return `B${i + 1} (${names[i]}) ${hx(b.pos)} h${tileAt(state, b.pos)?.h ?? 0}: ${owner}${on}; ${d === 0 ? 'you are on it' : `${d} hexes from you`}${toward}`;
    })
    .join('\n');
  const teammates = aliveOn(state, my).filter((x) => x.id !== u.id);
  const fallen = state.units.filter((x) => !x.alive).map((x) => `${unitName(x)} (${x.team === my ? 'ours' : 'enemy'})`);
  const spikes = state.hazards.filter((z) => z.team !== my).map((z) => hx(z.pos));
  const turn = state.turn!;
  return [
    `# Situation`,
    `Map: ${map.name} (${map.teamSize}v${map.teamSize}). Score: us ${state.score[my]}, enemy ${state.score[foe]}; first to ${scoreToWin(state)}. Each Pulse scores 1 per Beacon held.`,
    beaconSummary(state, my),
    ...incomingCasts(state, u).map((c) => c.line),
    `Beacons:\n${beacons}`,
    pressure,
    `Turn order: ${queueLine(state, u)}.`,
    spikes.length ? `Enemy spike fields (entering costs 14 HP and stops you): ${spikes.join(' ')}.` : '',
    fallen.length ? `Knocked out (permanent): ${fallen.join(', ')}.` : '',
    ``,
    `# You`,
    unitLine(state, u, u),
    `Stats: ${Object.entries(defOf(u).stats).map(([k, v]) => `${k.toUpperCase()} ${v}`).join(' ')}.`,
    `YOUR ORDER: "${orders[u.id]?.trim() || '(none)'}"`,
    `This turn so far: ${turn.moved ? 'moved' : 'not moved'}, ${turn.acted ? 'acted' : 'not acted'}.`,
    ``,
    `# Teammates and their orders`,
    teammates.length ? teammates.map((t) => `- ${unitLine(state, t, u)}. Order: "${orders[t.id]?.trim() || '(none)'}"`).join('\n') : '(none left)',
    ``,
    `# Enemies (${SIDE[foe]} team)`,
    aliveOn(state, foe).map((e) => `- ${unitLine(state, e, u)}`).join('\n'),
    ``,
    `# Recent events`,
    recent.length ? recent.map((r) => `- ${r}`).join('\n') : '(start of match)',
    ``,
    `# Your options right now`,
    `Moves: ${describeMoves(state, u)}`,
    `Abilities from ${hx(u.pos)}:`,
    describeAbilities(state, u),
    threatsAt(state, u, u.pos),
  ]
    .filter((l) => l !== '')
    .join('\n');
}

/** Plain-language summary of what an action did, for tool results and the feed. */
export function summarizeEvents(state: GameState, events: GameEvent[]): string[] {
  const name = (id: number) => unitName(state.units[id]);
  const out: string[] = [];
  for (const e of events) {
    switch (e.type) {
      case 'move': out.push(`${name(e.unit)} moved to ${hx(e.path[e.path.length - 1])}`); break;
      case 'abilityUsed': out.push(`${name(e.unit)} used ${getAbility(state.units[e.unit].defId, e.ability).name} at ${hx(e.target)}`); break;
      case 'castStart': out.push(`${name(e.cast.caster)} started charging ${getAbility(state.units[e.cast.caster].defId, e.cast.ability).name} on ${hx(e.cast.target)}`); break;
      case 'castResolve': out.push(`${name(e.unit)}'s ${getAbility(state.units[e.unit].defId, e.ability).name} went off at ${hx(e.target)}`); break;
      case 'castFizzle': out.push('A charging ability fizzled'); break;
      case 'hit': out.push(`${name(e.unit)} took ${e.amount}${e.arc === 'front' ? '' : ` (${e.arc})`}, HP now ${Math.max(0, state.units[e.unit].hp)}`); break;
      case 'miss': out.push(`missed ${name(e.unit)}`); break;
      case 'heal': out.push(`${name(e.unit)} healed ${e.amount}`); break;
      case 'shieldAbsorb': out.push(`${name(e.unit)}'s shield absorbed ${e.amount}`); break;
      case 'displace': out.push(`${name(e.unit)} was moved to ${hx(e.path[e.path.length - 1])}`); break;
      case 'collision': out.push(`${name(e.unit)} slammed into something for ${e.amount}`); break;
      case 'hazardHit': out.push(`${name(e.unit)} hit spikes for ${e.amount}`); break;
      case 'statusAdd': out.push(`${name(e.unit)} gained ${e.status}`); break;
      case 'statusTick': if (e.amount) out.push(`${name(e.unit)} ${e.status === 'poison' ? 'took' : 'regenerated'} ${e.amount} from ${e.status}`); break;
      case 'stunned': out.push(`${name(e.unit)} was stunned and lost its turn`); break;
      case 'ctShift': out.push(`${name(e.unit)}'s next turn was delayed`); break;
      case 'hazardPlaced': out.push(`spikes placed on ${e.tiles.length} hexes`); break;
      case 'ko': out.push(`${name(e.unit)} was KNOCKED OUT`); break;
      case 'capture': out.push(`${SIDE[e.team]} captured Beacon B${e.beacon + 1}`); break;
      case 'pulse': out.push(`Pulse: score Blue ${e.score[0]}, Orange ${e.score[1]}`); break;
      case 'gameOver': out.push(e.winner === 'draw' ? 'The match ended in a draw' : `${SIDE[e.winner]} won the match`); break;
      case 'facing':
      case 'turnStart':
        break;
    }
  }
  return out;
}

export const dirFromName = (n: string): Dir | null => {
  const i = DIR_NAMES.indexOf(n as DirName);
  return i >= 0 ? (i as Dir) : null;
};
