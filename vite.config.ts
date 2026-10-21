import { defineConfig } from 'vitest/config';

export default defineConfig({
  base: './',
  server: { host: true },
  test: {
    include: process.env.SIM ? ['tests/**/*.sim.ts'] : ['tests/**/*.test.ts'],
  },
});
