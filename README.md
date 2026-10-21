# Wildlight Tactics

A mobile-first hex tactics game in the style of Final Fantasy Tactics. Nanite-infected animals
fight 4v4 for control of three Beacons. See [DESIGN.md](DESIGN.md).

```sh
npm install
npm run dev            # http://localhost:5173. --host is on, so you can open it on your phone over LAN
npm test               # rules, determinism and replay tests
npm run sim            # AI-vs-AI balance report -> sim-report.txt
npm run build          # production build in dist/
npm run build:single   # dist/wildlight-tactics.html: one self-contained file
```

Add `?debug` to the URL to get `window.wl` (state, mode, screenOf, autoplay) for automated UI tests.

## Layout

```
src/core/     Deterministic rules: no DOM, no three.js, integer math only
  hex.ts        axial hex math, directions, lines
  rng.ts        seeded sfc32, serializable
  engine.ts     createMatch / applyAction, CT queue, combat, Beacons, Pulse
  ai.ts         greedy expected-value AI
  monsters.ts   roster and ability data
  map.ts        arena (point-symmetric)
  replay.ts     replay, state hash, share codes
src/render/   three.js view (reads state, never writes it)
src/ui/       DOM HUD, team select, input state machine
tests/        vitest
```
