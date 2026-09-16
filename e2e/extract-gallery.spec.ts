import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, test } from '@playwright/test';

import { openBrowser } from '../src/drivers/patchright.js';
import { EXTRACTOR_SOURCE } from '../src/extractor.js';

/** A posting with a gallery: one field, many pictures, and none of them may be dropped. */
test('a field that asks for every match brings back every match', async () => {
  const profile = mkdtempSync(join(tmpdir(), 'ratatosk-gallery-'));
  const session = await openBrowser({ headless: true, profileDir: profile });
  try {
    await session.page.goto(
      'data:text/html,' +
        encodeURIComponent(
          '<div class="card"><h2>A flat</h2>' +
            '<img src="https://pictures.example/0.jpg"><img src="https://pictures.example/1.jpg">' +
            '<img src="https://pictures.example/1.jpg"><img src="https://pictures.example/2.jpg">' +
            '</div>',
        ),
    );

    const got = await session.page.evaluate<{ rows: Array<Record<string, string | null>> }>(EXTRACTOR_SOURCE, {
      rows: '.card',
      fields: {
        title: { type: 'text', selector: 'h2' },
        photos: { type: 'attr', selector: 'img', attr: 'src', all: true },
        first: { type: 'attr', selector: 'img', attr: 'src' },
      },
    });

    expect(got.rows[0]!['title']).toBe('A flat');
    // The middle picture is on the page twice, the way a carousel repeats the frame beside the one
    // being looked at. Two copies of one address are not two photographs.
    expect(got.rows[0]!['photos']!.split('\n')).toEqual([
      'https://pictures.example/0.jpg',
      'https://pictures.example/1.jpg',
      'https://pictures.example/2.jpg',
    ]);
    // Without `all` it is still the first one, because that is what every scraper written so far means.
    expect(got.rows[0]!['first']).toBe('https://pictures.example/0.jpg');
  } finally {
    await session.close();
    rmSync(profile, { recursive: true, force: true });
  }
});
