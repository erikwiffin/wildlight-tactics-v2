// Browser-local persistence: the saved match library and the last setup.
// Storage can be missing or throw (private mode, blocked site data), so every
// access is guarded and the game works without it.

import { RULES_VERSION } from '../core/engine';
import { MAPS } from '../core/map';
import { encodeReplay, type Replay } from '../core/replay';
import type { GameState, StrategyId } from '../core/types';

const LIB_KEY = 'wildlight.library.v1';
const PREFS_KEY = 'wildlight.prefs.v1';
const MAX_SAVED = 60;

export interface SavedMatch {
  id: string;
  name: string;
  savedAt: number;
  rulesVersion: number;
  code: string;
  mapId: string;
  mode: 'play' | 'aivai';
  ai: [StrategyId | null, StrategyId | null];
  winner: 0 | 1 | 'draw' | null;
  score: [number, number];
  actions: number;
}

function read<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function write(key: string, value: unknown): boolean {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

export const loadLibrary = (): SavedMatch[] => read<SavedMatch[]>(LIB_KEY, []);

export function defaultName(r: Replay, final: GameState): string {
  const map = MAPS[r.config.mapId]?.name ?? r.config.mapId;
  const [a, b] = r.config.ai ?? [null, 'balanced'];
  const cap = (s: string | null) => (s ? s[0].toUpperCase() + s.slice(1) : 'You');
  const who = a === null ? `You vs ${cap(b)} AI` : `${cap(a)} vs ${cap(b)}`;
  const res = final.winner === null ? 'unfinished' : `${final.score[0]}–${final.score[1]}`;
  return `${who} · ${map} · ${res}`;
}

/** Save (or update, when `id` is given) a match. Returns its id, or null if storage is unavailable. */
export function saveMatch(r: Replay, final: GameState, id?: string): string | null {
  const lib = loadLibrary();
  const existing = id ? lib.find((m) => m.id === id) : undefined;
  const entry: SavedMatch = {
    id: existing?.id ?? `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    name: existing?.name && !existing.name.endsWith('unfinished') ? existing.name : defaultName(r, final),
    savedAt: Date.now(),
    rulesVersion: r.config.rulesVersion,
    code: encodeReplay(r),
    mapId: r.config.mapId,
    mode: r.config.ai?.[0] == null ? 'play' : 'aivai',
    ai: r.config.ai ?? [null, 'balanced'],
    winner: final.winner,
    score: [...final.score],
    actions: r.actions.length,
  };
  const next = [entry, ...lib.filter((m) => m.id !== entry.id)].slice(0, MAX_SAVED);
  return write(LIB_KEY, next) ? entry.id : null;
}

export function renameMatch(id: string, name: string): void {
  write(LIB_KEY, loadLibrary().map((m) => (m.id === id ? { ...m, name } : m)));
}

export function deleteMatch(id: string): void {
  write(LIB_KEY, loadLibrary().filter((m) => m.id !== id));
}

export const isCurrentRules = (m: SavedMatch) => m.rulesVersion === RULES_VERSION;

export interface Prefs {
  mode: 'play' | 'aivai';
  /** In You vs AI: tap commands, or standing orders played by Claude. */
  control: 'direct' | 'orders';
  mapId: string;
  picks: string[];
  enemy: StrategyId;
  blue: StrategyId;
  orange: StrategyId;
  autoZoom: boolean;
}

const DEFAULT_PREFS: Prefs = {
  mode: 'play',
  control: 'direct',
  mapId: 'arena',
  picks: ['rhino', 'fox', 'moth', 'eel'],
  enemy: 'balanced',
  blue: 'aggressive',
  orange: 'defensive',
  autoZoom: true,
};

export const loadPrefs = (): Prefs => ({ ...DEFAULT_PREFS, ...read<Partial<Prefs>>(PREFS_KEY, {}) });
export const savePrefs = (p: Prefs): void => void write(PREFS_KEY, p);
