// Auto-battler mode: the player writes a standing order per unit (typed or
// dictated); Claude Haiku plays each of the player's turns from those orders,
// and the scripted AI plays the enemy. Orders can be edited at any time and
// apply from that unit's next turn. Any agent failure pauses the match.

import { nextAiAction } from '../core/ai';
import { activeUnit, aliveOn, defOf, scoreToWin } from '../core/engine';
import type { Hex } from '../core/hex';
import { encodeReplay, type Replay } from '../core/replay';
import type { Action, GameEvent, MatchConfig, Role, StrategyId } from '../core/types';
import { AgentError, browserClient, runUnitTurn, type AgentClient } from '../agent/agent';
import { summarizeEvents, unitName } from '../agent/context';
import { el, esc, modal } from './dom';
import { cap, copyText, MatchScreen, mono } from './match';
import type { PlayExit } from './play';
import { micButton } from './speech';
import { saveMatch } from './store';

const PLAYER = 0;

const EXAMPLES: Record<Role, string> = {
  tank: 'Hold the center Beacon and keep enemies off our healer.',
  skirmisher: 'Steal undefended Beacons; avoid fair fights.',
  support: 'Stay behind the tank and keep everyone healed.',
  zoner: 'Spike the approaches to our home Beacon and guard it.',
  ranged: 'Stay on high ground and shoot whoever threatens the tank.',
  assassin: 'Flank their backline and finish wounded enemies.',
  controller: 'Pull enemies off our Beacons and slow anyone rushing us.',
};

/** Orders survive rematches within a session, keyed by monster. */
const remembered: Record<string, string> = {};

type FeedKind = 'report' | 'step' | 'enemy' | 'system' | 'error';

export class OrdersScreen extends MatchScreen {
  private orders: Record<number, string> = {};
  private paused = true;
  private started = false;
  private thinking: number | null = null;
  private wakeFn: (() => void) | null = null;
  private abort: AbortController | null = null;
  private client: AgentClient;
  private enemy: StrategyId;
  private feedLog: { kind: FeedKind; text: string }[] = [];
  private savedId: string | null = null;
  private tab: 'orders' | 'feed' = 'orders';
  private ui!: {
    card: HTMLDivElement;
    status: HTMLDivElement;
    go: HTMLButtonElement;
    alert: HTMLDivElement;
    tabs: Record<'orders' | 'feed', HTMLButtonElement>;
    ordersPane: HTMLDivElement;
    feedPane: HTMLDivElement;
    rows: Map<number, HTMLElement>;
  };

  constructor(host: HTMLElement, config: MatchConfig, private onExit: (e: PlayExit) => void, client?: AgentClient) {
    const enemy = config.ai?.[1] ?? 'balanced';
    super(host, config, ['You', `${cap(enemy)} AI`]);
    this.enemy = enemy;
    this.client = client ?? browserClient();
    for (const u of aliveOn(this.state, PLAYER)) this.orders[u.id] = remembered[u.defId] ?? '';
    this.build();
    this.renderHud();
    this.frameActive();
    this.setPaused(true, 'Give each unit an order, then press Start.');
    void this.loop();
  }

  dispose(): void {
    this.abort?.abort();
    super.dispose();
    this.wake();
  }

  /** Hooks for automated UI tests (enabled with ?debug). */
  debug() {
    return { state: () => this.state, feed: () => this.feedLog, paused: () => this.paused, setOrder: (id: number, t: string) => this.setOrder(id, t) };
  }

  // -------------------------------------------------------------------------
  // Loop

  private wake(): void {
    const f = this.wakeFn;
    this.wakeFn = null;
    f?.();
  }

  private async loop(): Promise<void> {
    while (!this.disposed && this.state.winner === null) {
      if (this.paused) {
        await new Promise<void>((r) => (this.wakeFn = r));
        continue;
      }
      const u = activeUnit(this.state)!;
      if (u.team !== PLAYER) {
        await this.sleep(200);
        if (this.disposed || this.paused) continue;
        const a = nextAiAction(this.state, this.enemy);
        await this.telegraph(a);
        this.logEvents(await this.commit(a), 'enemy');
        continue;
      }
      const order = this.orders[u.id]?.trim();
      if (!order) {
        this.tab = 'orders';
        this.setPaused(true, `${unitName(u)} has no order. Write one, then press Resume.`);
        this.ui.rows.get(u.id)?.querySelector('textarea')?.focus();
        continue;
      }
      this.thinking = u.id;
      this.renderStatus();
      this.abort = new AbortController();
      try {
        const res = await runUnitTurn(
          {
            client: this.client,
            state: () => this.state,
            commit: (a) => this.commitAgent(a),
            onStep: (t) => this.addFeed('step', t),
            signal: this.abort.signal,
          },
          u.id,
          { ...this.orders },
          this.recent(),
        );
        this.addFeed('report', `${unitName(u)}: ${res.report}`);
      } catch (e) {
        if (this.disposed) return;
        const msg = e instanceof AgentError ? e.message : `Unexpected error: ${(e as Error).message}`;
        this.addFeed('error', `${unitName(u)}: ${msg}`);
        this.setPaused(true, `${unitName(u)}'s turn stopped: ${msg}`, true);
      } finally {
        this.thinking = null;
        this.abort = null;
        this.renderStatus();
      }
    }
    if (!this.disposed) this.gameOver();
  }

