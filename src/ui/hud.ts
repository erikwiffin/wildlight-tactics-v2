// Shared HUD pieces: unit icons, the unit sheet, the rules legend, threat
// ranges, the default facing and battle-log lines. Display only: nothing here
// feeds back into the rules.

import { attackArc, defOf, reachable, scoreToWin } from '../core/engine';
import { hexDistance, hexKey, type Dir, type Hex } from '../core/hex';
import { getMap } from '../core/map';
import { MONSTER_BY_ID } from '../core/monsters';
import type { AbilityDef, GameEvent, GameState, Unit } from '../core/types';
import { STATUS_ICON, UNIT_ICON } from '../render/view';
import { esc, modal } from './dom';

/** Short side label: "Blue · Aggressive" → "Blue", "Balanced AI" → "AI", "You" → "You". */
export const shortSide = (name: string) => name.split(' · ')[0].replace(/^\w+ AI$/, 'AI');

export const icon = (defId: string) => UNIT_ICON[defId] ?? '❔';

export function rangeText(ab: AbilityDef): string {
  if (ab.maxRange === 0) return 'self';
  return ab.minRange === ab.maxRange ? `range ${ab.maxRange}` : `range ${ab.minRange}–${ab.maxRange}`;
}

/** Full details for a species (and a live unit, if given): stats and abilities. */
export function showUnitSheet(defId: string, u?: Unit): void {
  const def = MONSTER_BY_ID[defId];
  const s = def.stats;
  const stat = (k: string, v: number | string, tip: string) => `<div title="${tip}"><span>${k}</span><b>${v}</b></div>`;
  const statuses = u?.statuses.length
    ? `<div class="sheet-status">${u.statuses.map((x) => `${STATUS_ICON[x.id]} ${x.id} · ${x.turns} turn${x.turns === 1 ? '' : 's'}`).join('<br>')}</div>`
    : '';
  const abilities = def.abilities
    .map((ab) => {
      const cd = u?.cooldowns[ab.id] ?? 0;
      const tags = [rangeText(ab), ab.cooldown ? `cooldown ${ab.cooldown}` : '', ab.chargeSpeed ? 'charges' : '', ab.los ? 'needs sight' : '']
        .filter(Boolean)
        .join(' · ');
      return `<div class="sheet-ab"><div><b>${esc(ab.name)}</b>${cd ? ` <span class="warn">ready in ${cd}</span>` : ''}</div><div class="hint">${tags}</div><div>${esc(ab.desc)}</div></div>`;
    })
    .join('');
  const close = modal(
    `
    <div class="sheet-head"><span class="sheet-icon">${icon(defId)}</span><div><h2>${esc(def.name)}</h2><div class="hint">${def.role}${u ? ` · ${u.hp}/${u.maxHp} HP` : ''}</div></div></div>
    <p class="sheet-blurb">${esc(def.blurb)}</p>
    ${statuses}
    <div class="sheet-stats">
      ${stat('HP', u ? `${u.hp}` : s.hp, 'Hit points')}${stat('ATK', s.atk, 'Physical damage')}${stat('DEF', s.def, 'Reduces physical damage')}${stat('MAG', s.mag, 'Magic damage and healing')}
      ${stat('RES', s.res, 'Reduces magic damage')}${stat('SPD', s.spd, 'How fast CT fills: more turns')}${stat('MOV', s.move, 'Hexes per move')}${stat('JMP', s.jump, 'Height it can climb per step')}
    </div>
    <div class="sheet-abs">${abilities}</div>
    <button data-a="close" class="primary">Close</button>`,
    { close: () => close() },
  );
}

export function showHelp(state?: GameState): void {
  const target = state ? scoreToWin(state) : null;
  const statuses: [string, string][] = [
    ['slow', 'Speed halved: fewer turns.'],
    ['stun', 'Skips its next turn.'],
    ['poison', 'Loses HP each turn.'],
    ['regen', 'Heals each turn.'],
    ['shield', 'Absorbs damage first.'],
    ['thorns', 'Melee attackers take damage.'],
    ['camo', "Can't be targeted from more than 1 hex away."],
    ['fortify', 'DEF raised.'],
  ];
  const close = modal(
    `
    <h2>How to play</h2>
    <div class="help">
      <section><h3>Win</h3>
        <p>Capture Beacons: end a turn on one with no enemy next to you. Every <b>⚡ Pulse</b> scores 1 point per Beacon you hold. First to <b>${target ?? 'the map target'}</b> wins, or wipe out the other team.</p></section>
      <section><h3>Turn order</h3>
        <p>The strip along the edge is the turn queue, soonest first. Faster units (SPD) come up more often. <b>⚡</b> marks the next Pulse; dashed chips are charging abilities about to go off. Tap a chip to find that unit.</p></section>
      <section><h3>Your turn</h3>
        <p><b>Move</b> and <b>Act</b> once each, in either order, then <b>End turn</b> and pick a facing. The safest facing is pre-selected. You can undo a move until you act.</p></section>
      <section><h3>Facing</h3>
        <p>Hits from the side (<b>flank</b>) do +25% damage and are more accurate. Hits from behind (<b>rear</b>) do +50% and never miss. High ground adds +10% per level.</p></section>
      <section><h3>Sight and charging</h3>
        <p>Direct shots need a clear line: rocks, walls and any unit in the way block them. Arcing and support abilities ignore that. Charging abilities go off later; their area pulses on the board so you can step out.</p></section>
      <section><h3>Reading the board</h3>
        <p>Tap any unit to see its card; tap an enemy to also see where it can move (orange) and hit (red) next turn. <b>ⓘ</b> on a card shows full stats and abilities. Board buttons: <b>⟲ ⟳</b> rotate, <b>⌖</b> auto zoom, <b>☷</b> battle log. Pinch or scroll to zoom, drag to pan.</p></section>
      <section><h3>Status effects</h3>
        <ul class="help-status">${statuses.map(([id, d]) => `<li><span>${STATUS_ICON[id]}</span><b>${id}</b> ${d}</li>`).join('')}</ul></section>
    </div>
    <button data-a="close" class="primary">Got it</button>`,
    { close: () => close() },
  );
}

