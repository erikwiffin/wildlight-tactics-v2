# Wildlight Tactics: MVP Design (v0.3)

A mobile-first, FFT-style tactics game. Two teams of nanite-infected animals fight
on hex arenas for control of the Beacons.

## Pillars

1. **Readable on a phone.** You tap, preview, then confirm. Every number is shown before you commit.
2. **Fully deterministic.** A match is `seed + rules version + team picks + action log`.
   Any match can be replayed exactly.
3. **Objective-driven fights.** The way you win is by holding Beacons (MOBA-style).
   Killing is a means to that end.

## Setting

A nanite swarm called the **Wildlight** has spread through the wild. It infects real
animals and gives them supernatural abilities. The **Beacons** are nanite relay towers,
and holding them feeds your swarm.

## Match rules

| | |
|---|---|
| Teams | Player vs AI, or AI vs AI (spectated). Team size is set by the map (3–5), picked from a roster of 7. |
| Win | Reach the map's score target, or KO the whole enemy team |
| Scoring | The **Pulse** fires on a fixed rhythm and gives +1 per Beacon held |
| Capture | End your turn on a Beacon with no enemy adjacent. It stays yours until flipped. |
| KO | Permanent for the match. No respawns, no comeback mechanic. |
| Turn limit | After 40 Pulses the higher score wins, and equal scores are a draw |

### Maps

All maps are point-symmetric, so (q, r) mirrors to (−q, −r). Spawns, facings and Beacons
mirror too, so neither side is favored.

| Map | Shape | Team size | Beacons | Score target | Character |
|---|---|---|---|---|---|
| Glass Hollow | hexagon, radius 4 (61 hexes) | 3v3 | 2 | 10 | A duel map. Two flank Beacons and a rock spine that breaks sight lines. |
| Shattered Basin | hexagon, radius 6 (127 hexes) | 4v4 | 3 | 15 | The standard map: home Beacons and a raised center |
| Caldera | ring, radius 7, lava core | 4v4 | 4 | 15 | You can shoot across the lava, but you have to walk around it |
| Fault Lines | 13-wide rectangle (188 hexes) | 5v5 | 5 | 20 | Three lanes split by rock ridges |

