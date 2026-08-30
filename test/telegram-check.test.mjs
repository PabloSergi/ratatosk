import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'vitest';

import { rememberTelegramCheck, telegramStatus } from '../src/telegram.ts';

/**
 * A check that is only returned to the browser is a check nobody can see a second time: the next
 * render reads the file, the file knows nothing, and the button looks broken. So the verdict is
 * written down, and this is what proves it survives.
 */
async function connectedAccount() {
  const dir = await mkdtemp(join(tmpdir(), 'ratatosk-tg-'));
  const file = join(dir, 'account.json');
  await writeFile(
    file,
    JSON.stringify({ apiId: 24003941, apiHash: 'h'.repeat(32), session: 'stub', account: '@someone', phone: '+34600000000' }),
    'utf8',
  );
  return file;
}

test('a check leaves a mark the next render can read', async () => {
  const file = await connectedAccount();

  const before = await telegramStatus(file);
  assert.equal(before.connected, true);
  assert.equal(before.lastCheck, undefined, 'nothing was checked yet');
  assert.equal(before.alive, undefined);

  await rememberTelegramCheck(file, {
    at: '2026-08-27T09:00:00.000Z',
    ok: true,
    note: 'signed in as @someone, 42 chats visible',
    dialogs: 42,
    access: [{ channel: 'pythonjobs', ok: true, note: 'readable, no messages' }],
  });

  const after = await telegramStatus(file);
  assert.equal(after.alive, true);
  assert.equal(after.dialogs, 42);
  assert.equal(after.lastCheck?.note, 'signed in as @someone, 42 chats visible');
  assert.deepEqual(after.access, [{ channel: 'pythonjobs', ok: true, note: 'readable, no messages' }]);
});

test('a failed check is remembered too — that is when the account stopped working', async () => {
  const file = await connectedAccount();
  await rememberTelegramCheck(file, { at: '2026-08-27T09:00:00.000Z', ok: false, note: 'AUTH_KEY_UNREGISTERED' });

  const state = await telegramStatus(file);
  assert.equal(state.connected, true, 'the file is still there');
  assert.equal(state.alive, false, 'but it is not alive');
  assert.equal(state.lastCheck?.note, 'AUTH_KEY_UNREGISTERED');
});

test('remembering a check keeps the session and the credentials untouched', async () => {
  const file = await connectedAccount();
  await rememberTelegramCheck(file, { at: '2026-08-27T09:00:00.000Z', ok: true, note: 'fine' });

  const stored = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(stored.session, 'stub');
  assert.equal(stored.apiId, 24003941);
  assert.equal(stored.account, '@someone');
});

test('checking an account that was never connected writes nothing at all', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ratatosk-tg-'));
  const missing = join(dir, 'nobody.json');
  await rememberTelegramCheck(missing, { at: '2026-08-27T09:00:00.000Z', ok: true, note: 'fine' });
  assert.equal((await telegramStatus(missing)).connected, false);
});
