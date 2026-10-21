# Wildlight Tactics

A mobile-first hex tactics game in the style of Final Fantasy Tactics. Nanite-infected animals
fight for control of Beacons on four maps (3v3 to 5v5). Play against an AI with a chosen
strategy, or watch AI vs AI with a scrubbable timeline. See [DESIGN.md](DESIGN.md).

```sh
npm install
npm run dev            # http://localhost:5173. --host is on, so you can open it on your phone over LAN
npm test               # rules, determinism and replay tests
npm run sim            # AI-vs-AI balance report -> sim-report.txt (SIM_PART=maps|drafts|behavior, SIM_GAMES=n)
npm run build          # production build in dist/
npm run build:single   # dist/wildlight-tactics.html: one self-contained file
```

Add `?debug` to the URL to expose the current screen as `window.wl` for automated UI tests.

## Layout

```
src/core/     Deterministic rules: no DOM, no three.js, integer math only
  hex.ts        axial hex math, directions, lines
  rng.ts        seeded sfc32, serializable
  engine.ts     createMatch / applyAction, CT queue, combat, Beacons, Pulse
  ai.ts         greedy expected-value AI, strategy weights, drafts
  selfplay.ts   AI-vs-AI match generation
  monsters.ts   roster and ability data
  map.ts        four point-symmetric maps
  replay.ts     replay, state hash, share codes
src/render/   three.js view (reads state, never writes it), auto-zoom
src/ui/       setup, play (input state machine), watch (playback), library, storage
src/sim.ts    streams an AI-vs-AI match from a Web Worker (sim.worker.ts)
tests/        vitest
```
