// Spectator: watch a live AI-vs-AI simulation or a recorded match, with
// play/pause, speed, step, skip to end and a scrubbable timeline. Any point
// in the match is rebuilt exactly by replaying the log up to it.

import { unitAt } from '../core/engine';
import type { Hex } from '../core/hex';
import { encodeReplay, replay } from '../core/replay';
import { el, esc, modal } from './dom';
import { cap, copyText, MatchScreen } from './match';
import { saveMatch } from './store';
import type { ActionSource } from '../sim';

const SPEEDS = [1, 2, 4] as const;

export class WatchScreen extends MatchScreen {
  private playing = true;
  private speed: (typeof SPEEDS)[number] = 1;
  private pendingSeek: number | null = null;
  private stepOnce = false;
  private wakeFn: (() => void) | null = null;
  private dragging = false;
  private saved = false;
  private cardHost = el('div', 'card-host');
  private ui!: {
    play: HTMLButtonElement;
    step: HTMLButtonElement;
    end: HTMLButtonElement;
    restart: HTMLButtonElement;
    speed: HTMLButtonElement;
    range: HTMLInputElement;
    status: HTMLDivElement;
    result: HTMLDivElement;
  };
  private unsub: () => void;
  private keyHandler = (e: KeyboardEvent) => {
    if (e.code === 'Space' && !(e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement)) {
      e.preventDefault();
      this.togglePlay();
    }
  };

  constructor(
    host: HTMLElement,
    private src: ActionSource,
    private opts: { live: boolean; exitLabel: string; onExit: () => void },
  ) {
    const [a, b] = src.config.ai ?? [null, 'balanced'];
    super(host, src.config, a === null ? ['You', `${cap(b ?? 'balanced')} AI`] : [`Blue · ${cap(a)}`, `Orange · ${cap(b ?? 'balanced')}`]);
    this.buildControls();
    this.unsub = src.onChange(() => {
      this.maybeSave();
      this.updateControls();
      this.wake();
    });
    window.addEventListener('keydown', this.keyHandler);
    this.renderHud();
    this.frameActive();
    this.maybeSave();
    void this.loop();
  }

  dispose(): void {
    this.unsub();
    window.removeEventListener('keydown', this.keyHandler);
    if (this.opts.live) this.src.stop();
    super.dispose();
    this.wake();
  }

  // -------------------------------------------------------------------------
  // Playback loop

  private wake(): void {
    const f = this.wakeFn;
    this.wakeFn = null;
    f?.();
  }

  private async loop(): Promise<void> {
    while (!this.disposed) {
      if (this.pendingSeek !== null) {
        const k = this.pendingSeek;
        this.pendingSeek = null;
        this.seek(k);
        continue;
      }
      const pos = this.log.length;
      if ((this.playing || this.stepOnce) && pos < this.src.actions.length) {
        const wasStep = this.stepOnce;
        this.stepOnce = false;
        if (!wasStep) await this.sleep(140);
        if (this.pendingSeek !== null || this.disposed) continue;
        const a = this.src.actions[pos];
        await this.telegraph(a);
        await this.commit(a);
        this.view.speed = this.speed; // undo any seek fast-forward
        this.updateControls();
        continue;
      }
      if (this.playing && pos >= this.src.actions.length && this.src.complete) this.playing = false;
      this.updateControls();
      await new Promise<void>((r) => (this.wakeFn = r));
    }
  }

  private requestSeek(k: number): void {
    this.pendingSeek = Math.max(0, Math.min(k, this.src.actions.length));
    this.view.speed = 40; // let any running animation finish almost instantly
    this.wake();
  }

  private seek(k: number): void {
    this.state = replay({ config: this.src.config, actions: this.src.actions }, k);
    this.log = this.src.actions.slice(0, k);
    this.view.speed = this.speed;
    this.view.clearHighlights();
    this.view.sync(this.state);
    this.renderHud();
    this.frameActive();
    this.updateControls();
  }

  private togglePlay(): void {
    if (!this.playing && this.log.length >= this.src.actions.length && this.src.complete) this.requestSeek(0);
    this.playing = !this.playing;
    this.updateControls();
    this.wake();
  }

  private maybeSave(): void {
    if (!this.opts.live || this.saved || !this.src.complete) return;
    this.saved = true;
    const r = { config: this.src.config, actions: this.src.actions };
    saveMatch(r, replay(r));
  }

  // -------------------------------------------------------------------------
  // Controls

