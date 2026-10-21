// Shared match screen: layout, board, HUD, event playback and auto-zoom.
// PlayScreen adds human input; WatchScreen adds playback controls.

import {
  abilityArea,
  activeUnit,
  applyAction,
  createMatch,
  defOf,
  previewQueue,
  scoreToWin,
} from '../core/engine';
import { hexDistance, hexEq, type Hex } from '../core/hex';
import { getMap } from '../core/map';
import { abilityById, getAbility } from '../core/monsters';
import type { Action, GameEvent, GameState, MatchConfig, Unit } from '../core/types';
import { BoardView, STATUS_ICON } from '../render/view';
import { playFx, type FxContext } from '../render/vfx';
import { el, esc, modal } from './dom';
import { icon, logLine, shortSide, showUnitSheet, threat } from './hud';
import { loadPrefs, savePrefs } from './store';

export const pct = (bp: number) => `${Math.round(bp / 100)}%`;
export const cap = (s: string) => s[0].toUpperCase() + s.slice(1);

export abstract class MatchScreen {
  protected state: GameState;
  protected log: Action[] = [];
  protected view: BoardView;
  protected els: Record<'top' | 'queue' | 'board' | 'panel', HTMLElement>;
  protected disposed = false;
  protected inspect: number | null = null;
  protected autoZoom: boolean;
  private zoomBtn: HTMLButtonElement;
  /** Readable history of this match for the battle log. */
  protected battleLog: string[] = [];

  constructor(
    host: HTMLElement,
    protected config: MatchConfig,
    /** Score labels for Team 0 and Team 1. */
    protected sideNames: [string, string],
  ) {
    this.state = createMatch(config);
    const root = el('div', 'game');
    this.els = {
      top: el('div', 'top'),
      queue: el('div', 'queue'),
      board: el('div', 'board'),
      panel: el('div', 'panel'),
    };
    root.append(this.els.top, this.els.queue, this.els.board, this.els.panel);
    host.replaceChildren(root);
    this.view = new BoardView(this.els.board, this.state);
    this.view.onTap = (h) => this.onTap(h);

    const iconBtn = (cls: string, text: string, label: string, on: () => void) => {
      const b = el('button', cls, text);
      b.setAttribute('aria-label', label);
      b.title = label;
      b.onclick = on;
      return b;
    };
    const ctrl = el('div', 'board-ctrl left');
    this.autoZoom = loadPrefs().autoZoom;
    this.zoomBtn = iconBtn('zoom-toggle', '⌖', 'Auto zoom', () => this.setAutoZoom(!this.autoZoom));
    ctrl.append(
      iconBtn('', '⟲', 'Rotate left', () => this.view.rotate(-1)),
      iconBtn('', '⟳', 'Rotate right', () => this.view.rotate(1)),
      this.zoomBtn,
    );
    const right = el('div', 'board-ctrl right');
    right.append(iconBtn('', '☷', 'Battle log', () => this.openLog()));
    this.els.board.append(ctrl, right);
    this.els.queue.onclick = (e) => {
      const id = (e.target as HTMLElement).closest<HTMLElement>('[data-unit]')?.dataset.unit;
      if (id !== undefined) this.focusUnit(Number(id));
    };
    this.setAutoZoom(this.autoZoom, false);
  }

  dispose(): void {
    this.disposed = true;
    this.view.dispose();
  }

  protected abstract renderPanel(): void;
  protected abstract onTap(h: { q: number; r: number } | null): void;

