// Game screen: drives turns, turns taps into Actions, plays back events.

import { nextAiAction } from '../core/ai';
import {
  abilityArea,
  abilityTargets,
  activeUnit,
  applyAction,
  createMatch,
  defOf,
  previewAbility,
  previewQueue,
  reachable,
  SCORE_TO_WIN,
  unitAt,
  type PreviewEntry,
} from '../core/engine';
import { DIRS, directionTo, hexAdd, hexDistance, hexEq, type Dir, type Hex } from '../core/hex';
import { getAbility, MONSTER_BY_ID } from '../core/monsters';
import { encodeReplay, type Replay } from '../core/replay';
import type { Action, GameEvent, GameState, MatchConfig, Unit } from '../core/types';
import { BoardView, STATUS_ICON } from '../render/view';
import { el, esc, modal } from './dom';

const PLAYER = 0;

type Mode =
  | { k: 'busy' }
  | { k: 'menu' }
  | { k: 'move' }
  | { k: 'abilities' }
  | { k: 'target'; ability: string }
  | { k: 'confirm'; ability: string; target: Hex }
  | { k: 'facing'; facing: Dir }
  | { k: 'over' };

export interface GameOptions {
  config: MatchConfig;
  /** Watch a recorded match instead of playing. */
  replay?: Replay;
  onExit: (next: 'rematch' | 'roster' | 'title') => void;
}