**Terrain:**
- Normal costs 1 movement and Rough costs 2.
- **Rock** is impassable and blocks sight.
- **Lava** (Caldera's void) is impassable but doesn't block sight.

### Turn order (CT)
- Each unit gains CT by its Speed every tick and acts at 100.
  - Moving and acting costs 100 CT. Doing just one costs 80. Waiting costs 60.
  - CT is capped at 60 after a turn.
- **The Pulse** sits in the queue at Speed 7.
- **Charged abilities** (Storm Call, Nanite Bloom) enter the queue and resolve later on
  the targeted *hex*, so units can step out of them. They fizzle if the caster is KO'd.
- **Tie-breaks:** charges resolve first, then the Pulse, then units by highest CT and lowest
  id. Unit ids interleave the teams (A0, B0, A1, …).
- The turn bar previews the next 12 entries.

### A turn
- Move and act in either order, then pick a facing.
- A move can be undone until you act, since moving uses no randomness.
- Movement is limited by Move (in hex steps; Rough costs 2) and Jump (the max height
  change per step).
- Units can pass through allies but not enemies.

### Combat
- **Facing arcs:** a unit faces one of 6 directions.

  | Arc | Hexes | Damage | Hit |
  |---|---|---|---|
  | Front | facing ±1 (3 hexes) | ×1.0 | base |
  | Flank | ±2 (2 hexes) | ×1.25 | +15% |
  | Rear | opposite (1 hex) | ×1.5 | guaranteed |

- **Height:** +10% damage per level above the target and −10% per level below (capped at ±3).
  - Ranged abilities get +1 range from 2 or more levels up.
  - Melee abilities can't reach more than 2 levels up or down.
- **Damage:** `floor(stat × power × 1.5) × 100 / (100 + 5 × DEF)`, then the arc and height
  multipliers. The minimum is 1.
- **Hit chance:** shown as a percentage and stored as basis points (8500 = 85%).
  The roll comes from the match's seeded RNG.

### Line of sight
- **Direct shots** need a clear line from the attacker to the target: Sting Dust, Zap,
  Static Snare, Lash, Tentacle Pull and Nanite Jam.
- **What blocks the line:**
  - rock
  - any tile 2+ levels higher than *both* ends (a wall)
  - **any unit, ally or enemy**, so the tank really is a shield for the backline
- **Lines along a hex edge** count as clear if either side is clear.
- **Exempt:**
  - Melee, which means adjacent targets
  - Arcing and area abilities: Quill Volley, Storm Call, Ink Cloud, Spike Field
  - Leaps: Phase Strike, Pounce
  - Ally support: heals and buffs
- **Arc Lance** pierces units but stops at rock and walls.
- **In the UI,** targets in range but out of sight show as grey hexes, and tapping one
  says "No line of sight".

### Statuses
| Status | Effect | What ends it |
|---|---|---|
| slow | half Speed | turns |
| stun | skip the next turn | turns |
| poison | X damage at turn start | turns |
| regen | +X HP at turn start | turns |
| shield | absorbs X damage | runs out |
| thorns | melee attackers take X damage | turns |
| camo | can't be targeted from more than 1 hex away | turns, or when it attacks |
| fortify | +X% DEF | turns |

Durations count down at the end of the affected unit's own turns.

## Roster

| Monster | Animal | Role | Kit |
|---|---|---|---|
| Bulwark Rhino | Black rhinoceros | Tank | Gore · Ram (push 2, collision damage) · Plate Up (shield + fortify) · Quake Stomp (AoE, CT −25) |
| Phase Fox | Red fox | Skirmisher | Bite · Phase Strike (blink-attack, range 2–4) · Rend (poison) · Hamstring (slow) |
| Lumen Moth | Atlas moth | Support | Sting Dust · Mend · Nanite Bloom (charged AoE heal + cleanse) · Regen Swarm |
| Quill Porcupine | Crested porcupine | Zoner | Quill Jab · Quill Volley (AoE) · Spike Field (hazard tiles) · Bristle (thorns) |
| Arc Eel | Electric eel | Ranged | Zap · Arc Lance (5-hex pierce) · Storm Call (charged AoE) · Static Snare (stun) |
| Shade Lynx | Eurasian lynx | Assassin | Claw · Ambush (+25% extra rear damage) · Pounce (leap-attack) · Optic Camo |
| Ink Octopus | Common octopus | Controller | Lash (reach 2) · Tentacle Pull · Ink Cloud (AoE slow) · Nanite Jam (CT −50) |

**Spike Field:** enemies that step onto the spiked hexes take 14 damage and stop moving
there. Pushes and pulls stop on them too.

All ability data lives in `src/core/monsters.ts`, and tuning it doesn't touch any logic.

## Determinism contract

- **The rules layer (`src/core`) uses integer math only.** No `Math.random`, no transcendental
  functions, no `Date`. Hex directions use integer cube-coordinate dot products, not `atan2`.
- **RNG:** sfc32 with four uint32s stored *inside* `GameState`, seeded from
  `rulesVersion:seed`. Every roll happens in a fixed order defined by the action being
  resolved.
- **The UI percentage is the same number the rules roll against.** "85%" means the next
  roll must be below 8500.
- **The AI never peeks.** It plans on `previewAbility` expected values, which use no RNG.
  The same state always produces the same AI action.
- **Undo** is a state rollback of a move, which uses no RNG, so it can't be used to re-roll.
- **Replays** are `{config, actions}` packed into a base64 share code. `config.ai` records who
  controlled each side. It's metadata only, since replays never need to re-run the AI.
  - `tests/determinism.test.ts` checks four things:
    - A match replays to an identical state hash.
    - The share code round-trips.
    - The same seed produces the same match.
    - A golden snapshot still matches.
  - Bump `RULES_VERSION` when rules change. The snapshot will flag the change.

## AI

The AI uses a greedy one-turn lookahead.
1. It enumerates every move and act combination (in either order) and every stay-and-act
   option.
2. It scores each one as a sum of terms: expected damage, likely KOs, crowd control, heals
   and buffs, Beacon capture and hold, distance to Beacons, approach, guarding, cohesion,
   and threat exposure.
3. Facing is chosen to keep enemies out of the flanks and rear.

**Strategies** are weight sets over those same terms (`WEIGHTS` in `src/core/ai.ts`). You pick
one per AI side at setup.

| Strategy | Plays like | Drafts |
|---|---|---|
| Balanced | Takes Beacons and trades when the trade is good | mixed |
| Aggressive | Big damage and KO weights, chases enemies, ignores risk | Lynx, Fox, Eel… |
| Defensive | Holds and guards its own Beacons, stays grouped, values heals and crowd control, avoids exposure | Rhino, Moth, Porcupine… |
| Objective | Races to Beacons and avoids fights it doesn't need | Fox, Rhino, Moth… |

**Drafts** are deterministic from the seed: each strategy has two preference lists, and the
seed picks one.

## Spectating and the match library

- **AI vs AI:** pick a map and a strategy for each side.
  - The whole match is simulated in a Web Worker. It's inlined as a blob, so it also works
    in the single-file build, and falls back to time-sliced main-thread play if workers are
    unavailable.
  - Actions stream into the player while the match is still being computed.
- **Playback:**
  - play/pause (Space on desktop), 1×/2×/4× speed, step one action, restart, skip to end
  - a **timeline scrubber**: any point is rebuilt exactly by replaying the log up to it,
    and KO'd units come back when you scrub backwards
- **Library:**
  - Every finished match is saved automatically: yours, AI vs AI, and unfinished ones you
    quit.
  - Matches live in browser storage, up to 60.
  - Each entry has Watch, Copy code, Rename (inline) and Delete (tap twice). You can also
    import a code someone shared.
  - Codes from an older `RULES_VERSION` are flagged as possibly not replaying.

## Orders mode: the Claude auto-battler

In this mode the player gives each unit a **standing order** in natural language instead of
direct commands. Orders can be typed or dictated with the browser's speech recognition, and
they can be edited at any time.

### The agent's turn
- On each of the player's turns, a fresh Claude Haiku 5.5 conversation gets:
  - a briefing: board, score, Beacons, turn bar, recent events, this unit's order,
    **every teammate's order** (so units coordinate), and this unit's options
  - four tools: `check_position`, `move`, `use_ability`, `end_turn(facing, report)`
- The loop stops as soon as `end_turn` runs. A turn is usually one API call: move, act and end
  in a single reply. The `report` sentence goes to the feed.
- The scripted AI plays the enemy.
- Settings: effort `low`, the system prompt is cached, tools use `strict` schemas.

### Same access as the player
The briefing and tools are built only from what the screen shows (`src/agent/context.ts`):
- unit cards (cooldowns only for your own team, as in the ability list)
- the turn bar
- reachable hexes, plus targets with hit % and damage previews
- line-of-sight greys

`check_position` is equivalent to moving, looking and pressing Undo. Moving uses no randomness.

Legality is checked with the same target query the tap UI uses, so nothing is resolved ahead
of time. The agent never touches the RNG state, the scripted AI, or the enemy's plans.

### Two ways to reach Claude
Both backends share the briefing and the four tools (`turnTools` in `src/agent/agent.ts`).
`resolveAgent()` picks one at startup.

1. **Local dev/preview server:** the Anthropic SDK through `server/anthropic-proxy.ts`, which
   holds the key. A manual loop stops the moment `end_turn` runs.
2. **claude.ai artifact:**
   - The artifact sandbox blocks network calls to `api.anthropic.com`, so a pasted key couldn't
     work there.
   - Instead the page uses the artifact's `sample` capability, which:
     - asks for `claude-haiku-5-5` at low effort on the quick tier
     - runs the same tools as page functions
     - bills the viewer's own Claude account after a consent prompt
   - The call is left to finish after `end_turn` (one short wrap-up round), so its result can
     confirm Haiku answered. If the platform had to use another tier, the feed says so.

### Failures
API errors, timeouts, refusals, or a turn that never ends (6 calls max) **pause the match**. A
panel explains what happened, with Retry and Skip turn. A unit without an order also pauses
the match and asks for one.

### Replays
Replays still work unchanged, because the actions the agent chose are logged like any other.

### Measured
In live runs, after the first (cache-writing) call, turns take about 2.5–5 s, almost always in
one API call. 8 turns used about 14k input tokens (11k of them cache reads) and 4k output
tokens.

## Auto-zoom

At the start of each turn, the camera frames the active unit's move and attack range (an
orthographic fit in camera space, capped at 2.2× zoom). It shows the whole board when the
frame would barely be zoomed anyway. The **Auto zoom** button toggles it, and the setting is
remembered. Pinch, pan and rotate still work as before.

## Client

- **Stack:** Vite + TypeScript + three.js. No engine.
- **Layout:**
  - **Portrait:** score, then the turn queue, then the board, then the action panel.
  - **Landscape:** the queue on the left, the board in the middle, and the panel on the right.
- **Camera:** orthographic isometric. It rotates in 60° steps (aligned to the hex grid),
  pinch or wheel zooms, a drag pans when zoomed, and it auto-fits on resize. Portrait uses a
  steeper camera angle.
- **Input:** tapping a unit inspects it, and tapping your active unit starts a move.
  Abilities go Act → ability → aim → tap again (or Confirm) to fire.
- **Models:** primitive stand-ins (`src/render/models.ts`). The contract for replacing them
  with glTF is a Group facing +z with its feet at y=0.

## Out of scope for the MVP

Online play, progression, the draft phase, real models and animation, audio, the campaign,
and AI difficulty levels.

## Tuning baseline (`npm run sim`, 24 AI-vs-AI games)

- About 9–11 Pulses and about 50 unit turns per match.
- About 75% of matches are decided on score, with the rest ending in a wipe.
- Mirror matches show no meaningful side bias.
