# Wildlight Tactics: MVP Design (v0.2)

A mobile-first, FFT-style tactics game. Two teams of four nanite-infected animals
fight on a hex arena for control of three Beacons.

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
| Teams | 4v4, player vs AI. The player picks 4 of 7. |
| Board | Hexagon arena, radius 6 (127 hexes), pointy-top, tile heights 0–3, point-symmetric |
| Win | First to **15** points, or KO the whole enemy team |
| Scoring | The **Pulse** fires on a fixed rhythm and gives +1 per Beacon held |
| Capture | End your turn on a Beacon with no enemy adjacent. It stays yours until flipped. |
| KO | Permanent for the match. No respawns, no comeback mechanic. |
| Turn limit | After 40 Pulses the higher score wins, and equal scores are a draw |

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
- **Replays** are `{config, actions}` packed into a base64 share code.
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
2. It scores each one as the sum of these:
   - expected damage, plus a bonus for likely KOs and for pushing enemies off Beacons
   - heals and buffs, but only when they'd matter
   - capturing or holding a Beacon, and distance to unheld Beacons
   - threat exposure, weighted by role and current HP
3. Facing is chosen to keep enemies out of the flanks and rear.
4. Difficulty levels can come later through weights and deterministic noise.

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

Online play, progression, the draft phase, extra maps, real models and animation, audio,
the campaign, and AI difficulty levels.

## Tuning baseline (`npm run sim`, 24 AI-vs-AI games)

- About 9–11 Pulses and about 50 unit turns per match.
- About 75% of matches are decided on score, with the rest ending in a wipe.
- Mirror matches show no meaningful side bias.
