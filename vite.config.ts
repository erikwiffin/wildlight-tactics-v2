import { defineConfig, loadEnv } from 'vite';
import { anthropicProxy } from './server/anthropic-proxy.ts';

export default defineConfig(({ mode }) => {
  // Server-side only: no VITE_ prefix, so these never reach the client bundle.
  const env = loadEnv(mode, process.cwd(), '');
  return {
    base: './',
    server: { host: true },
    build: { chunkSizeWarningLimit: 1000 }, // three.js is most of the bundle
    plugins: [anthropicProxy({ apiKey: env.ANTHROPIC_API_KEY, allowLan: env.AGENT_ALLOW_LAN === '1' })],
    test: {
      include: process.env.SIM ? ['tests/**/*.sim.ts'] : process.env.LIVE ? ['tests/**/*.live.ts'] : ['tests/**/*.test.ts'],
    },
  };
});
