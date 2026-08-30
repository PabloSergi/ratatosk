import { defineConfig } from 'vitest/config';

/**
 * The suite runs against the source, not the build: coverage of compiled output tells you which lines
 * of dist ran, which is not a thing anyone can act on. The one exception is the web API test, which
 * starts the real server the way a deploy does — that one is meant to test the artifact.
 *
 * Files run one at a time on purpose: several of them start a server and a browser, and a machine
 * running four of those at once measures its own contention rather than the code.
 */
export default defineConfig({
  test: {
    include: ['test/**/*.test.mjs'],
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 60_000,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts', 'web/*.ts'],
      // Command-line front doors and the front-end's own wiring are covered by the e2e suite, where
      // they are exercised as a person exercises them.
      exclude: ['src/**/*-cli.ts', 'src/mcp/**', 'web/app.ts'],
      reporter: ['text-summary', 'html'],
      // A ratchet, not a target: set at what the suite covers today, so a change that covers less
      // fails CI. It moves up when tests are added and never down to make a build pass. What sits
      // outside it is browser-driven — the e2e suite is where that gets exercised.
      thresholds: { lines: 35, functions: 32, branches: 29, statements: 34 },
    },
  },
});