/** Where an enemy could move next turn, and the extra hexes it could hit from there. */
export function threat(state: GameState, u: Unit): { move: Hex[]; hit: Hex[] } {
  const move = [...reachable(state, u).values()].map((n) => n.hex);
  const reach = Math.max(0, ...defOf(u).abilities.filter((a) => a.effects.some((e) => e.kind === 'damage')).map((a) => a.maxRange));
  const from = [u.pos, ...move];
  const moveKeys = new Set(move.map(hexKey));
  const hit: Hex[] = [];
  for (const t of getMap(state.config.mapId, state.config.rulesVersion).def.tiles) {
    if (t.terrain === 'blocked' || moveKeys.has(hexKey(t)) || hexDistance(t, u.pos) === 0) continue;
    if (from.some((f) => hexDistance(f, t) <= reach)) hit.push(t);
  }
  return { move, hit };
}

/**
 * The facing that exposes the least back and side to the enemies most likely
 * to reach this unit. Ties keep the current facing.
 */
export function safestFacing(state: GameState, u: Unit): Dir {
  const enemies = state.units.filter((e) => e.alive && e.team !== u.team);
  let best = u.facing;
  let bestCost = Infinity;
  for (let i = 0; i < 6; i++) {
    const d = ((u.facing + i) % 6) as Dir;
    const probe = { ...u, facing: d };
    let cost = 0;
    for (const e of enemies) {
      const arc = attackArc(e.pos, probe);
      const w = arc === 'rear' ? 3 : arc === 'flank' ? 1 : 0;
      cost += w / Math.max(1, hexDistance(e.pos, u.pos));
    }
    if (cost < bestCost - 1e-9) {
      bestCost = cost;
      best = d;
    }
  }
  return best;
}

/** One readable battle-log line per meaningful event, or null to skip it. */
export function logLine(state: GameState, e: GameEvent, sides: [string, string]): string | null {
  const team = (t: 0 | 1) => shortSide(sides[t]);
  const n = (id: number) => `${icon(state.units[id].defId)} ${MONSTER_BY_ID[state.units[id].defId].name}`;
  const ab = (id: number, ability: string) => defOf(state.units[id]).abilities.find((a) => a.id === ability)?.name ?? ability;
  switch (e.type) {
    case 'abilityUsed': return `${n(e.unit)} used ${ab(e.unit, e.ability)}`;
    case 'castStart': return `${n(e.cast.caster)} is charging ${ab(e.cast.caster, e.cast.ability)}`;
    case 'castResolve': return `${n(e.unit)}'s ${ab(e.unit, e.ability)} went off`;
    case 'castFizzle': return 'A charging ability fizzled';
    case 'hit': return `  ${n(e.unit)} took ${e.amount}${e.arc === 'front' ? '' : ` (${e.arc})`}`;
    case 'miss': return `  missed ${n(e.unit)}`;
    case 'heal': return `  ${n(e.unit)} healed ${e.amount}`;
    case 'shieldAbsorb': return `  ${n(e.unit)}'s shield absorbed ${e.amount}`;
    case 'collision': return `  ${n(e.unit)} slammed into something: ${e.amount}`;
    case 'hazardHit': return `  ${n(e.unit)} hit spikes: ${e.amount}`;
    case 'statusAdd': return `  ${n(e.unit)} is ${STATUS_ICON[e.status]} ${e.status}`;
    case 'stunned': return `${n(e.unit)} is stunned and loses the turn`;
    case 'ko': return `💀 ${n(e.unit)} is down`;
    case 'move': return `${n(e.unit)} moved`;
    case 'capture': return `◆ ${team(e.team)} took a Beacon`;
    case 'pulse': return `⚡ Pulse: +${e.gained[0]} / +${e.gained[1]} → ${e.score[0]}–${e.score[1]}`;
    case 'gameOver': return e.winner === 'draw' ? 'Draw' : `🏁 ${team(e.winner)} won`;
    default: return null;
  }
}
