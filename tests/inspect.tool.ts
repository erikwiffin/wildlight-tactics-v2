// Inspect an exported match log: `LOG=path/to/log.json npm run inspect`.
// Replays the match and, for every Claude turn, prints the board briefing it
// was given (rebuilt exactly from the replay; "recent events" omitted), the
// orders in force, its tool calls with results, and its report or error.
// Writes inspect-report.txt (or INSPECT_OUT).
import { readFileSync, writeFileSync } from 'node:fs';
import { it } from 'vitest';
import { turnBriefing, unitName } from '../src/agent/context';
import { replay } from '../src/core/replay';
import { parseMatchLog } from '../src/ui/matchlog';

it('inspect match log', () => {
  const path = process.env.LOG;
  if (!path) throw new Error('Set LOG=path/to/match-log.json');
  const { replay: r, log } = parseMatchLog(readFileSync(path, 'utf8'));
  const out: string[] = [];
  const final = replay(r);
  out.push(`${log?.map ?? r.config.mapId} · mode ${log?.mode ?? '?'} · seed ${r.config.seed} · ${r.actions.length} actions · score ${final.score.join('-')} · winner ${final.winner}`);
  out.push(`teams: ${JSON.stringify(r.config.teams)} · ai: ${JSON.stringify(r.config.ai)}`);
  const only = process.env.TURNS ? new Set(process.env.TURNS.split(',').map(Number)) : null;
  (log?.agentTurns ?? []).forEach((t, i) => {
    if (only && !only.has(i)) return;
    const s = replay(r, t.at);
    out.push('', `======== Claude turn ${i}: ${unitName(s.units[t.unit])} · action ${t.at} · ${t.ms} ms · ${t.model ?? '?'} ========`);
    if (s.turn?.unit !== t.unit) out.push(`!! replay mismatch: active unit is ${s.turn?.unit}`);
    else if (process.env.BRIEFING !== '0') out.push(turnBriefing(s, t.unit, t.orders, []));
    out.push('', '-- tool calls --');
    for (const c of t.trace) out.push(`${c.error ? '✗' : '→'} ${c.tool}(${JSON.stringify(c.input)})\n    ${c.result.replace(/\n/g, '\n    ')}`);
    out.push(t.error ? `-- ERROR: ${t.error}` : `-- report: ${t.report}`);
  });
  writeFileSync(process.env.INSPECT_OUT ?? 'inspect-report.txt', out.join('\n') + '\n');
}, 120_000);
