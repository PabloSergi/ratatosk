import assert from 'node:assert/strict';
import { test } from 'vitest';
import sharp from 'sharp';

import { distance, phash } from '../src/phash.ts';

/**
 * The one thing about a listing that survives being copied to another board: the photographs. Text is
 * rewritten, prices are rounded, addresses are respelt — the picture is re-encoded and re-sized, and
 * that is exactly what this has to see through.
 */

/** A picture with some structure in it — a flat hash of a flat colour would prove nothing. */
async function picture({ width = 320, height = 240, shift = 0 } = {}) {
  const pixels = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const at = (y * width + x) * 3;
      const wall = ((x + shift) / 40 | 0) % 2 === 0 ? 40 : 210;
      const floor = y > height * 0.7 ? 90 : wall;
      pixels[at] = floor;
      pixels[at + 1] = floor;
      pixels[at + 2] = Math.min(255, floor + (y / 8 | 0));
    }
  }
  return sharp(pixels, { raw: { width, height, channels: 3 } });
}

test('the same photograph re-encoded and re-sized keeps its fingerprint', async () => {
  const original = await (await picture()).png().toBuffer();
  // What a board actually does to an advert's photo: re-encodes it, and serves three sizes of it.
  const asWebp = await (await picture()).webp({ quality: 70 }).toBuffer();
  const smaller = await (await picture()).resize(160, 120).jpeg({ quality: 60 }).toBuffer();

  const one = await phash(original);
  assert.equal(one.length, 16, 'шестнадцать шестнадцатеричных знаков, то есть 64 бита');

  assert.ok(distance(one, await phash(asWebp)) <= 8, 'пережатие в webp не должно менять отпечаток');
  assert.ok(distance(one, await phash(smaller)) <= 8, 'уменьшение вдвое и jpeg — тоже');
});

test('two different rooms are not called the same room', async () => {
  const one = await phash(await (await picture()).png().toBuffer());
  const other = await phash(await (await picture({ shift: 20 })).png().toBuffer());

  assert.ok(distance(one, other) > 8, `разные снимки сошлись слишком близко: ${distance(one, other)}`);
});

test('what is not an image is said to be nothing, and does not stop a run', async () => {
  assert.equal(await phash(Buffer.from('<html>404</html>')), undefined);
  assert.equal(await phash(Buffer.alloc(0)), undefined);
});

test('distance counts bits, and refuses to compare unlike things', () => {
  assert.equal(distance('0000000000000000', '0000000000000000'), 0);
  assert.equal(distance('0000000000000000', '0000000000000001'), 1);
  assert.equal(distance('0000000000000000', 'ffffffffffffffff'), 64);
  assert.equal(distance('abc', 'abcd'), Number.MAX_SAFE_INTEGER, 'обрезанный отпечаток — не близкий, а несравнимый');
});