  protected sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms / this.view.speed));
  }

  // -------------------------------------------------------------------------
  // Camera

  private setAutoZoom(on: boolean, persist = true): void {
    this.autoZoom = on;
    this.zoomBtn.setAttribute('aria-pressed', String(on));
    if (persist) savePrefs({ ...loadPrefs(), autoZoom: on });
    if (on) this.frameActive();
    else this.view.frameAll();
  }

  /** Auto-zoom: frame the active unit's movement and attack reach. */
  protected frameActive(): void {
    if (!this.autoZoom) return;
    const u = activeUnit(this.state);
    if (!u) return this.view.frameAll();
    this.frameUnit(u);
  }

  /** Frame a unit's movement and attack reach. */
  private frameUnit(u: Unit): void {
    const def = defOf(u);
    const reach = def.stats.move + Math.min(4, Math.max(...def.abilities.map((a) => a.maxRange)));
    const tiles = getMap(this.state.config.mapId, this.state.config.rulesVersion).def.tiles.filter((t) => hexDistance(t, u.pos) <= reach);
    this.view.frameHexes(tiles);
  }

  // -------------------------------------------------------------------------
  // Applying and animating actions

  /** Briefly show what an AI (or a replay) is about to do. */
  protected async telegraph(a: Action): Promise<void> {
    const u = this.state.units[a.unit];
    if (a.type === 'move') {
      this.view.highlight([a.to], 'select');
      await this.sleep(200);
    } else if (a.type === 'ability') {
      const ab = getAbility(u.defId, a.ability);
      this.view.highlight(abilityArea(this.state, ab, u.pos, a.target), 'area');
      this.toast(`${defOf(u).name}: ${ab.name}`);
      await this.sleep(450);
    }
    this.view.clearHighlights();
  }

  protected async commit(a: Action): Promise<GameEvent[]> {
    const before = structuredClone(this.state);
    const events = applyAction(this.state, a);
    this.log.push(a);
    await this.play(events, before);
    if (this.disposed) return events;
    this.view.sync(this.state);
    this.renderHud();
    if (events.some((e) => e.type === 'turnStart')) this.frameActive();
    return events;
  }

  protected async play(events: GameEvent[], before: GameState): Promise<void> {
    const hp = new Map(before.units.map((u) => [u.id, u.hp]));
    const pos = new Map(before.units.map((u) => [u.id, u.pos]));
    const hurt = (id: number, amount: number) => {
      hp.set(id, hp.get(id)! - amount);
      this.view.setHp(id, hp.get(id)!, this.state.units[id].maxHp);
    };
    for (let i = 0; i < events.length; i++) {
      const e = events[i];
      if (this.disposed) return;
      const line = logLine(this.state, e, this.sideNames);
      if (line) this.battleLog.push(line);
      switch (e.type) {
        case 'move':
          await this.view.animatePath(e.unit, e.path);
          pos.set(e.unit, e.path[e.path.length - 1]);
          break;
        case 'displace':
          await this.view.animateSlide(e.unit, e.path);
          pos.set(e.unit, e.path[e.path.length - 1]);
          break;
        case 'abilityUsed': {
          const ab = getAbility(this.state.units[e.unit].defId, e.ability);
          const fx = this.fxContext(events, i, e.unit, e.target, ab.id, pos);
          await playFx(ab.id, fx, ab.chargeSpeed ? 'charge' : 'cast');
          break;
        }
        case 'castStart':
          this.view.floatText(pos.get(e.cast.caster)!, 'Charging…', 'info');
          await this.sleep(250);
          break;
        case 'castResolve': {
          const caster = this.state.units[e.unit];
          const ab = getAbility(caster.defId, e.ability);
          this.toast(`${defOf(caster).name}: ${ab.name}!`);
          await playFx(ab.id, this.fxContext(events, i, e.unit, e.target, ab.id, pos), 'cast');
          break;
        }
        case 'castFizzle':
          this.toast('A charging ability fizzled');
          break;
        case 'hit':
          this.view.floatText(pos.get(e.unit)!, `-${e.amount}${e.arc === 'rear' ? ' REAR' : e.arc === 'flank' ? ' FLANK' : ''}`, e.arc === 'front' ? 'dmg' : 'crit');
          hurt(e.unit, e.amount);
          await this.view.animateHitFlash(e.unit);
          break;
        case 'shieldAbsorb':
          hurt(e.unit, -e.amount);
          this.view.floatText(pos.get(e.unit)!, `🛡${e.amount}`, 'info');
          break;
        case 'collision':
        case 'hazardHit':
          this.view.floatText(pos.get(e.unit)!, `-${e.amount}`, 'dmg');
          hurt(e.unit, e.amount);
          await this.view.animateHitFlash(e.unit);
          break;
        case 'miss':
          this.view.floatText(pos.get(e.unit)!, 'MISS', 'miss');
          await this.sleep(250);
          break;
        case 'heal':
          this.view.floatText(pos.get(e.unit)!, `+${e.amount}`, 'heal');
          hurt(e.unit, -e.amount);
          await this.sleep(200);
          break;
        case 'statusAdd':
          this.view.floatText(pos.get(e.unit)!, `${STATUS_ICON[e.status]} ${e.status}`, 'info');
          await this.sleep(150);
          break;
        case 'statusTick':
          this.view.floatText(pos.get(e.unit)!, e.status === 'poison' ? `-${e.amount}` : `+${e.amount}`, e.status === 'poison' ? 'dmg' : 'heal');
          hurt(e.unit, e.status === 'poison' ? e.amount : -e.amount);
          await this.sleep(300);
          break;
        case 'stunned':
          this.view.floatText(pos.get(e.unit)!, '💫 Stunned', 'info');
          await this.sleep(500);
          break;
        case 'ctShift':
          this.view.floatText(pos.get(e.unit)!, `CT ${e.amount}`, 'info');
          break;
        case 'hazardPlaced':
          this.view.syncHazards(this.state);
          await this.sleep(200);
          break;
        case 'ko':
          await this.view.animateKo(e.unit);
          this.toast(`${defOf(this.state.units[e.unit]).name} is down!`);
          break;
        case 'capture':
          this.view.setBeaconOwner(e.beacon, e.team);
          this.toast(`${shortSide(this.sideNames[e.team])} took a Beacon`);
          await this.sleep(350);
          break;
        case 'pulse':
          this.toast(`⚡ Pulse  +${e.gained[0]} / +${e.gained[1]}`);
          this.renderTop(e.score);
          await this.sleep(500);
          break;
        case 'facing':
        case 'turnStart':
        case 'gameOver':
          break;
      }
    }
  }

  /** Debug (?debug): play an ability's effect from `caster` at `target`. */
  debugFx(ability: string, caster: number, target: Hex, phase: 'cast' | 'charge' = 'cast'): Promise<void> {
    const u = this.state.units[caster];
    const hit = this.state.units.find((x) => x.alive && hexEq(x.pos, target));
    const fx = this.fxContext([], 0, caster, target, ability, new Map([[caster, u.pos]]));
    // Abilities are owned by species; borrow the area shape from the real owner.
    return playFx(ability, { ...fx, hits: hit ? [hit.id] : [] }, phase);
  }

  /**
   * What an effect needs to know about one use of an ability: who and where,
   * its area, the units its results land on (read ahead in this batch of
   * events), and where a leaping caster lands.
   */
  private fxContext(events: GameEvent[], at: number, caster: number, target: Hex, abilityId: string, pos: Map<number, Hex>): FxContext {
    const ab = abilityById(abilityId);
    const hits: number[] = [];
    let landing: Hex | undefined;
    for (let j = at + 1; j < events.length; j++) {
      const e = events[j];
      if (e.type === 'abilityUsed' || e.type === 'castResolve' || e.type === 'turnStart' || e.type === 'castStart') break;
      if ((e.type === 'hit' || e.type === 'miss') && e.source === caster && !hits.includes(e.unit)) hits.push(e.unit);
      if ((e.type === 'heal' || e.type === 'statusAdd') && !hits.includes(e.unit)) hits.push(e.unit);
      if (e.type === 'displace' && e.unit === caster && !landing) landing = e.path[e.path.length - 1];
    }
    return {
      view: this.view,
      caster,
      from: this.view.unitAnchor(caster),
      target,
      to: this.view.hexWorld(target),
      area: abilityArea(this.state, ab, pos.get(caster) ?? this.state.units[caster].pos, target),
      hits,
      landing,
    };
  }

  // -------------------------------------------------------------------------
  // HUD

  protected renderHud(): void {
    this.renderTop(this.state.score);
    this.renderQueue();
    this.renderPanel();
  }

  protected abstract openMenu(): void;

  protected renderTop(score: [number, number]): void {
    const target = scoreToWin(this.state);
    const pips = this.state.beacons.map((b) => `<span class="${b.owner === null ? '' : 'o' + b.owner}"></span>`).join('');
    const side = (t: 0 | 1) => {
      const who = `<span class="who" title="${esc(this.sideNames[t])}">${esc(shortSide(this.sideNames[t]))}</span>`;
      const pts = `<span class="pts">${score[t]}<small>/${target}</small></span>`;
      return `
      <div class="score t${t}">
        <div class="row">${t === 0 ? who + pts : pts + who}</div>
        <div class="bar"><i style="width:${Math.min(100, (100 * score[t]) / target)}%"></i></div>
      </div>`;
    };
    this.els.top.innerHTML = `${side(0)}<div class="beacon-pips" title="Beacons held">${pips}</div>${side(1)}`;
    const menu = el('button', 'icon-btn ghost', '☰');
    menu.setAttribute('aria-label', 'Menu');
    menu.onclick = () => this.openMenu();
    this.els.top.append(menu);
  }

  protected renderQueue(): void {
    const q = previewQueue(this.state, 12);
    this.els.queue.innerHTML = q
      .map((e, i) => {
        if (e.kind === 'pulse') return `<div class="chip pulse" title="Pulse: Beacons score">⚡</div>`;
        const u = this.state.units[e.unit];
        const name = esc(defOf(u).name);
        if (e.kind === 'cast') return `<button class="chip cast t${u.team}" data-unit="${u.id}" title="${name} charging ${esc(getAbility(u.defId, e.ability).name)}">${icon(u.defId)}<small>⏳</small></button>`;
        return `<button class="chip t${u.team}${i === 0 && this.state.turn ? ' now' : ''}" data-unit="${u.id}" title="${name}">${icon(u.defId)}<small>${u.hp}</small></button>`;
      })
      .join('');
  }

  protected toast(text: string): void {
    const t = el('div', 'toast', text);
    this.els.board.querySelectorAll('.toast').forEach((x) => x.remove());
    this.els.board.append(t);
    setTimeout(() => t.remove(), 1900);
  }

  protected shownUnit(): Unit | undefined {
    return this.inspect !== null ? this.state.units[this.inspect] : activeUnit(this.state);
  }

  protected unitCard(u: Unit, ownTeam: 0 | 1 | null): HTMLElement {
    const def = defOf(u);
    const card = el('div', 'card');
    const statuses = u.statuses.map((x) => `<span title="${x.id}, ${x.turns} turn${x.turns === 1 ? '' : 's'}">${STATUS_ICON[x.id]} ${x.id}</span>`).join('');
    const onBeacon = this.state.beacons.some((b) => hexEq(b.pos, u.pos));
    const side = ownTeam === null ? shortSide(this.sideNames[u.team]) : u.team === ownTeam ? '' : 'enemy';
    const tags = [def.role, side, onBeacon ? '◆ on Beacon' : '', u.alive ? '' : 'KO'].filter(Boolean).map(esc).join(' · ');
    card.innerHTML = `
      <div class="mono t${u.team}">${icon(u.defId)}</div>
      <div class="name">${esc(def.name)} <small>${tags}</small></div>
      <div class="hpline"><div class="hpbar"><i style="width:${(100 * u.hp) / u.maxHp}%"></i></div>${u.hp}/${u.maxHp}</div>
      ${statuses ? `<div class="statuses">${statuses}</div>` : ''}`;
    const info = el('button', 'info-btn ghost', 'ⓘ');
    info.setAttribute('aria-label', `${def.name} details`);
    info.title = 'Stats and abilities';
    info.onclick = () => showUnitSheet(u.defId, u);
    card.append(info);
    return card;
  }

  /** Inspect a unit: show its card and, for an enemy of `ownTeam`, where it can reach next turn. */
  protected showThreat(u: Unit | undefined, ownTeam: 0 | 1 | null): void {
    if (!u || !u.alive || (ownTeam !== null && u.team === ownTeam)) return;
    const t = threat(this.state, u);
    this.view.highlight(t.hit, 'threat');
    this.view.highlight(t.move, 'reach');
  }

  /** Select a unit from the turn queue and bring it into view. */
  protected focusUnit(id: number): void {
    const u = this.state.units[id];
    if (!u?.alive) return;
    this.onTap(u.pos);
    this.frameUnit(u);
  }

  protected openLog(): void {
    const lines = this.battleLog.slice(-300);
    const close = modal(`
      <h2>Battle log</h2>
      <div class="log-list">${lines.length ? lines.map((l) => `<div class="${l.startsWith('  ') ? 'sub' : ''}">${esc(l.trim())}</div>`).join('') : '<div class="hint">Nothing has happened yet.</div>'}</div>
      <button data-a="close" class="primary">Close</button>`, { close: () => close() });
    const list = document.querySelector('.modal .log-list');
    if (list) list.scrollTop = list.scrollHeight;
  }
}

/** Copy to clipboard; if that's refused, select the code so it can be copied by hand. */
export function copyText(text: string): void {
  const fallback = () => {
    const ta = document.querySelector<HTMLTextAreaElement>('.modal textarea');
    if (ta) ta.hidden = false;
    ta?.focus();
    ta?.select();
  };
  if (!navigator.clipboard) return fallback();
  navigator.clipboard.writeText(text).catch(fallback);
}
