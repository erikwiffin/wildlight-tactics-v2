import './style.css';
import { aiTeam } from './core/ai';
import { newConfig } from './core/engine';
import type { Replay } from './core/replay';
import { GameScreen } from './ui/game';
import { randomSeed, showSelect } from './ui/select';

const app = document.getElementById('app')!;
let game: GameScreen | null = null;
let lastTeam: string[] = ['rhino', 'fox', 'moth', 'eel'];

function title(): void {
  game?.dispose();
  game = null;
  showSelect(app, lastTeam, startMatch, watch);
}

function startMatch(team: string[], seed: string): void {
  lastTeam = team;
  game?.dispose();
  const config = newConfig(seed, [team, aiTeam(seed, team)]);
  game = new GameScreen(app, { config, onExit });
  if (new URLSearchParams(location.search).has('debug')) (window as unknown as { wl: unknown }).wl = game.debug();
}

function watch(r: Replay): void {
  game?.dispose();
  game = new GameScreen(app, { config: r.config, replay: r, onExit });
}

function onExit(next: 'rematch' | 'roster' | 'title'): void {
  if (next === 'rematch') startMatch(lastTeam, randomSeed());
  else title();
}

title();
