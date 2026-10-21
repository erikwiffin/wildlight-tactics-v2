import { describe, expect, it } from 'vitest';
import { decodeReplay, encodeReplay, replay, stateHash } from '../src/core/replay';
import { selfPlay } from './helpers';

const TEAMS: [string[], string[]] = [['rhino', 'fox', 'moth', 'eel'], ['porcupine', 'lynx', 'octopus', 'eel']];

describe('determinism', () => {
  const a = selfPlay('golden-1', TEAMS);

  it('finishes a full AI-vs-AI match', () => {
    expect(a.state.winner).not.toBeNull();
  });

  it('replays the action log to the identical state', () => {
    expect(stateHash(replay(a.replay))).toBe(stateHash(a.state));
  });

  it('round-trips through a share code', () => {
    const code = encodeReplay(a.replay);
    expect(stateHash(replay(decodeReplay(code)))).toBe(stateHash(a.state));
  });

  it('plays the same match from the same seed', () => {
    const b = selfPlay('golden-1', TEAMS);
    expect(b.replay.actions).toEqual(a.replay.actions);
  });

  it('plays a different match from a different seed', () => {
    const c = selfPlay('golden-2', TEAMS);
    expect(stateHash(c.state)).not.toBe(stateHash(a.state));
  });

  it('matches the recorded golden hash (update deliberately when rules change)', () => {
    expect({ hash: stateHash(a.state), actions: a.replay.actions.length, winner: a.state.winner, score: a.state.score }).toMatchSnapshot();
  });
});