  private async commitAgent(a: Action): Promise<GameEvent[]> {
    await this.telegraph(a);
    const events = await this.commit(a);
    // Moves and abilities are narrated via onStep; ending a turn can trigger
    // captures, Pulses and other units' status ticks, which go to the feed here.
    if (a.type === 'end') this.logEvents(events, 'system');
    return events;
  }

  /** Feed lines for events; match-level events (captures, Pulses, KOs) are marked as system lines. */
  private logEvents(events: GameEvent[], kind: FeedKind): void {
    for (const e of events) {
      for (const line of summarizeEvents(this.state, [e])) {
        const sys = e.type === 'capture' || e.type === 'pulse' || e.type === 'ko' || e.type === 'gameOver';
        this.addFeed(sys ? 'system' : kind, line);
      }
    }
  }

  /** The last few things that happened, as the player's feed shows them. */
  private recent(): string[] {
    return this.feedLog.filter((f) => f.kind !== 'error').slice(-14).map((f) => f.text);
  }

  private setPaused(p: boolean, msg = '', isError = false): void {
    this.paused = p;
    if (this.ui) {
      this.ui.alert.hidden = !msg;
      this.ui.alert.classList.toggle('error', isError);
      this.ui.alert.replaceChildren(el('div', '', msg));
      if (isError) {
        const btns = el('div', 'alert-btns');
        const retry = el('button', 'primary', 'Retry');
        retry.onclick = () => this.resume();
        const skip = el('button', '', 'Skip turn');
        skip.onclick = () => void this.skipTurn();
        btns.append(retry, skip);
        this.ui.alert.append(btns);
      }
    }
    this.renderStatus();
    if (!p) this.wake();
  }

  private resume(): void {
    this.started = true;
    this.setPaused(false);
  }

  private async skipTurn(): Promise<void> {
    const u = activeUnit(this.state);
    if (u && u.team === PLAYER) {
      const events = await this.commit({ type: 'end', unit: u.id, facing: u.facing });
      this.addFeed('system', `${unitName(u)} waited (turn skipped).`);
      void events;
    }
    this.resume();
  }

  private setOrder(id: number, text: string): void {
    this.orders[id] = text;
    remembered[this.state.units[id].defId] = text;
    const ta = this.ui.rows.get(id)?.querySelector('textarea');
    if (ta && ta.value !== text) ta.value = text;
    this.renderStatus();
  }

  // -------------------------------------------------------------------------
  // Panel (built once so typing and dictation are never interrupted)

  private build(): void {
    const card = el('div', 'card-host');
    const bar = el('div', 'agent-bar');
    const status = el('div', 'agent-status');
    const go = el('button', 'primary', 'Start');
    go.onclick = () => (this.paused ? this.resume() : this.setPaused(true, 'Paused. Orders apply from each unit’s next turn.'));
    bar.append(status, go);
    const alert = el('div', 'agent-alert');
    alert.hidden = true;
    const tabsRow = el('div', 'tabs');
    tabsRow.setAttribute('role', 'tablist');
    const tabs = {
      orders: el('button', '', 'Orders'),
      feed: el('button', '', 'Feed'),
    };
    for (const k of ['orders', 'feed'] as const) {
      tabs[k].setAttribute('role', 'tab');
      tabs[k].onclick = () => {
        this.tab = k;
        this.renderStatus();
      };
      tabsRow.append(tabs[k]);
    }
    const ordersPane = el('div', 'orders-pane');
    const rows = new Map<number, HTMLElement>();
    for (const u of this.state.units.filter((x) => x.team === PLAYER)) {
      const row = el('div', 'order-row');
      const label = el('label', 'order-label');
      label.htmlFor = `order-${u.id}`;
      label.innerHTML = `<span class="mono t0">${mono(u.defId)}</span><span>${esc(defOf(u).name)}</span><small>${defOf(u).role}</small>`;
      const ta = el('textarea', 'order-input');
      ta.id = `order-${u.id}`;
      ta.rows = 2;
      ta.placeholder = `e.g. ${EXAMPLES[defOf(u).role]}`;
      ta.value = this.orders[u.id] ?? '';
      ta.oninput = () => this.setOrder(u.id, ta.value);
      const field = el('div', 'order-field');
      field.append(ta);
      const mic = micButton(ta, () => this.setOrder(u.id, ta.value), (m) => this.toast(m));
      if (mic) field.append(mic);
      row.append(label, field);
      ordersPane.append(row);
      rows.set(u.id, row);
    }
    const fill = el('button', 'ghost small', 'Fill example orders');
    fill.onclick = () => {
      for (const u of this.state.units.filter((x) => x.team === PLAYER)) {
        if (!this.orders[u.id]?.trim()) this.setOrder(u.id, EXAMPLES[defOf(u).role]);
      }
    };
    ordersPane.append(fill);
    const feedPane = el('div', 'feed-pane');
    feedPane.setAttribute('aria-live', 'polite');
    const head = el('div', 'panel-head');
    head.append(bar, alert, tabsRow);
    this.els.panel.replaceChildren(head, card, ordersPane, feedPane);
    this.ui = { card, status, go, alert, tabs, ordersPane, feedPane, rows };
  }

