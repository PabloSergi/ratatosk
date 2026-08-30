import { mkdirSync } from 'node:fs';

import { defineConfig } from '@playwright/test';

/**
 * The product as a person meets it: a real browser, the real server, and a job board that exists only
 * for these tests. Everything the unit suite cannot reach — the front-end's wiring, a build that ends
 * in a saved robot, the live view — is exercised here.
 *
 * Nothing here touches the internet: a suite that depends on somebody else's site fails when somebody
 * else deploys, and a test that fails for reasons of its own teaches people to ignore tests.
 */
// The throwaway directory the product runs in. It is not in the repository, so a fresh clone has to
// make it before a server can be started there — otherwise the spawn fails with an ENOENT nobody reads
// as "that folder is missing".
mkdirSync('e2e/.data', { recursive: true });

export default defineConfig({
  testDir: 'e2e',
  testMatch: '**/*.spec.ts',
  timeout: 120_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: process.env['CI'] ? 1 : 0,
  reporter: process.env['CI'] ? [['github'], ['list']] : [['list']],
  use: { baseURL: 'http://127.0.0.1:5611', trace: 'retain-on-failure' },

  webServer: [
    {
      command: 'node e2e/fixture-site.mjs',
      port: 5610,
      env: { PORT: '5610' },
      reuseExistingServer: !process.env['CI'],
    },
    {
      // Its own directory, wiped by the suite: accounts, robots and history from a previous run would
      // make a test that passes for the wrong reason.
      command: 'node ../../dist/web.js',
      cwd: 'e2e/.data',
      port: 5611,
      // The data lives in the throwaway directory; the front-end it serves is the one just built.
      env: {
        PORT: '5611',
        HOST: '127.0.0.1',
        RATATOSK_PROFILES: '.profiles',
        RATATOSK_PUBLIC: '../../public',
        RATATOSK_LOG: 'warn',
      },
      reuseExistingServer: !process.env['CI'],
    },
  ],
});
