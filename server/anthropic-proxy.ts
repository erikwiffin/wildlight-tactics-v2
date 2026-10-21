// Dev/preview-server proxy for the order-following agents. The browser talks
// to /api/agent/v1/messages; this adds the API key server-side, so the key
// never reaches the page. It only forwards Messages calls to the agent model,
// caps output, rate-limits, and by default only serves this machine.

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Connect, Plugin } from 'vite';

export const AGENT_MODEL = 'claude-haiku-5-5';
const UPSTREAM = 'https://api.anthropic.com/v1/messages';
const MAX_TOKENS = 8000;
const MAX_BODY = 1_000_000;
const PER_MINUTE = 90;

interface ProxyOptions {
  apiKey?: string;
  /** Accept requests from other devices on the network (off by default). */
  allowLan?: boolean;
}

export function anthropicProxy(opts: ProxyOptions): Plugin {
  const handler = makeHandler(opts);
  return {
    name: 'wildlight-anthropic-proxy',
    configureServer(server) {
      server.middlewares.use('/api/agent', handler);
    },
    configurePreviewServer(server) {
      server.middlewares.use('/api/agent', handler);
    },
  };
}

function isLoopback(req: IncomingMessage): boolean {
  const a = req.socket.remoteAddress ?? '';
  return a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1';
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(body));
}

function proxyError(res: ServerResponse, status: number, message: string): void {
  // Same shape as API errors so the SDK surfaces the message.
  send(res, status, { type: 'error', error: { type: 'proxy_error', message } });
}

function makeHandler({ apiKey, allowLan = false }: ProxyOptions): Connect.NextHandleFunction {
  const recent: number[] = [];
  return async (req, res) => {
    if (!allowLan && !isLoopback(req)) {
      return proxyError(res, 403, 'The agent proxy only serves this computer. Set AGENT_ALLOW_LAN=1 to allow other devices.');
    }
    const path = (req.url ?? '').split('?')[0];
    if (req.method === 'GET' && path === '/health') {
      return send(res, 200, { ok: !!apiKey, model: AGENT_MODEL, reason: apiKey ? undefined : 'ANTHROPIC_API_KEY is not set in .env.local' });
    }
    if (req.method !== 'POST' || path !== '/v1/messages') return proxyError(res, 404, 'Only POST /v1/messages is proxied.');
    if (!apiKey) return proxyError(res, 503, 'ANTHROPIC_API_KEY is not set. Add it to .env.local and restart the dev server.');

    const now = Date.now();
    while (recent.length && now - recent[0] > 60_000) recent.shift();
    if (recent.length >= PER_MINUTE) return proxyError(res, 429, 'Agent proxy rate limit reached; wait a minute.');
    recent.push(now);

    let raw = '';
    try {
      for await (const chunk of req) {
        raw += chunk;
        if (raw.length > MAX_BODY) return proxyError(res, 413, 'Request too large.');
      }
    } catch {
      return proxyError(res, 400, 'Could not read the request body.');
    }
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(raw);
    } catch {
      return proxyError(res, 400, 'Request body is not JSON.');
    }
    if (body.stream) return proxyError(res, 400, 'Streaming is not supported by the agent proxy.');
    // Pin the model and cap spend regardless of what the page asks for.
    body.model = AGENT_MODEL;
    body.max_tokens = Math.min(Number(body.max_tokens) || MAX_TOKENS, MAX_TOKENS);

    try {
      const upstream = await fetch(UPSTREAM, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': String(req.headers['anthropic-version'] ?? '2023-06-01'),
          ...(req.headers['anthropic-beta'] ? { 'anthropic-beta': String(req.headers['anthropic-beta']) } : {}),
        },
        body: JSON.stringify(body),
      });
      res.statusCode = upstream.status;
      res.setHeader('content-type', upstream.headers.get('content-type') ?? 'application/json');
      const rid = upstream.headers.get('request-id');
      if (rid) res.setHeader('request-id', rid);
      res.end(await upstream.text());
    } catch (e) {
      proxyError(res, 502, `Could not reach the Claude API: ${(e as Error).message}`);
    }
  };
}
