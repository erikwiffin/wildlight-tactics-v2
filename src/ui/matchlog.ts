// Match log: everything needed to reproduce and diagnose a match, as one
// copyable JSON text. The replay code rebuilds every board state exactly;
// for orders mode it also carries each agent turn's orders, tool calls,
// results and report, so a bad decision can be traced to what Claude saw.

import { MAPS } from '../core/map';
import { decodeReplay, encodeReplay, type Replay } from '../core/replay';
import type { GameState } from '../core/types';
import type { ToolCallRecord } from '../agent/agent';
import { modal, esc } from './dom';
import { copyText } from './match';

export interface AgentTurnLog {
  /** Number of actions already played when this turn started. */
  at: number;
  unit: number;
  /** All of the player's orders at that moment, by unit id. */
  orders: Record<number, string>;
  trace: ToolCallRecord[];
  /** What the unit actually did according to the game. */
  facts?: string;
  report?: string;
  error?: string;
  note?: string;
  model?: string;
  ms: number;
}

export interface MatchLog {
  format: 'wildlight-match-log';
  version: 1;
  exportedAt: string;
  rulesVersion: number;
  mode: 'direct' | 'orders' | 'aivai';
  map: string;
  replay: string;
  actions: number;
  result: { winner: GameState['winner']; score: [number, number]; pulses: number };
  agentTurns?: AgentTurnLog[];
  feed?: string[];
}

export function buildMatchLog(
  r: Replay,
  state: GameState,
  mode: MatchLog['mode'],
  extra: { agentTurns?: AgentTurnLog[]; feed?: string[] } = {},
): string {
  const log: MatchLog = {
    format: 'wildlight-match-log',
    version: 1,
    exportedAt: new Date().toISOString(),
    rulesVersion: r.config.rulesVersion,
    mode,
    map: MAPS[r.config.mapId]?.name ?? r.config.mapId,
    replay: encodeReplay(r),
    actions: r.actions.length,
    result: { winner: state.winner, score: [...state.score], pulses: state.pulses },
    ...extra,
  };
  return JSON.stringify(log);
}

/** Accepts a match log or a bare replay code. */
export function parseMatchLog(text: string): { replay: Replay; log?: MatchLog } {
  const t = text.trim();
  if (t.startsWith('{')) {
    const log = JSON.parse(t) as MatchLog;
    if (log.format !== 'wildlight-match-log') throw new Error('Not a Wildlight match log');
    return { replay: decodeReplay(log.replay), log };
  }
  return { replay: decodeReplay(t) };
}

/** A modal with the log text and a Copy button. */
export function showExport(text: string): void {
  const kb = (text.length / 1024).toFixed(1);
  const close = modal(`
    <h2>Match log</h2>
    <div class="hint">Every action so far${text.includes('"agentTurns"') ? ', plus each Claude turn’s orders, tool calls and report' : ''} (${kb} KB). Paste it to Claude to replay and debug the match, or import it from the Library to watch it.</div>
    <textarea readonly id="export-log">${esc(text)}</textarea>
    <div class="btns">
      <button data-a="close">Close</button>
      <button data-a="copy" class="primary" id="export-copy">Copy log</button>
    </div>`, {
    copy: () => {
      copyText(text);
      const b = document.getElementById('export-copy');
      if (b) b.textContent = 'Copied';
    },
    close: () => close(),
  });
}
