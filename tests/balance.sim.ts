// Balance/pacing report: `npm run sim`. Writes sim-report.txt.
// SIM_GAMES sets games per cell (default 6). SIM_PART=maps|drafts|behavior runs one part.
import { writeFileSync } from 'node:fs';
import { it } from 'vitest';
import { aiTeam, STRATEGIES } from '../src/core/ai';
import { MAP_LIST } from '../src/core/map';
import type { StrategyId } from '../src/core/types';
import { selfPlay } from './helpers';

const N = Number(process.env.SIM_GAMES ?? 6);
const PART = process.env.SIM_PART;
const run = (p: string) => !PART || PART === p;

it('AI-vs-AI batch', () => {
  const out: string[] = [];
  // 1. Pacing per map, balanced mirror.
  if (run('maps')) out.push('== Maps (balanced vs balanced) ==');
  for (const map of run('maps') ? MAP_LIST : []) {
    let pulses = 0, turns = 0, byScore = 0;
    const wins = [0, 0, 0];
    for (let i = 0; i < N; i++) {
      const team = aiTeam('m' + i, 'balanced', map.teamSize);
      const { state, replay } = selfPlay(`${map.id}-${i}`, [team, team], { mapId: map.id });
      pulses += state.pulses;
      turns += replay.actions.filter((a) => a.type === 'end').length;
      wins[state.winner === 'draw' ? 2 : (state.winner as number)]++;
      if (state.units.some((u) => u.alive && u.team === 0) && state.units.some((u) => u.alive && u.team === 1)) byScore++;
    }
    out.push(`${map.name.padEnd(16)} avg pulses ${(pulses / N).toFixed(1)}, avg turns ${(turns / N).toFixed(0)}, on score ${byScore}/${N}, wins t0/t1/draw ${wins.join('/')}`);
  }
  // 2. Strategy matrix on the standard arena; sides alternate. "drafts" lets each
  // strategy bring its own squad; "behavior" gives both sides the same squad.
  const ids = STRATEGIES.map((s) => s.id);
  for (const part of ['drafts', 'behavior'].filter(run)) {
  out.push('', `== Strategy matrix (${part}), Shattered Basin: row win rate vs column ==`);
  out.push('            ' + ids.map((s) => s.slice(0, 10).padStart(11)).join(''));
  for (const a of ids) {
    const cells: string[] = [];
    for (const b of ids) {
      if (a === b) { cells.push('—'.padStart(11)); continue; }
      let w = 0;
      for (let i = 0; i < N; i++) {
        const aSide = i % 2;
        const strategies = (aSide === 0 ? [a, b] : [b, a]) as [StrategyId, StrategyId];
        const shared = aiTeam(`x${i}`, i % 4 < 2 ? 'balanced' : 'objective', 4);
        const teams = (part === 'behavior' ? [shared, shared] : strategies.map((s, side) => aiTeam(`x${i}`, s, 4, String(side)))) as [string[], string[]];
        const pair = [a, b].sort().join('-'); // same seeds for a-vs-b and b-vs-a
        const { state } = selfPlay(`mx-${pair}-${i}`, teams, { strategies });
        if (state.winner === aSide) w++;
        else if (state.winner === 'draw') w += 0.5;
      }
      cells.push(`${Math.round((100 * w) / N)}%`.padStart(11));
    }
    out.push(a.padEnd(12) + cells.join(''));
  }
  }
  writeFileSync('sim-report.txt', out.join('\n') + '\n');
}, 1800000);
