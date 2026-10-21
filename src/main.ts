import './style.css';
import { aiTeam } from './core/ai';
import { newConfig } from './core/engine';
import { MAPS } from './core/map';
import type { Replay } from './core/replay';
import { ActionSource } from './sim';
import { showLibrary } from './ui/library';
import { OrdersScreen } from './ui/orders';
import { PlayScreen, type PlayExit } from './ui/play';
import { randomSeed, showSetup, type SetupResult } from './ui/setup';
import { WatchScreen } from './ui/watch';

const app = document.getElementById('app')!;
let screen: { dispose(): void } | null = null;
let last: SetupResult | null = null;
const debug = new URLSearchParams(location.search).has('debug');

function clear(): void {
  screen?.dispose();
  screen = null;
}

function setup(): void {
  clear();
  showSetup(app, start, library);
}

function library(): void {
  clear();
  showLibrary(app, (r) => watch(r, 'Back to library', library), setup);
}

function start(r: SetupResult): void {
  last = r;
  clear();
  const { prefs, seed } = r;
  const size = MAPS[prefs.mapId].teamSize;
  if (prefs.mode === 'play') {
    const config = newConfig(seed, [prefs.picks, aiTeam(seed, prefs.enemy, size, '1')], prefs.mapId, [null, prefs.enemy]);
    const game = prefs.control === 'orders' ? new OrdersScreen(app, config, onPlayExit) : new PlayScreen(app, config, onPlayExit);
    screen = game;
    if (debug) (window as unknown as { wl: unknown }).wl = game.debug();
  } else {
    const config = newConfig(
      seed,
      [aiTeam(seed, prefs.blue, size, '0'), aiTeam(seed, prefs.orange, size, '1')],
      prefs.mapId,
      [prefs.blue, prefs.orange],
    );
    const w = new WatchScreen(app, ActionSource.simulate(config), { live: true, exitLabel: 'Exit to setup', onExit: setup });
    screen = w;
    if (debug) (window as unknown as { wl: unknown }).wl = w;
  }
}

function watch(r: Replay, exitLabel: string, onExit: () => void): void {
  clear();
  const w = new WatchScreen(app, new ActionSource(r.config, r.actions), { live: false, exitLabel, onExit });
  screen = w;
  if (debug) (window as unknown as { wl: unknown }).wl = w;
}

function onPlayExit(e: PlayExit): void {
  if (e.to === 'rematch' && last) start({ ...last, seed: randomSeed() });
  else if (e.to === 'watch') watch(e.replay, 'Back to setup', setup);
  else setup();
}

setup();
