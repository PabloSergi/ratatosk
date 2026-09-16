import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { expect, test } from '@playwright/test';

import { openBrowser } from '../src/drivers/patchright.js';

/**
 * The browser outliving the code.
 *
 * This is the whole reason the host exists: a check passed by a person lives in the running browser,
 * and a deploy must not cost it. So a run joins a browser that is already there and leaves it running
 * — and the test for that is that the second run finds the browser the first one used, started at the
 * same moment, rather than a fresh one.
 */
const PORT = 5714;

test('a run borrows the browser and gives it back still running', async () => {
  const profile = mkdtempSync(join(tmpdir(), 'ratatosk-host-'));
  const host = spawn(process.execPath, [resolve('dist/browser-host.js')], {
    env: { ...process.env, RATATOSK_BROWSER_HOST_PORT: String(PORT), HOST: '127.0.0.1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const where = `http://127.0.0.1:${PORT}`;
  const browsers = async (): Promise<Array<{ profileDir: string; since: string; pages: number }>> =>
    ((await (await fetch(`${where}/browsers`)).json()) as { browsers: Array<{ profileDir: string; since: string; pages: number }> })
      .browsers;

  try {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const up = await fetch(`${where}/browsers`).then(() => true).catch(() => false);
      if (up) break;
      await new Promise((ready) => setTimeout(ready, 100));
    }

    process.env['RATATOSK_BROWSER_HOST'] = where;

    const first = await openBrowser({ profileDir: profile });
    await first.page.goto('data:text/html,<title>one</title>');
    expect(await first.page.evaluate<string>('() => document.title')).toBe('one');

    const started = (await browsers())[0]!;
    expect(started.profileDir).toBe(profile);

    await first.close();

    // Still up, and still the same browser: the whole point is that nothing about it restarted.
    const between = await browsers();
    expect(between).toHaveLength(1);
    expect(between[0]!.since).toBe(started.since);

    const second = await openBrowser({ profileDir: profile });
    await second.page.goto('data:text/html,<title>two</title>');
    expect(await second.page.evaluate<string>('() => document.title')).toBe('two');
    expect((await browsers())[0]!.since).toBe(started.since);
    await second.close();

    await fetch(`${where}/close`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ profileDir: profile }),
    });
    expect(await browsers()).toHaveLength(0);
  } finally {
    delete process.env['RATATOSK_BROWSER_HOST'];
    host.kill();
    rmSync(profile, { recursive: true, force: true });
  }
});