  private renderStatus(): void {
    if (!this.ui) return;
    const u = activeUnit(this.state);
    let text: string;
    if (this.state.winner !== null) text = 'Match over';
    else if (this.thinking !== null) text = `${unitName(this.state.units[this.thinking])} is thinking…`;
    else if (this.paused) text = this.started ? 'Paused' : 'Ready';
    else text = u && u.team !== PLAYER ? 'Enemy turn…' : '…';
    this.ui.status.textContent = text;
    this.ui.status.classList.toggle('busy', this.thinking !== null);
    this.ui.go.textContent = this.paused ? (this.started ? 'Resume' : 'Start') : 'Pause';
    this.ui.go.disabled = this.state.winner !== null;
    this.ui.go.classList.toggle('primary', this.paused);
    for (const k of ['orders', 'feed'] as const) this.ui.tabs[k].setAttribute('aria-selected', String(this.tab === k));
    this.ui.ordersPane.hidden = this.tab !== 'orders';
    this.ui.feedPane.hidden = this.tab !== 'feed';
    for (const [id, row] of this.ui.rows) {
      const unit = this.state.units[id];
      row.classList.toggle('ko', !unit.alive);
      row.classList.toggle('active', this.thinking === id);
      const ta = row.querySelector('textarea')!;
      ta.disabled = !unit.alive;
    }
  }

  private addFeed(kind: FeedKind, text: string): void {
    this.feedLog.push({ kind, text });
    if (this.feedLog.length > 200) this.feedLog.shift();
    const line = el('div', `feed-line ${kind}`, text);
    this.ui.feedPane.append(line);
    while (this.ui.feedPane.childElementCount > 200) this.ui.feedPane.firstElementChild?.remove();
    line.scrollIntoView({ block: 'nearest' });
    if (kind === 'report' && this.tab === 'orders' && this.started && !this.paused) {
      // First report switches to the feed so the player sees the narration.
      if (this.feedLog.filter((f) => f.kind === 'report').length === 1) {
        this.tab = 'feed';
        this.renderStatus();
      }
    }
  }

  protected renderPanel(): void {
    if (!this.ui) return;
    const u = this.inspect !== null ? this.state.units[this.inspect] : null;
    this.ui.card.replaceChildren(...(u ? [this.unitCard(u, PLAYER)] : []));
    this.renderStatus();
  }

  protected onTap(h: Hex | null): void {
    const tapped = h ? this.state.units.find((x) => x.alive && x.pos.q === h.q && x.pos.r === h.r) : undefined;
    this.inspect = tapped?.id ?? null;
    this.renderPanel();
    if (tapped && tapped.team === PLAYER) {
      this.tab = 'orders';
      this.renderStatus();
      this.ui.rows.get(tapped.id)?.querySelector('textarea')?.focus({ preventScroll: true });
    }
  }

  // -------------------------------------------------------------------------
  // Menu and game over

  private replay(): Replay {
    return { config: this.state.config, actions: [...this.log] };
  }

  private save(): void {
    if (this.log.length) this.savedId = saveMatch(this.replay(), this.state, this.savedId ?? undefined);
  }

  protected openMenu(): void {
    const code = encodeReplay(this.replay());
    const close = modal(`
      <h2>Menu</h2>
      <div class="hint">Seed <b>${esc(this.state.config.seed)}</b> · ${this.log.length} actions · vs ${esc(cap(this.enemy))} AI · your units are played by Claude from your orders</div>
      <textarea readonly>${code}</textarea>
      <div class="btns">
        <button data-a="copy">Copy replay code</button>
        <button data-a="quit">Save and quit</button>
      </div>
      <button data-a="close" class="primary">Close</button>`, {
      copy: () => copyText(code),
      quit: () => { close(); this.save(); this.onExit({ to: 'setup' }); },
      close: () => close(),
    });
  }

  private gameOver(): void {
    this.view.sync(this.state);
    this.renderHud();
    this.save();
    const w = this.state.winner;
    const title = w === 'draw' ? 'Draw' : w === PLAYER ? 'Victory' : 'Defeat';
    const code = encodeReplay(this.replay());
    this.addFeed('system', `${title} ${this.state.score[0]}–${this.state.score[1]} (first to ${scoreToWin(this.state)}).`);
    const close = modal(`
      <h2>${title}</h2>
      <div>${this.state.score[0]} – ${this.state.score[1]}</div>
      <div class="hint">${this.savedId ? 'Saved to your match library.' : 'This browser blocks storage, so copy the code to keep this match.'}</div>
      <textarea readonly>${code}</textarea>
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