  private buildControls(): void {
    const wrap = el('div', 'watch-ctrl');
    const transport = el('div', 'transport');
    const b = (label: string, aria: string, on: () => void) => {
      const x = el('button', '', label);
      x.setAttribute('aria-label', aria);
      x.title = aria;
      x.onclick = on;
      transport.append(x);
      return x;
    };
    const restart = b('⏮', 'Restart', () => this.requestSeek(0));
    const play = b('❚❚', 'Pause', () => this.togglePlay());
    play.classList.add('primary');
    const step = b('⏵|', 'Step one action', () => {
      this.playing = false;
      this.stepOnce = true;
      this.wake();
    });
    const end = b('⏭', 'Skip to end', () => {
      this.playing = false;
      if (this.src.complete) this.requestSeek(this.src.actions.length);
      else {
        this.ui.status.textContent = 'Simulating the rest of the match…';
        const off = this.src.onChange(() => {
          if (!this.src.complete) return;
          off();
          this.requestSeek(this.src.actions.length);
        });
      }
    });
    const speed = b('1×', 'Playback speed', () => {
      this.speed = SPEEDS[(SPEEDS.indexOf(this.speed) + 1) % SPEEDS.length];
      this.view.speed = this.speed;
      this.updateControls();
    });
    speed.classList.add('speed');

    const range = el('input', 'timeline');
    range.type = 'range';
    range.id = 'timeline';
    range.min = '0';
    range.step = '1';
    range.setAttribute('aria-label', 'Match timeline');
    range.addEventListener('pointerdown', () => {
      this.dragging = true;
      this.playing = false;
    });
    const release = () => (this.dragging = false);
    range.addEventListener('pointerup', release);
    range.addEventListener('pointercancel', release);
    range.addEventListener('change', release);
    range.addEventListener('input', () => {
      this.playing = false;
      this.requestSeek(Number(range.value));
    });

    const status = el('div', 'hint watch-status');
    const result = el('div', 'watch-result');
    result.hidden = true;
    wrap.append(transport, range, status, result);
    this.els.panel.replaceChildren(this.cardHost, wrap);
    this.ui = { play, step, end, restart, speed, range, status, result };
  }

  private updateControls(): void {
    if (!this.ui || this.disposed) return;
    const pos = this.log.length;
    const len = this.src.actions.length;
    const atEnd = pos >= len && this.src.complete;
    this.ui.play.textContent = this.playing ? '❚❚' : atEnd ? '↻' : '▶';
    this.ui.play.setAttribute('aria-label', this.playing ? 'Pause' : atEnd ? 'Watch again' : 'Play');
    this.ui.step.disabled = pos >= len;
    this.ui.end.disabled = atEnd;
    this.ui.restart.disabled = pos === 0;
    this.ui.speed.textContent = `${this.speed}×`;
    this.ui.range.max = String(Math.max(1, len));
    if (!this.dragging) this.ui.range.value = String(pos);
    const sim = this.src.complete ? '' : ` · simulating (${len} so far)`;
    this.ui.status.textContent = `Action ${pos} / ${len}${sim} · Pulse ${this.state.pulses}`;
    const w = this.state.winner;
    this.ui.result.hidden = w === null;
    if (w !== null) {
      const who = w === 'draw' ? 'Draw' : `${this.sideNames[w]} wins`;
      this.ui.result.innerHTML = `<b>${esc(who)}</b> ${this.state.score[0]}–${this.state.score[1]}`;
    }
  }

  protected renderPanel(): void {
    const u = this.shownUnit();
    this.cardHost.replaceChildren(...(u ? [this.unitCard(u, null)] : []));
    this.updateControls();
  }

  protected onTap(h: Hex | null): void {
    this.inspect = h ? unitAt(this.state, h)?.id ?? null : null;
    this.renderPanel();
  }

  protected openMenu(): void {
    const r = { config: this.src.config, actions: this.src.actions };
    const code = this.src.complete ? encodeReplay(r) : '';
    const close = modal(`
      <h2>${this.opts.live ? 'AI vs AI' : 'Replay'}</h2>
      <div class="hint">Seed <b>${esc(this.src.config.seed)}</b> · ${this.src.actions.length} actions${this.src.complete ? '' : ' so far'}${this.opts.live && this.src.complete ? ' · saved to library' : ''}</div>
      ${code ? `<textarea readonly>${code}</textarea>` : '<div class="hint">The replay code is ready once the simulation finishes.</div>'}
      <div class="btns">
        <button data-a="copy" ${code ? '' : 'disabled'}>Copy replay code</button>
        <button data-a="exit">${esc(this.opts.exitLabel)}</button>
      </div>
      <button data-a="close" class="primary">Resume</button>`, {
      copy: () => copyText(code),
      exit: () => { close(); this.opts.onExit(); },
      close: () => close(),
    });
  }
}
