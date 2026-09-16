import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, test } from '@playwright/test';

import { openBrowser } from '../src/drivers/patchright.js';

/**
 * The keyboard of the live view. A screen someone is meant to sign in through has to carry every key
 * they press — a password is letters, digits and punctuation, and a second factor is six digits typed
 * under a timer. Four keys is not a keyboard.
 */
test('every key a person presses arrives in the page', async () => {
  const profile = mkdtempSync(join(tmpdir(), 'ratatosk-live-'));
  const session = await openBrowser({ headless: true, profileDir: profile });
  try {
    await session.page.goto('data:text/html,<input id=a>');
    const live = await session.live!();

    await session.page.evaluate(
      '() => { window.__pressed = []; const box = document.getElementById("a"); box.focus(); box.addEventListener("keydown", (event) => window.__pressed.push(event.key)); }',
    );

    for (const character of 'Pavel-42 щ!') await live.key(character, character);
    await live.key('Backspace');
    await live.key('Home');
    await live.key('Delete');

    // The text that ended up in the field, and the keys the page believes were pressed. A site that
    // watches keystrokes — every login form worth the name — has to see the second one.
    expect(await session.page.evaluate('() => document.getElementById("a").value')).toBe('avel-42 щ');
    expect(await session.page.evaluate('() => window.__pressed.join(" ")')).toBe(
      'P a v e l - 4 2   щ ! Backspace Home Delete',
    );

    await live.stop();
  } finally {
    await session.close();
    rmSync(profile, { recursive: true, force: true });
  }
});
