// You vs AI: turns taps into Actions; the AI plays the other side.

import { nextAiAction } from '../core/ai';
import {
  abilityArea,
  abilityTargets,
  activeUnit,
  defOf,
  movePath,
  previewAbility,
  reachable,
  scoreToWin,
  unitAt,
  type PreviewEntry,
} from '../core/engine';
import { DIRS, directionTo, hexAdd, hexDistance, hexEq, type Dir, type Hex } from '../core/hex';
import { getAbility } from '../core/monsters';
import { encodeReplay, type Replay } from '../core/replay';
import type { GameState, MatchConfig, StrategyId, Unit } from '../core/types';
import { el, esc, modal } from './dom';
import { cap, copyText, MatchScreen, pct } from './match';
import { rangeText, safestFacing, showHelp } from './hud';
import { buildMatchLog, showExport } from './matchlog';
import { saveMatch } from './store';

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

export type PlayExit = { to: 'rematch' } | { to: 'setup' } | { to: 'watch'; replay: Replay };

export class PlayScreen extends MatchScreen {
  private mode: Mode = { k: 'busy' };
  private undo: { state: GameState; logLen: number } | null = null;
  private enemy: StrategyId;
  private savedId: string | null = null;
  private autoplay = false;

  constructor(host: HTMLElement, config: MatchConfig, private onExit: (e: PlayExit) => void) {
    const enemy = config.ai?.[1] ?? 'balanced';
    super(host, config, ['You', `${cap(enemy)} AI`]);
    this.enemy = enemy;
    this.renderHud();
    this.frameActive();
    this.view.onHover = (h) => this.onHover(h);
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

  // -------------------------------------------------------------------------
  // Turn loop

  private async loop(): Promise<void> {
    while (!this.disposed && this.state.winner === null) {
      const u = activeUnit(this.state)!;
      if (u.team === PLAYER && !this.autoplay) {
        this.setMode({ k: 'menu' });
        return; // input handlers resume the loop
      }
      this.setMode({ k: 'busy' });
      await this.sleep(260);
      const a = nextAiAction(this.state, u.team === PLAYER ? 'balanced' : this.enemy);
      await this.telegraph(a);
      await this.commit(a);
    }
    this.gameOver();
  }

  private replay(): Replay {
    return { config: this.state.config, actions: [...this.log] };
  }

  private save(): void {
    if (this.log.length) this.savedId = saveMatch(this.replay(), this.state, this.savedId ?? undefined);
  }

  /** Record as we go: every finished turn updates this match's library entry. */
  protected async commit(a: Parameters<MatchScreen['commit']>[0]) {
    const events = await super.commit(a);
    if (a.type === 'end') this.save();
    return events;
  }

  // -------------------------------------------------------------------------
  // Input

  private me(): Unit | undefined {
    const u = activeUnit(this.state);
    return u && u.team === PLAYER && !this.autoplay ? u : undefined;
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
        const blocked: Hex[] = [];
        this.view.highlight(abilityTargets(this.state, u, m.ability, blocked), 'target');
        this.view.highlight(blocked, 'blocked');
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

  /** Mouse hover, or a finger touching down: preview the route a move would take. */
  private onHover(h: Hex | null): void {
    const u = this.me();
    if (!u || this.mode.k !== 'move') return;
    const reach = [...reachable(this.state, u).values()].map((n) => n.hex);
    this.view.clearHighlights();
    this.view.highlight(reach, 'move');
    if (h && reach.some((r) => hexEq(r, h))) this.view.highlight(movePath(this.state, u, h), 'path');
  }

  private faceSafely(u: Unit): Mode {
    return { k: 'facing', facing: safestFacing(this.state, u) };
  }

  protected onTap(h: Hex | null): void {
    const u = this.me();
    const m = this.mode;
    if (!h) {
      if (this.inspect !== null && (m.k === 'menu' || m.k === 'busy' || m.k === 'over')) {
        this.inspect = null;
        this.view.clearHighlights();
        return this.renderPanel();
      }
      if (m.k === 'move' || m.k === 'target' || m.k === 'confirm') this.setMode(m.k === 'confirm' ? { k: 'target', ability: m.ability } : { k: 'menu' });
      return;
    }
    const tapped = unitAt(this.state, h);
    if (u && m.k === 'move') {
      if ([...reachable(this.state, u).values()].some((n) => hexEq(n.hex, h))) return void this.doMove(h);
      if (tapped && tapped.id === u.id) return this.setMode({ k: 'menu' });
    }
    if (u && (m.k === 'target' || m.k === 'confirm')) {
      const blocked: Hex[] = [];
      if (abilityTargets(this.state, u, m.ability, blocked).some((t) => hexEq(t, h))) {
        if (m.k === 'confirm' && hexEq(m.target, h)) return void this.doAbility(m.ability, h);
        return this.setMode({ k: 'confirm', ability: m.ability, target: h });
      }
      if (blocked.some((t) => hexEq(t, h))) this.toast('No line of sight');
    }
    if (u && m.k === 'facing') {
      if (hexDistance(u.pos, h) >= 1) {
        const f = directionTo(u.pos, h);
        if (m.facing === f && hexDistance(u.pos, h) === 1) return void this.doEnd(f);
        return this.setMode({ k: 'facing', facing: f });
      }
    }
    // Otherwise: inspect whoever was tapped (an enemy also shows its reach).
    this.inspect = tapped?.id ?? null;
    if (u && m.k === 'menu' && tapped?.id === u.id) {
      if (!this.state.turn!.moved) return this.setMode({ k: 'move' });
    }
    if (m.k === 'menu' || m.k === 'busy' || m.k === 'over') {
      this.view.clearHighlights();
      this.showThreat(tapped, PLAYER);
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
    this.setMode(t.moved && t.acted ? this.faceSafely(u) : { k: 'menu' });
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
  // Panel

  protected renderPanel(): void {
    const p = this.els.panel;
    p.replaceChildren();
    const shown = this.shownUnit();
    if (shown) p.append(this.unitCard(shown, PLAYER));
    const u = this.me();
    const m = this.mode;
    if (this.state.winner !== null || m.k === 'over') return;
    if (!u || m.k === 'busy') {
      p.append(el('div', 'hint', activeUnit(this.state)?.team === PLAYER ? '…' : 'Enemy turn…'));
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
        btn(turn.moved || turn.acted ? 'End turn' : 'Wait', () => this.setMode(this.faceSafely(u)));
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
          const blocked: Hex[] = [];
          const targets = abilityTargets(this.state, u, ab.id, blocked);
          const b = el('button', 'ability');
          const why = cd > 0 ? `ready in ${cd} turn${cd === 1 ? '' : 's'}` : targets.length === 0 ? (blocked.length ? 'no line of sight' : 'no target in range') : rangeText(ab) + (ab.chargeSpeed ? ' · charges' : '');
          b.innerHTML = `<span class="an">${esc(ab.name)}</span><span class="meta">${why}</span>`;
          b.title = ab.desc;
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
        p.append(el('div', 'hint', `${ab.desc} Tap a yellow hex to aim.${ab.los ? ' Grey hexes are out of sight.' : ''}`));
        btn('Back', () => this.setMode({ k: 'abilities' }));
        p.append(actions);
        break;
      }
      case 'confirm': {
        const ab = getAbility(u.defId, m.ability);
        const rows = previewAbility(this.state, u, m.ability, m.target);
        const prev = el('div', 'preview');
        if (ab.affects === 'self' || !rows.length) prev.append(el('div', 'hint', ab.desc));
        if (!rows.length && ab.affects !== 'self') prev.append(el('div', 'hint', ab.affects === 'tiles' ? 'Lands on the red area.' : 'No one in the area yet.'));
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
        p.append(el('div', 'hint', 'Facing the safest way. Tap a green hex to turn; your back takes +50%.'));
        btn('Back', () => this.setMode({ k: 'menu' }));
        btn('End turn', () => void this.doEnd(m.facing), { primary: true });
        p.append(actions);
        break;
    }
  }

  // -------------------------------------------------------------------------
  // Menu and game over

  protected openMenu(): void {
    const code = encodeReplay(this.replay());
    const close = modal(`
      <h2>Paused</h2>
      <div class="hint">Seed <b>${esc(this.state.config.seed)}</b> · vs ${esc(cap(this.enemy))} AI</div>
      <button data-a="close" class="primary">Resume</button>
      <div class="btns">
        <button data-a="help">How to play</button>
        <button data-a="quit">Save and quit</button>
        <button data-a="copy">Copy replay code</button>
        <button data-a="export">Export match log</button>
      </div>
      <textarea readonly hidden>${code}</textarea>`, {
      help: () => { close(); showHelp(this.state); },
      copy: () => copyText(code),
      export: () => { close(); showExport(buildMatchLog(this.replay(), this.state, 'direct')); },
      quit: () => { close(); this.save(); this.onExit({ to: 'setup' }); },
      close: () => close(),
    });
  }

  private gameOver(): void {
    if (this.disposed) return;
    this.mode = { k: 'over' };
    this.view.sync(this.state);
    this.renderHud();
    this.save();
    const w = this.state.winner;
    const wiped = w !== 'draw' && w !== null && this.state.units.every((u) => u.team === w || !u.alive);
    const title = w === 'draw' ? 'Draw' : w === PLAYER ? 'Victory' : 'Defeat';
    const how = w === 'draw' ? 'Turn limit reached.' : wiped ? 'Team wiped out.' : `First to ${scoreToWin(this.state)} Beacon points.`;
    const code = encodeReplay(this.replay());
    const close = modal(`
      <h2>${title}</h2>
      <div>${this.state.score[0]} – ${this.state.score[1]} · ${how}</div>
      <div class="hint">${this.savedId ? 'Saved to your match library.' : 'This browser blocks storage, so copy the code to keep this match.'}</div>
      <textarea readonly hidden>${code}</textarea>
      <div class="btns">
        <button data-a="copy">Copy replay code</button>
        <button data-a="watch">Watch replay</button>
        <button data-a="setup">Change setup</button>
        <button data-a="rematch" class="primary">Rematch</button>
      </div>`, {
      copy: () => copyText(code),
      watch: () => { close(); this.onExit({ to: 'watch', replay: this.replay() }); },
      setup: () => { close(); this.onExit({ to: 'setup' }); },
      rematch: () => { close(); this.onExit({ to: 'rematch' }); },
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
