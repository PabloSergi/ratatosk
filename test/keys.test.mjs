import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'vitest';

import { createKey, listKeys, looksLikeKey, revokeKey, whoseKey } from '../src/keys.ts';

/**
 * A person's token expires, which is right for a person and wrong for a schedule. These are the
 * credentials machines carry — and the reason they are stored as hashes: a file of working keys is a
 * file worth stealing.
 */
async function box() {
  return join(await mkdtemp(join(tmpdir(), 'ratatosk-keys-')), 'keys.json');
}

test('a key is shown once and stored as a hash', async () => {
  const file = await box();
  const made = await createKey(file, 'n8n nightly');

  assert.ok(made.key.startsWith('rtk_'), 'a key says what it is at a glance');
  assert.ok(made.key.length > 30, 'and is not guessable');

  const onDisk = await readFile(file, 'utf8');
  assert.ok(!onDisk.includes(made.key), 'the key itself must never be written down');

  const [listed] = await listKeys(file);
  assert.equal(listed.label, 'n8n nightly');
  assert.ok(made.key.startsWith(listed.hint.replace('…', '')), 'the hint is enough to recognise it');
  assert.ok(!JSON.stringify(listed).includes(made.key));
});

test('a key finds its own account and nobody else', async () => {
  const mine = await box();
  const theirs = await box();
  const made = await createKey(mine, 'mine');
  await createKey(theirs, 'theirs');

  // The lookup is given the files to search, as the server gives it every account.
  const files = { me: mine, you: theirs };
  const found = await whoseKeyIn(made.key, files);
  assert.equal(found, 'me');

  assert.equal(await whoseKeyIn('rtk_something-invented', files), undefined);
});

test('a revoked key stops working, and the others do not', async () => {
  const file = await box();
  const first = await createKey(file, 'first');
  const second = await createKey(file, 'second');

  await revokeKey(file, first.view.id);
  const left = await listKeys(file);
  assert.equal(left.length, 1);
  assert.equal(left[0].label, 'second');
  assert.ok(second.key.startsWith('rtk_'));

  await assert.rejects(() => revokeKey(file, first.view.id), /no such key/);
});

test('a token is not mistaken for a key', () => {
  assert.equal(looksLikeKey('rtk_abc'), true);
  assert.equal(looksLikeKey('eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1MSJ9.sig'), false);
});

/** whoseKey searches by account id; here the ids are the keys of a small map of files. */
async function whoseKeyIn(key, files) {
  const { keysFileFor } = await import('../src/keys.ts');
  const found = await whoseKey(key, Object.keys(files), (id) => files[id] ?? keysFileFor(id));
  return found;
}
