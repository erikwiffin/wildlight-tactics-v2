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
import { hexDistance, hexEq } from '../core/hex';
import { getMap } from '../core/map';
import { getAbility, MONSTER_BY_ID } from '../core/monsters';
import type { Action, GameEvent, GameState, MatchConfig, Unit } from '../core/types';
import { BoardView, STATUS_ICON } from '../render/view';
import { el, esc } from './dom';
import { loadPrefs, savePrefs } from './store';

export const mono = (defId: string) => MONSTER_BY_ID[defId].name.split(' ')[1].slice(0, 2).toUpperCase();
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

    const ctrl = el('div', 'board-ctrl left');
    const rotL = el('button', '', '⟲');
    const rotR = el('button', '', '⟳');
    rotL.setAttribute('aria-label', 'Rotate left');
    rotR.setAttribute('aria-label', 'Rotate right');
    rotL.onclick = () => this.view.rotate(-1);
    rotR.onclick = () => this.view.rotate(1);
    this.autoZoom = loadPrefs().autoZoom;
    this.zoomBtn = el('button', 'zoom-toggle', 'Auto zoom');
    this.zoomBtn.onclick = () => this.setAutoZoom(!this.autoZoom);
    ctrl.append(rotL, rotR, this.zoomBtn);
    this.els.board.append(ctrl);
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
    const def = defOf(u);
    const reach = def.stats.move + Math.min(4, Math.max(...def.abilities.map((a) => a.maxRange)));
    const tiles = getMap(this.state.config.mapId).def.tiles.filter((t) => hexDistance(t, u.pos) <= reach);
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

  protected async commit(a: Action): Promise<void> {
    const before = structuredClone(this.state);
    const events = applyAction(this.state, a);
    this.log.push(a);
    await this.play(events, before);
    if (this.disposed) return;
    this.view.sync(this.state);
    this.renderHud();
    if (events.some((e) => e.type === 'turnStart')) this.frameActive();
  }

  protected async play(events: GameEvent[], before: GameState): Promise<void> {
    const hp = new Map(before.units.map((u) => [u.id, u.hp]));
    const pos = new Map(before.units.map((u) => [u.id, u.pos]));
    const hurt = (id: number, amount: number) => {
      hp.set(id, hp.get(id)! - amount);
      this.view.setHp(id, hp.get(id)!, this.state.units[id].maxHp);
    };
    for (const e of events) {
      if (this.disposed) return;
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
          if (ab.affects !== 'self' && !ab.effects.some((x) => x.kind === 'leap')) await this.view.animateLunge(e.unit, e.target);
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
          await this.view.animateArea(abilityArea(this.state, ab, pos.get(e.unit)!, e.target), 0xffd23a);
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
          this.toast(`${this.sideNames[e.team].split(' ')[0]} took a Beacon`);
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
      const who = `<span class="who">${esc(this.sideNames[t])}</span>`;
      const pts = `<span class="pts">${score[t]}</span>`;
      return `
      <div class="score t${t}">
        <div class="row">${t === 0 ? who + pts : pts + who}</div>
        <div class="bar"><i style="width:${Math.min(100, (100 * score[t]) / target)}%"></i></div>
      </div>`;
    };
    this.els.top.innerHTML = `${side(0)}<div class="beacon-pips" title="Beacons · first to ${target}">${pips}</div>${side(1)}`;
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
        if (e.kind === 'cast') return `<div class="chip cast t${u.team}" title="Charging">${esc(getAbility(u.defId, e.ability).name.split(' ')[0])}</div>`;
        return `<div class="chip t${u.team}${i === 0 && this.state.turn ? ' now' : ''}">${mono(u.defId)}<small>${u.hp}</small></div>`;
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
    const s = def.stats;
    const card = el('div', 'card');
    const statuses = u.statuses.map((x) => `${STATUS_ICON[x.id]} ${x.id} (${x.turns})`).join('  ');
    const onBeacon = this.state.beacons.findIndex((b) => hexEq(b.pos, u.pos));
    const side = ownTeam === null ? this.sideNames[u.team].split(' ')[0] : u.team === ownTeam ? '' : 'enemy';
    card.innerHTML = `
      <div class="mono t${u.team}">${mono(u.defId)}</div>
      <div class="name">${esc(def.name)} <small>${def.role}${side ? ' · ' + esc(side) : ''}${onBeacon >= 0 ? ' · on Beacon' : ''}${u.alive ? '' : ' · KO'}</small></div>
      <div class="hpline"><div class="hpbar"><i style="width:${(100 * u.hp) / u.maxHp}%"></i></div>${u.hp}/${u.maxHp}</div>
      <div class="stats">
        <span>ATK <b>${s.atk}</b></span><span>DEF <b>${s.def}</b></span><span>MAG <b>${s.mag}</b></span><span>RES <b>${s.res}</b></span>
        <span>SPD <b>${s.spd}</b></span><span>MOV <b>${s.move}</b></span><span>JMP <b>${s.jump}</b></span><span>CT <b>${u.ct}</b></span>
      </div>
      ${statuses ? `<div class="statuses">${statuses}</div>` : ''}`;
    return card;
  }
}

/** Copy to clipboard; if that's refused, select the code so it can be copied by hand. */
export function copyText(text: string): void {
  const fallback = () => {
    const ta = document.querySelector<HTMLTextAreaElement>('.modal textarea');
    ta?.focus();
    ta?.select();
  };
  if (!navigator.clipboard) return fallback();
  navigator.clipboard.writeText(text).catch(fallback);
}