const mono = (defId: string) => MONSTER_BY_ID[defId].name.split(' ')[1].slice(0, 2).toUpperCase();
const pct = (bp: number) => `${Math.round(bp / 100)}%`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class GameScreen {
  private state: GameState;
  private log: Action[] = [];
  private view: BoardView;
  private mode: Mode = { k: 'busy' };
  private undo: { state: GameState; logLen: number } | null = null;
  private inspect: number | null = null;
  private root: HTMLElement;
  private els: Record<'top' | 'queue' | 'board' | 'panel', HTMLElement>;
  private disposed = false;

  constructor(host: HTMLElement, private opts: GameOptions) {
    this.state = createMatch(opts.config);
    this.root = el('div', 'game');
    this.els = {
      top: el('div', 'top'),
      queue: el('div', 'queue'),
      board: el('div', 'board'),
      panel: el('div', 'panel'),
    };
    this.root.append(this.els.top, this.els.queue, this.els.board, this.els.panel);
    host.replaceChildren(this.root);
    this.view = new BoardView(this.els.board, this.state);
    this.view.onTap = (h) => this.onTap(h);

    const ctrlL = el('div', 'board-ctrl left');
    const rotL = el('button', '', '⟲');
    const rotR = el('button', '', '⟳');
    rotL.setAttribute('aria-label', 'Rotate left');
    rotR.setAttribute('aria-label', 'Rotate right');
    rotL.onclick = () => this.view.rotate(-1);
    rotR.onclick = () => this.view.rotate(1);
    ctrlL.append(rotL, rotR);
    this.els.board.append(ctrlL);

    this.renderHud();
    void this.loop();
  }

  /** Hooks for automated UI tests (enabled with ?debug). */
  debug() {
    return {
      state: () => this.state,
      mode: () => this.mode.k,
      screenOf: (h: Hex) => this.view.screenOf(h),
      autoplay: () => {
        this.autoplay = true;
        if (this.mode.k !== 'busy') void this.loop();
      },
    };
  }

  private autoplay = false;

  dispose(): void {
    this.disposed = true;
    this.view.dispose();
  }

  // -------------------------------------------------------------------------
  // Turn loop

  private async loop(): Promise<void> {
    if (this.opts.replay) return this.playReplay(this.opts.replay);
    while (!this.disposed && this.state.winner === null) {
      const u = activeUnit(this.state)!;
      if (u.team === PLAYER && !this.autoplay) {
        this.view.focus(u.pos);
        this.setMode({ k: 'menu' });
        return; // input handlers resume the loop
      }
      this.setMode({ k: 'busy' });
      await sleep(260);
      const a = nextAiAction(this.state);
      await this.telegraph(a);
      await this.commit(a);
    }
    this.gameOver();
  }

  private async playReplay(r: Replay): Promise<void> {
    this.setMode({ k: 'busy' });
    for (const a of r.actions) {
      if (this.disposed) return;
      await sleep(180);
      await this.telegraph(a);
      await this.commit(a);
    }
    this.gameOver();
  }

  /** Briefly show what the AI (or replay) is about to do. */
  private async telegraph(a: Action): Promise<void> {
    const u = this.state.units[a.unit];
    if (a.type === 'move') {
      this.view.highlight([a.to], 'select');
      await sleep(200);
    } else if (a.type === 'ability') {
      const ab = getAbility(u.defId, a.ability);
      this.view.highlight(abilityArea(this.state, ab, u.pos, a.target), 'area');
      this.toast(`${defOf(u).name}: ${ab.name}`);
      await sleep(450);
    }
    this.view.clearHighlights();
  }

  private async commit(a: Action): Promise<void> {
    const before = structuredClone(this.state);
    const events = applyAction(this.state, a);
    this.log.push(a);
    await this.play(events, before);
    if (this.disposed) return;
    this.view.sync(this.state);
    this.renderHud();
  }

  // -------------------------------------------------------------------------
  // Event playback

  private async play(events: GameEvent[], before: GameState): Promise<void> {
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
          await sleep(250);
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
          await sleep(250);
          break;
        case 'heal':
          this.view.floatText(pos.get(e.unit)!, `+${e.amount}`, 'heal');
          hurt(e.unit, -e.amount);
          await sleep(200);
          break;
        case 'statusAdd':
          this.view.floatText(pos.get(e.unit)!, `${STATUS_ICON[e.status]} ${e.status}`, 'info');
          await sleep(150);
          break;
        case 'statusTick':
          this.view.floatText(pos.get(e.unit)!, e.status === 'poison' ? `-${e.amount}` : `+${e.amount}`, e.status === 'poison' ? 'dmg' : 'heal');
          hurt(e.unit, e.status === 'poison' ? e.amount : -e.amount);
          await sleep(300);
          break;
        case 'stunned':
          this.view.floatText(pos.get(e.unit)!, '💫 Stunned', 'info');
          await sleep(500);
          break;
        case 'ctShift':
          this.view.floatText(pos.get(e.unit)!, `CT ${e.amount}`, 'info');
          break;
        case 'hazardPlaced':
          this.view.syncHazards(this.state);
          await sleep(200);
          break;
        case 'ko':
          await this.view.animateKo(e.unit);
          this.toast(`${defOf(this.state.units[e.unit]).name} is down!`);
          break;
        case 'capture':
          this.view.setBeaconOwner(e.beacon, e.team);
          this.toast(e.team === PLAYER ? 'Beacon captured' : 'Enemy took a Beacon');
          await sleep(350);
          break;
        case 'pulse':
          this.toast(`⚡ Pulse  +${e.gained[0]} / +${e.gained[1]}`);
          this.renderTop(e.score);
          await sleep(500);
          break;
        case 'facing':
        case 'turnStart':
        case 'gameOver':
          break;
      }
    }
  }

  // -------------------------------------------------------------------------
  // Input

  private me(): Unit | undefined {
    const u = activeUnit(this.state);
    return u && u.team === PLAYER && !this.opts.replay ? u : undefined;
  }

  private setMode(m: Mode): void {
    this.mode = m;
    this.inspect = null;
    this.view.clearHighlights();
    this.view.setTags(null);
    const u = this.me();
    if (u) {
      if (m.k === 'move') this.view.highlight([...reachable(this.state, u).values()].map((n) => n.hex), 'move');
      if (m.k === 'target' || m.k === 'confirm') {
        this.view.highlight(abilityTargets(this.state, u, m.ability), 'target');
      }
      if (m.k === 'confirm') {
        const ab = getAbility(u.defId, m.ability);
        this.view.highlight(abilityArea(this.state, ab, u.pos, m.target), 'area');
        const tags = new Map<number, string>();
        for (const p of previewAbility(this.state, u, m.ability, m.target)) tags.set(p.unit, tagText(p));
        this.view.setTags(tags);
      }
      if (m.k === 'facing') {
        this.view.highlight(DIRS.map((d) => hexAdd(u.pos, d)), 'facing');
        this.view.highlight([hexAdd(u.pos, DIRS[m.facing])], 'select');
        this.view.previewFacing(u.id, m.facing);
      }
    }
    this.renderHud();
  }

  private onTap(h: Hex | null): void {
    const u = this.me();
    const m = this.mode;
    if (!h) {
      if (m.k === 'move' || m.k === 'target' || m.k === 'confirm') this.setMode(m.k === 'confirm' ? { k: 'target', ability: m.ability } : { k: 'menu' });
      return;
    }
    const tapped = unitAt(this.state, h);
    if (u && m.k === 'move') {
      if ([...reachable(this.state, u).values()].some((n) => hexEq(n.hex, h))) return void this.doMove(h);
      if (tapped && tapped.id === u.id) return this.setMode({ k: 'menu' });
    }
    if (u && (m.k === 'target' || m.k === 'confirm')) {
      if (abilityTargets(this.state, u, m.ability).some((t) => hexEq(t, h))) {
        if (m.k === 'confirm' && hexEq(m.target, h)) return void this.doAbility(m.ability, h);
        return this.setMode({ k: 'confirm', ability: m.ability, target: h });
      }
    }
    if (u && m.k === 'facing') {
      if (hexDistance(u.pos, h) >= 1) {
        const f = directionTo(u.pos, h);
        if (m.facing === f && hexDistance(u.pos, h) === 1) return void this.doEnd(f);
        return this.setMode({ k: 'facing', facing: f });
      }
    }
    // Otherwise: inspect whoever was tapped.
    this.inspect = tapped?.id ?? null;
    if (u && m.k === 'menu' && tapped?.id === u.id) {
      if (!this.state.turn!.moved) return this.setMode({ k: 'move' });
    }
    this.renderPanel();
  }

  private async doMove(to: Hex): Promise<void> {
    const u = this.me()!;
    this.undo = { state: structuredClone(this.state), logLen: this.log.length };
    this.setMode({ k: 'busy' });
    await this.commit({ type: 'move', unit: u.id, to });
    this.afterPlayerAction();
  }

  private async doAbility(ability: string, target: Hex): Promise<void> {
    const u = this.me()!;
    this.undo = null; // rolls happened; no take-backs
    this.setMode({ k: 'busy' });
    await this.commit({ type: 'ability', unit: u.id, ability, target });
    this.afterPlayerAction();
  }

  private async doEnd(facing: Dir): Promise<void> {
    const u = this.me()!;
    this.undo = null;
    this.setMode({ k: 'busy' });
    await this.commit({ type: 'end', unit: u.id, facing });
    void this.loop();
  }

  private afterPlayerAction(): void {
    if (this.state.winner !== null) return this.gameOver();
    const u = this.me();
    if (!u) return void this.loop(); // our unit fell mid-turn
    const t = this.state.turn!;
    this.setMode(t.moved && t.acted ? { k: 'facing', facing: u.facing } : { k: 'menu' });
  }

  private doUndo(): void {
    if (!this.undo) return;
    this.state = this.undo.state;
    this.log.length = this.undo.logLen;
    this.undo = null;
    this.view.sync(this.state);
    this.setMode({ k: 'menu' });
  }

  // -------------------------------------------------------------------------
  // HUD

  private renderHud(): void {
    this.renderTop(this.state.score);
    this.renderQueue();
    this.renderPanel();
  }

  private renderTop(score: [number, number]): void {
    const pips = this.state.beacons.map((b) => `<span class="${b.owner === null ? '' : 'o' + b.owner}"></span>`).join('');
    const side = (t: 0 | 1, who: string) => `
      <div class="score t${t}">
        <div class="row">${t === 0 ? `<span class="who">${who}</span><span class="pts">${score[t]}</span>` : `<span class="pts">${score[t]}</span><span class="who">${who}</span>`}</div>
        <div class="bar"><i style="width:${Math.min(100, (100 * score[t]) / SCORE_TO_WIN)}%"></i></div>
      </div>`;
    this.els.top.innerHTML = `${side(0, this.opts.replay ? 'Blue' : 'You')}<div class="beacon-pips" title="Beacons">${pips}</div>${side(1, this.opts.replay ? 'Orange' : 'AI')}`;
    const menu = el('button', 'icon-btn ghost', '☰');
    menu.setAttribute('aria-label', 'Menu');
    menu.onclick = () => this.openMenu();
    this.els.top.append(menu);
  }

  private renderQueue(): void {
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

  private renderPanel(): void {
    const p = this.els.panel;
    p.replaceChildren();
    const active = activeUnit(this.state);
    const shown = this.inspect !== null ? this.state.units[this.inspect] : active;
    if (shown) p.append(unitCard(shown, this.state));
    const u = this.me();
    const m = this.mode;
    if (this.state.winner !== null || m.k === 'over') return;
    if (!u || m.k === 'busy') {
      p.append(el('div', 'hint', this.opts.replay ? 'Replay' : active?.team === PLAYER ? '…' : 'Enemy turn…'));
      return;
    }
    const turn = this.state.turn!;
    const actions = el('div', 'actions');
    const btn = (label: string, on: () => void, opts: { disabled?: boolean; primary?: boolean } = {}) => {
      const b = el('button', opts.primary ? 'primary' : '', label);
      b.disabled = !!opts.disabled;
      b.onclick = on;
      actions.append(b);
      return b;
    };
    switch (m.k) {
      case 'menu':
        btn('Move', () => this.setMode({ k: 'move' }), { disabled: turn.moved });
        btn('Act', () => this.setMode({ k: 'abilities' }), { disabled: turn.acted });
        btn(turn.moved || turn.acted ? 'End turn' : 'Wait', () => this.setMode({ k: 'facing', facing: u.facing }));
        if (this.undo && !turn.acted) btn('Undo move', () => this.doUndo());
        p.append(actions);
        break;
      case 'move':
        p.append(el('div', 'hint', 'Tap a blue hex to move.'));
        btn('Back', () => this.setMode({ k: 'menu' }));
        p.append(actions);
        break;
      case 'abilities': {
        const list = el('div', 'abilities');
        for (const ab of defOf(u).abilities) {
          const cd = u.cooldowns[ab.id] ?? 0;
          const targets = abilityTargets(this.state, u, ab.id);
          const b = el('button', 'ability');
          const range = ab.maxRange === 0 ? 'self' : ab.minRange === ab.maxRange ? `rng ${ab.maxRange}` : `rng ${ab.minRange}-${ab.maxRange}`;
          b.innerHTML = `<span class="an">${esc(ab.name)}</span><span class="meta">${cd > 0 ? `cooldown ${cd}` : range}${ab.chargeSpeed ? ' · charges' : ''}</span><span class="ad">${esc(ab.desc)}</span>`;
          b.disabled = cd > 0 || targets.length === 0;
          b.onclick = () => {
            if (ab.affects === 'self') this.setMode({ k: 'confirm', ability: ab.id, target: u.pos });
            else this.setMode({ k: 'target', ability: ab.id });
          };
          list.append(b);
        }
        p.append(list);
        btn('Back', () => this.setMode({ k: 'menu' }));
        p.append(actions);
        break;
      }
      case 'target': {
        const ab = getAbility(u.defId, m.ability);
        p.append(el('div', 'hint', `${ab.name}: tap a yellow hex to aim.`));
        btn('Back', () => this.setMode({ k: 'abilities' }));
        p.append(actions);
        break;
      }
      case 'confirm': {
        const ab = getAbility(u.defId, m.ability);
        const rows = previewAbility(this.state, u, m.ability, m.target);
        const prev = el('div', 'preview');
        if (!rows.length) prev.append(el('div', 'hint', ab.affects === 'tiles' ? `${ab.name} on the red area.` : 'No one in the area yet.'));
        for (const r of rows) {
          const t = this.state.units[r.unit];
          const row = el('div', 'row');
          row.innerHTML = `<span>${esc(defOf(t).name)} <span class="arc">${t.team !== u.team ? r.arc : 'ally'}</span></span><span>${r.damage ? `${r.damage} dmg ` : ''}${r.heal ? `+${r.heal} ` : ''}<span class="pct">${pct(r.chance)}</span></span>`;
          prev.append(row);
        }
        if (ab.chargeSpeed) prev.append(el('div', 'hint', 'Charges first: targets can move out of the area.'));
        p.append(prev);
        btn('Back', () => this.setMode(ab.affects === 'self' ? { k: 'abilities' } : { k: 'target', ability: m.ability }));
        btn(`Use ${ab.name}`, () => void this.doAbility(m.ability, m.target), { primary: true });
        p.append(actions);
        break;
      }
      case 'facing':
        p.append(el('div', 'hint', 'Choose a facing: tap a green hex. Your back takes +50% damage.'));
        if (this.undo && !turn.acted) btn('Undo move', () => this.doUndo());
        btn('Back', () => this.setMode({ k: 'menu' }));
        btn('Confirm', () => void this.doEnd(m.facing), { primary: true });
        p.append(actions);
        break;
    }
  }

  private toast(text: string): void {
    const t = el('div', 'toast', text);
    this.els.board.querySelectorAll('.toast').forEach((x) => x.remove());
    this.els.board.append(t);
    setTimeout(() => t.remove(), 1900);
  }

  private replayCode(): string {
    return encodeReplay(this.opts.replay ?? { config: this.state.config, actions: this.log });
  }

  private openMenu(): void {
    const close = modal(`
      <h2>Menu</h2>
      <div class="hint">Seed <b>${esc(this.state.config.seed)}</b> · ${this.log.length} actions</div>
      <textarea readonly>${this.replayCode()}</textarea>
      <div class="btns">
        <button data-a="copy">Copy replay code</button>
        <button data-a="quit">Quit to title</button>
      </div>
      <button data-a="close" class="primary">Resume</button>`, {
      copy: () => copyText(this.replayCode()),
      quit: () => { close(); this.opts.onExit('title'); },
      close: () => close(),
    });
  }

  private gameOver(): void {
    if (this.disposed) return;
    this.mode = { k: 'over' };
    this.view.sync(this.state);
    this.renderHud();
    const w = this.state.winner;
    const wiped = w !== 'draw' && w !== null && this.state.units.every((u) => u.team === w || !u.alive);
    const title = this.opts.replay ? (w === 'draw' ? 'Draw' : w === 0 ? 'Blue wins' : 'Orange wins') : w === 'draw' ? 'Draw' : w === PLAYER ? 'Victory' : 'Defeat';
    const how = w === 'draw' ? 'Turn limit reached.' : wiped ? 'Team wiped out.' : `First to ${SCORE_TO_WIN} Beacon points.`;
    const close = modal(`
      <h2>${title}</h2>
      <div>${this.state.score[0]} – ${this.state.score[1]} · ${how}</div>
      <textarea readonly>${this.replayCode()}</textarea>
      <div class="btns">
        <button data-a="copy">Copy replay code</button>
        <button data-a="roster">Change team</button>
      </div>
      <button data-a="rematch" class="primary">Rematch</button>`, {
      copy: () => copyText(this.replayCode()),
      roster: () => { close(); this.opts.onExit('roster'); },
      rematch: () => { close(); this.opts.onExit('rematch'); },
    });
  }
}

