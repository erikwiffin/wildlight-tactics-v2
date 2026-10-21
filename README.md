# Wildlight Tactics

A mobile-first hex tactics game in the style of Final Fantasy Tactics. Nanite-infected animals
fight for control of Beacons on four maps (3v3 to 5v5). Play against an AI with a chosen
strategy, or watch AI vs AI with a scrubbable timeline. See [DESIGN.md](DESIGN.md).

```sh
npm install
cp .env.example .env.local   # then set ANTHROPIC_API_KEY (needed only for orders mode)
npm run dev            # http://localhost:5173. --host is on, so you can open it on your phone over LAN
npm test               # rules, determinism and replay tests
npm run sim            # AI-vs-AI balance report -> sim-report.txt (SIM_PART=maps|drafts|behavior, SIM_GAMES=n)
npm run build          # production build in dist/
npm run build:single   # dist/wildlight-tactics.html: one self-contained file
```

## Orders mode (Claude)

In **You vs AI → How you play → Give orders (Claude)**, you don't command units directly. You
give each unit a standing order in plain language, typed or dictated with the 🎤 button.
Claude Haiku 5.5 then plays each of your turns:

- It sees the same information your screen shows.
- It acts through the same legal moves and abilities.
- It coordinates using all of your units' orders.

You can edit orders at any time, and a change applies from that unit's next turn. Any failure
pauses the match with **Retry** and **Skip turn** buttons.

**How the key is handled:**
- The browser never holds the API key. Calls go to `/api/agent/v1/messages` on the dev or
  preview server (`server/anthropic-proxy.ts`), which:
  - adds the key from `.env.local`
  - pins the model to `claude-haiku-5-5`
  - caps `max_tokens` and rate-limits requests
  - by default only answers requests from the same computer (`AGENT_ALLOW_LAN=1` opens it to
    your network)
- **On claude.ai** (the published artifact), the game uses the artifact's `sample` capability
  instead. Claude runs on the viewer's own Claude account after a one-time permission prompt,
  with no key involved. The same four tools run in the page.
  - Build it with `npm run build:artifact` → `dist/artifact.html`.
  - Publish it declaring `capabilities: {sample: {}}`.
- Other static hosting has neither a proxy nor `sample`, so orders mode shows as unavailable
  there.

**Dictation:**
- It uses the browser's built-in speech recognition, and only needs a secure context: https or
  localhost. Over plain-http LAN it isn't available.
- The button is hidden where the browser has no support (for example, Firefox).
- Chrome sends the audio to Google for recognition.

```sh
LIVE=1 npx vitest run    # plays a few real agent turns against the API -> live-report.txt
```

## Recording and debugging matches

- **Every match is recorded as it's played** (tap commands, orders mode and AI vs AI), and
  updated in the Library after each turn. An unfinished match shows as *In progress*.
- **Export match log:**
  - Where: the Export button in orders mode, or ☰ → Export match log.
  - What: one JSON text with the replay code. In orders mode it also carries each Claude turn:
    the orders in force, every tool call with its result, the report or error, the model and
    the timing.
  - The Library's *Copy log* button gives the same text for saved orders-mode games, and
    *Import code* accepts a log as well as a replay code.
- **Inspecting a log:**

  ```sh
  LOG=path/to/log.json npm run inspect      # -> inspect-report.txt
  TOOL=1 npx vitest run tests/maps.tool.ts  # map drawings + cover/sight-line stats -> map-report.txt
  ```

  This replays the match and prints, for each Claude turn, the exact briefing it was given,
  then its tool calls and report. Optional: `TURNS=3,4` to filter, `BRIEFING=0` to skip
  briefings.

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
src/agent/    order-following agent: briefing/visibility (context.ts), tools + loop (agent.ts)
src/sim.ts    streams an AI-vs-AI match from a Web Worker (sim.worker.ts)
server/       dev/preview-server proxy that holds the API key
tests/        vitest
```
