import { defineConfig } from 'vitest/config';

export default defineConfig({
  base: './',
  server: { host: true },
  build: { chunkSizeWarningLimit: 1000 }, // three.js is most of the bundle
  test: {
    include: process.env.SIM ? ['tests/**/*.sim.ts'] : ['tests/**/*.test.ts'],
  },
});
