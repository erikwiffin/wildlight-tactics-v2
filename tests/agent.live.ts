// Live check against the real API: `LIVE=1 npx vitest run` with ANTHROPIC_API_KEY set.
// Plays a few of Blue's turns with the order-following agent; prints reports, latency and tokens.
import Anthropic from '@anthropic-ai/sdk';
import { writeFileSync } from 'node:fs';
import { it } from 'vitest';
import { nextAiAction } from '../src/core/ai';
import { apiRunner, type AgentClient } from '../src/agent/agent';
import { summarizeEvents, unitName } from '../src/agent/context';
import { activeUnit, applyAction, createMatch, newConfig } from '../src/core/engine';

it('plays agent turns', async () => {
  const sdk = new Anthropic({ timeout: 30_000, maxRetries: 1 });
  const usage = { in: 0, out: 0, cacheRead: 0, cacheWrite: 0, calls: 0 };
  const client: AgentClient = {
    messages: {
      async create(body, opts) {
        const r = await sdk.messages.create(body, opts);
        usage.calls++;
        usage.in += r.usage.input_tokens;
        usage.out += r.usage.output_tokens;
        usage.cacheRead += r.usage.cache_read_input_tokens ?? 0;
        usage.cacheWrite += r.usage.cache_creation_input_tokens ?? 0;
        return r;
      },
    },
  };
  // LIVE_SCENARIO=hollow reproduces "units stay on the back row" on Glass Hollow with the example orders.
  const hollow = process.env.LIVE_SCENARIO?.startsWith('hollow');
  const fresh = process.env.LIVE_SCENARIO === 'hollow-new'; // the map-aware example orders
  const s = hollow
    ? createMatch(newConfig('live-hollow', [['moth', 'porcupine', 'rhino'], ['eel', 'rhino', 'moth']], 'hollow', [null, 'balanced']))
    : createMatch(newConfig('live-1', [['rhino', 'fox', 'moth', 'eel'], ['lynx', 'porcupine', 'octopus', 'moth']], 'arena', [null, 'balanced']));
  const orders: Record<number, string> = hollow
    ? fresh
      ? {
          0: 'Follow the tank to the left flank Beacon and keep everyone healed.',
          2: 'Take the right flank Beacon and hold it with spike fields and volleys.',
          4: 'Take and hold the left flank Beacon. Keep enemies off our healer.',
        }
      : {
          0: 'Stay behind the tank and keep everyone healed.',
          2: 'Spike the approaches to our home Beacon and guard it.',
          4: 'Hold the center Beacon and keep enemies off our healer.',
        }
    : {
        0: 'Hold the center Beacon (B2) no matter what.',
        2: 'Steal the enemy home Beacon when it is unguarded; otherwise harass their healer.',
        4: 'Stay behind the rhino and keep it healed.',
        6: 'Stay on high ground near the center and shoot whoever attacks the rhino.',
      };
  const recent: string[] = [];
  const out: string[] = [];
  let agentTurns = 0;
  while (s.winner === null && agentTurns < Number(process.env.LIVE_TURNS ?? 8)) {
    const u = activeUnit(s)!;
    if (u.team === 1) {
      const ev = applyAction(s, nextAiAction(s, 'balanced'));
      recent.push(...summarizeEvents(s, ev));
      continue;
    }
    const t0 = Date.now();
    const res = await apiRunner(client)(
      { state: () => s, commit: async (a) => { const ev = applyAction(s, a); recent.push(...summarizeEvents(s, ev)); return ev; } },
      u.id, orders, recent.slice(-14),
    );
    agentTurns++;
    out.push(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${unitName(u)} at (${u.pos.q},${u.pos.r}) (order: ${orders[u.id]})\n   steps: ${res.steps.join(' | ')}\n   report: ${res.report}`);
  }
  out.push(`\nusage: ${JSON.stringify(usage)}  beacons: ${s.beacons.map((b) => b.owner).join(',')}  score ${s.score}`);
  writeFileSync(process.env.LIVE_OUT ?? 'live-report.txt', out.join('\n') + '\n');
}, 600_000);
