// Seeing the board from the other side. The map is point-symmetric, so
// rotating every position 180° and swapping the teams (and each unit with its
// counterpart) gives a valid game where the other team is Blue. The AI plans
// every turn as Blue in this frame, so whatever order it scans hexes and
// breaks ties in, both teams get exactly the same treatment.

import type { Dir, Hex } from './hex';
import type { Action, GameState, TeamId, Unit } from './types';

const flipHex = (h: Hex): Hex => ({ q: -h.q || 0, r: -h.r || 0 });
const flipDir = (d: Dir): Dir => ((d + 3) % 6) as Dir;
const flipTeam = (t: TeamId): TeamId => (t === 0 ? 1 : 0);
/** Unit ids interleave Blue/Orange per slot (0,1 / 2,3 / ...), so a unit's counterpart is id ^ 1. */
const flipId = (id: number) => id ^ 1;

/** True when teams have equal size, which flipping requires. */
export function canFlip(s: GameState): boolean {
  return s.config.teams[0].length === s.config.teams[1].length;
}

export function flipState(s: GameState): GameState {
  const units: Unit[] = s.units.map((_, i) => {
    const u = s.units[flipId(i)];
    return { ...structuredClone(u), id: i, team: flipTeam(u.team), pos: flipHex(u.pos), facing: flipDir(u.facing) };
  });
  return {
    ...structuredClone(s),
    config: { ...structuredClone(s.config), teams: [s.config.teams[1], s.config.teams[0]], ai: s.config.ai ? [s.config.ai[1], s.config.ai[0]] : undefined },
    units,
    beacons: s.beacons.map((b) => ({ pos: flipHex(b.pos), owner: b.owner === null ? null : flipTeam(b.owner) })),
    score: [s.score[1], s.score[0]],
    pending: s.pending.map((p) => ({ ...p, caster: flipId(p.caster), target: flipHex(p.target) })),
    hazards: s.hazards.map((z) => ({ ...z, pos: flipHex(z.pos), team: flipTeam(z.team) })),
    turn: s.turn ? { ...s.turn, unit: flipId(s.turn.unit) } : null,
    winner: s.winner === null || s.winner === 'draw' ? s.winner : flipTeam(s.winner),
    tieTeam: s.tieTeam === undefined ? undefined : flipTeam(s.tieTeam),
  };
}

export function flipAction(a: Action): Action {
  switch (a.type) {
    case 'move':
      return { ...a, unit: flipId(a.unit), to: flipHex(a.to) };
    case 'ability':
      return { ...a, unit: flipId(a.unit), target: flipHex(a.target) };
    case 'end':
      return { ...a, unit: flipId(a.unit), facing: flipDir(a.facing) };
  }
}