function tagText(p: PreviewEntry): string {
  const parts: string[] = [];
  if (p.damage) parts.push(`${p.damage}`);
  if (p.heal) parts.push(`+${p.heal}`);
  if (p.chance < 10000 || p.damage) parts.push(pct(p.chance));
  return parts.join(' · ') || '✓';
}

function unitCard(u: Unit, state: GameState): HTMLElement {
  const def = defOf(u);
  const s = def.stats;
  const card = el('div', 'card');
  const statuses = u.statuses.map((x) => `${STATUS_ICON[x.id]} ${x.id} (${x.turns})`).join('  ');
  const onBeacon = state.beacons.findIndex((b) => hexEq(b.pos, u.pos));
  card.innerHTML = `
    <div class="mono t${u.team}">${mono(u.defId)}</div>
    <div class="name">${esc(def.name)} <small>${def.role}${u.team === PLAYER ? '' : ' · enemy'}${onBeacon >= 0 ? ' · on Beacon' : ''}</small></div>
    <div class="hpline"><div class="hpbar"><i style="width:${(100 * u.hp) / u.maxHp}%"></i></div>${u.hp}/${u.maxHp}</div>
    <div class="stats">
      <span>ATK <b>${s.atk}</b></span><span>DEF <b>${s.def}</b></span><span>MAG <b>${s.mag}</b></span><span>RES <b>${s.res}</b></span>
      <span>SPD <b>${s.spd}</b></span><span>MOV <b>${s.move}</b></span><span>JMP <b>${s.jump}</b></span><span>CT <b>${u.ct}</b></span>
    </div>
    ${statuses ? `<div class="statuses">${statuses}</div>` : ''}`;
  return card;
}

/** Copy to clipboard; if that's refused, select the code so it can be copied by hand. */
function copyText(text: string): void {
  const fallback = () => {
    const ta = document.querySelector<HTMLTextAreaElement>('.modal textarea');
    ta?.focus();
    ta?.select();
  };
  if (!navigator.clipboard) return fallback();
  navigator.clipboard.writeText(text).catch(fallback);
}
