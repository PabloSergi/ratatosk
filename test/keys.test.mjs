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

/**
 * Every request a key makes also writes down when it was used. That write used to read the file,
 * change it and write it back with nothing in between to stop another one doing the same — and a key
 * made at that moment was written over by the older list and simply ceased to exist.
 */
test('a key made while others are being used is not lost', async () => {
  const { whichKey } = await import('../src/keys.ts');
  const file = await box();
  const first = await createKey(file, 'busy');
  await new Promise((resolve_) => setTimeout(resolve_, 1)); // so "last used" is not the moment it was made

  const made = [];
  const lookups = [];
  for (let index = 0; index < 20; index++) {
    lookups.push(whichKey(first.key, ['me'], () => file));
    made.push(createKey(file, `new ${index}`));
  }
  await Promise.all([...lookups, ...made]);

  const labels = (await listKeys(file)).map((key) => key.label);
  assert.equal(labels.length, 21, `keys went missing: ${labels.join(', ')}`);
});

test('the keys file is replaced whole, and nothing is left lying beside it', async () => {
  const { readdir, stat } = await import('node:fs/promises');
  const { dirname } = await import('node:path');
  const file = await box();
  await Promise.all([createKey(file, 'one'), createKey(file, 'two'), createKey(file, 'three')]);

  assert.deepEqual(await readdir(dirname(file)), ['keys.json'], 'a half-written copy was left behind');
  assert.equal((await stat(file)).mode & 0o777, 0o600, 'and it is still readable by its owner only');
});

test('a key may be bound to one project, and says so', async () => {
  const { bindKey, whichKey } = await import('../src/keys.ts');
  const file = await box();
  const made = await createKey(file, 'n8n -> vietrent', 'VietRent');
  assert.equal(made.view.project, 'vietrent');
  assert.deepEqual(await whichKey(made.key, ['me'], () => file), { userId: 'me', project: 'vietrent' });

  await bindKey(file, made.view.id);
  assert.deepEqual(await whichKey(made.key, ['me'], () => file), { userId: 'me' }, 'freed, it sees the account');

  await assert.rejects(() => bindKey(file, made.view.id, 'not a project!'), /cannot be a project/);
  await assert.rejects(() => bindKey(file, 'nope', 'rent'), /no such key/);
});

test('being used every minute does not mean being written every second', async () => {
  const { whichKey } = await import('../src/keys.ts');
  const file = await box();
  const made = await createKey(file, 'chatty');

  await whichKey(made.key, ['me'], () => file);
  const once = (await listKeys(file))[0].lastUsedAt;
  await new Promise((resolve_) => setTimeout(resolve_, 5));
  await whichKey(made.key, ['me'], () => file);
  assert.equal((await listKeys(file))[0].lastUsedAt, once, 'a second use within the minute is not written');
});
