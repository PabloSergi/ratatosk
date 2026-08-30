import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'vitest';
import {
  activeConnection,
  addConnection,
  listConnections,
  removeConnection,
  setActiveConnection,
  setModel,
  runConnection,
  setRunConnection,
} from '../src/settings.ts';

const dir = await mkdtemp(join(tmpdir(), 'ratatosk-settings-'));
const file = join(dir, 'user.json');
test.afterAll(() => rm(dir, { recursive: true, force: true }));

test('a connection is stored and the key never comes back whole', async () => {
  const added = await addConnection(file, {
    provider: 'openrouter',
    key: 'sk-or-v1-abcdefghijklmnop',
    model: 'openai/gpt-5-nano',
    label: 'cheap',
  });

  assert.equal(added.label, 'cheap');
  assert.equal(added.keyHint, '…mnop', 'only the last four characters are shown');
  assert.equal(added.active, true, 'the first connection is the one in use');
  assert.ok(!JSON.stringify(added).includes('abcdefghij'), 'the key itself must not be in the view');

  const used = await activeConnection(file);
  assert.equal(used.key, 'sk-or-v1-abcdefghijklmnop', 'the engine gets the real key');
  assert.equal(used.baseUrl, 'https://openrouter.ai/api/v1');
});

test('secrets are readable by their owner alone', async () => {
  assert.equal((await stat(file)).mode & 0o777, 0o600);
});

test('several providers live side by side, one of them in use', async () => {
  await addConnection(file, { provider: 'anthropic', key: 'sk-ant-1234', model: 'claude-haiku-4-5', label: 'claude' });
  const [openrouter, claude] = await listConnections(file);

  assert.equal(openrouter.active, true);
  assert.equal(claude.active, false);
  assert.equal(claude.baseUrl, 'https://api.anthropic.com/v1', 'the provider brings its own address');

  await setActiveConnection(file, claude.id);
  assert.equal((await activeConnection(file)).model, 'claude-haiku-4-5');
});

test('a custom provider must bring its own address', async () => {
  await assert.rejects(
    () => addConnection(file, { provider: 'custom', key: 'k', model: 'm' }),
    /needs a base URL/,
  );
  const local = await addConnection(file, {
    provider: 'custom',
    key: 'k',
    model: 'llama',
    baseUrl: 'http://localhost:11434/v1/',
  });
  assert.equal(local.baseUrl, 'http://localhost:11434/v1', 'a trailing slash is not part of an address');
});

test('an incomplete connection is refused before anything is written', async () => {
  await assert.rejects(() => addConnection(file, { provider: 'openai', key: '', model: 'gpt' }), /needs a key/);
  await assert.rejects(() => addConnection(file, { provider: 'openai', key: 'k', model: ' ' }), /needs a model/);
});

test('the model can be changed without touching the key', async () => {
  const [first] = await listConnections(file);
  await setModel(file, first.id, 'mistralai/mistral-nemo');
  const changed = (await listConnections(file)).find((connection) => connection.id === first.id);
  assert.equal(changed.model, 'mistralai/mistral-nemo');
  assert.equal(changed.keyHint, first.keyHint);
});

test('removing the one in use hands the job to another', async () => {
  const before = await listConnections(file);
  const inUse = before.find((connection) => connection.active);
  await removeConnection(file, inUse.id);

  const after = await listConnections(file);
  assert.equal(after.length, before.length - 1);
  assert.ok(after.some((connection) => connection.active), 'something is still in use');
});

test('a file left from the single-key days becomes a connection', async () => {
  const legacy = join(dir, 'legacy.json');
  await (await import('node:fs/promises')).writeFile(
    legacy,
    JSON.stringify({ openrouterKey: 'sk-or-v1-oldkey1234', model: 'openai/gpt-5-nano' }),
    'utf8',
  );

  const [migrated] = await listConnections(legacy);
  assert.equal(migrated.provider, 'openrouter');
  assert.equal(migrated.keyHint, '…1234');
  assert.equal(migrated.model, 'openai/gpt-5-nano');
  assert.ok((await readFile(legacy, 'utf8')).includes('oldkey'), 'the file itself is left alone until it is written');
});

/**
 * Two jobs, two prices. Building a robot or a rule is a thinking job done once; judging a handful of
 * borderline rows happens on every run, forever. One setting for both is a choice about which of the
 * two to do badly.
 */
test('the connection that builds and the one that runs can be different', async () => {
  const file = join(await mkdtemp(join(tmpdir(), 'ratatosk-settings-')), 'settings.json');
  const clever = await addConnection(file, { provider: 'openrouter', key: 'sk-or-clever', model: 'deepseek/deepseek-v4-flash' });
  const cheap = await addConnection(file, { provider: 'openrouter', key: 'sk-or-cheap', model: 'minimax/minimax-m3:free' });

  // Until somebody says otherwise, the one that builds also runs — nothing is broken by not choosing.
  assert.equal((await runConnection(file)).id, clever.id);
  assert.equal((await listConnections(file)).find((one) => one.id === clever.id).runs, true);

  await setRunConnection(file, cheap.id);
  assert.equal((await activeConnection(file)).id, clever.id, 'building is unchanged');
  assert.equal((await runConnection(file)).id, cheap.id, 'and the repeating work went to the cheap one');

  const listed = await listConnections(file);
  assert.equal(listed.find((one) => one.id === clever.id).active, true);
  assert.equal(listed.find((one) => one.id === cheap.id).runs, true);

  await setRunConnection(file, undefined);
  assert.equal((await runConnection(file)).id, clever.id, 'and it can be handed back');
});

test('removing the cheap connection does not leave a robot pointing at nothing', async () => {
  const file = join(await mkdtemp(join(tmpdir(), 'ratatosk-settings-')), 'settings.json');
  const clever = await addConnection(file, { provider: 'openrouter', key: 'sk-or-clever', model: 'a' });
  const cheap = await addConnection(file, { provider: 'openrouter', key: 'sk-or-cheap', model: 'b' });

  await setRunConnection(file, cheap.id);
  await removeConnection(file, cheap.id);

  assert.equal((await runConnection(file)).id, clever.id, 'the work falls back to the one that builds');
});
