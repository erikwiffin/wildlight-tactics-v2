// Balance/pacing report: `npm run sim`. Writes sim-report.txt.
import { writeFileSync } from 'node:fs';
import { it } from 'vitest';
import { aiTeam } from '../src/core/ai';
import { selfPlay } from './helpers';

it('AI-vs-AI batch', () => {
  const rows: string[] = [];
  const wins = [0, 0, 0];
  let byScore = 0;
  const games = Number(process.env.SIM_GAMES ?? 24);
  for (let i = 0; i < games; i++) {
    const t0 = aiTeam('p' + i, []);
    const t1 = i % 2 ? t0 : aiTeam('q' + (i * 7 + 3), []); // every other game is a mirror match
    const { state, replay } = selfPlay('s' + i, [t0, t1]);
    const ko = [0, 1].map((t) => state.units.filter((u) => !u.alive && u.team === t).length);
    const turns = replay.actions.filter((a) => a.type === 'end').length;
    wins[state.winner === 'draw' ? 2 : (state.winner as number)]++;
    if (ko[0] < 4 && ko[1] < 4) byScore++;
    rows.push(`${String(i).padStart(2)} ${t0.join('/')} vs ${t1.join('/')} -> winner ${state.winner}, score ${state.score.join('-')}, pulses ${state.pulses}, turns ${turns}, KOs ${ko.join('-')}`);
  }
  rows.push('', `wins team0/team1/draw: ${wins.join('/')}   decided on score: ${byScore}/${games}`);
  writeFileSync('sim-report.txt', rows.join('\n') + '\n');
}, 600000);
