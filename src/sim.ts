// AI-vs-AI match source for the spectator. The match is fully determined by the config
// (seed, teams, strategies), so generating it in a worker and replaying the
// streamed actions here reproduces it exactly.

import { createMatch } from './core/engine';
import { MAX_SIM_ACTIONS, stepAi, strategiesOf } from './core/selfplay';
import type { Action, MatchConfig } from './core/types';
import SimWorker from './sim.worker?worker&inline';

/** A growing action log that a WatchScreen can play while it fills. */
export class ActionSource {
  actions: Action[] = [];
  complete = false;
  private listeners = new Set<() => void>();
  private stopFn: () => void = () => {};

  constructor(readonly config: MatchConfig, actions?: Action[]) {
    if (actions) {
      this.actions = actions;
      this.complete = true;
    }
  }

  /** Start generating an AI-vs-AI match. */
  static simulate(config: MatchConfig): ActionSource {
    const src = new ActionSource(config);
    src.start();
    return src;
  }

  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  stop(): void {
    this.stopFn();
  }

  private push(actions: Action[]): void {
    this.actions.push(...actions);
    this.listeners.forEach((f) => f());
  }

  private finish(): void {
    this.complete = true;
    this.listeners.forEach((f) => f());
  }

  private start(): void {
    try {
      const w = new SimWorker();
      w.onmessage = (e: MessageEvent<{ type: 'actions'; actions: Action[] } | { type: 'done' }>) => {
        if (e.data.type === 'actions') this.push(e.data.actions);
        else {
          this.finish();
          w.terminate();
        }
      };
      w.onerror = () => {
        w.terminate();
        this.startOnMainThread();
      };
      w.postMessage({ config: this.config });
      this.stopFn = () => w.terminate();
    } catch {
      this.startOnMainThread();
    }
  }

  /** Fallback: generate in small time slices so the page stays responsive. */
  private startOnMainThread(): void {
    this.actions = [];
    const strategies = strategiesOf(this.config);
    const state = createMatch(this.config);
    let stopped = false;
    this.stopFn = () => (stopped = true);
    const slice = () => {
      if (stopped) return;
      const t0 = performance.now();
      const batch: Action[] = [];
      while (state.winner === null && batch.length + this.actions.length < MAX_SIM_ACTIONS && performance.now() - t0 < 12) {
        batch.push(stepAi(state, strategies));
      }
      if (batch.length) this.push(batch);
      if (state.winner === null && this.actions.length < MAX_SIM_ACTIONS) setTimeout(slice, 0);
      else this.finish();
    };
    setTimeout(slice, 0);
  }
}
