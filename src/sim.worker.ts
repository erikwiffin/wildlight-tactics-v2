// Plays a whole AI-vs-AI match off the main thread and streams the actions back.
import { runSimulation } from './core/selfplay';
import type { MatchConfig } from './core/types';

self.onmessage = (e: MessageEvent<{ config: MatchConfig }>) => {
  runSimulation(e.data.config, (actions) => self.postMessage({ type: 'actions', actions }));
  self.postMessage({ type: 'done' });
};
