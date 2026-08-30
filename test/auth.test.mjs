import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, vi } from 'vitest';

/** Accounts are file-backed, so each test gets its own directory before the module is loaded. */
const dir = await mkdtemp(join(tmpdir(), 'ratatosk-auth-'));
process.env.RATATOSK_USERS = join(dir, 'users.json');
process.env.RATATOSK_JWT_SECRET = 'test-secret-not-used-anywhere-else';
const auth = await import('../src/auth.ts');

test.afterAll(() => rm(dir, { recursive: true, force: true }));

test('an account can be created and used to sign in', async () => {
  const user = await auth.registerUser('Pavel@Example.com ', 'correct horse battery');
  assert.equal(user.email, 'pavel@example.com', 'the address is normalised');
  const again = await auth.verifyUser('pavel@example.com', 'correct horse battery');
  assert.equal(again.id, user.id);
});

test('the wrong password is refused, and so is an unknown address', async () => {
  await assert.rejects(() => auth.verifyUser('pavel@example.com', 'nope'), /wrong email or password/);
  await assert.rejects(() => auth.verifyUser('nobody@example.com', 'nope'), /wrong email or password/);
});

test('the same email cannot be taken twice', async () => {
  await assert.rejects(() => auth.registerUser('pavel@example.com', 'another password'), /already registered/);
});

test('weak input is refused before anything is stored', async () => {
  await assert.rejects(() => auth.registerUser('not-an-email', 'long enough password'), /email address/);
  await assert.rejects(() => auth.registerUser('short@example.com', 'tiny'), /8 characters/);
});

test('a token round-trips, and a tampered one does not', async () => {
  const user = await auth.registerUser('second@example.com', 'long enough password');
  const { token } = await auth.issueToken(user);
  const seen = await auth.verifyToken(token);
  assert.equal(seen.id, user.id);

  const [head, payload, signature] = token.split('.');
  await assert.rejects(() => auth.verifyToken(`${head}.${payload}.${signature.slice(0, -2)}xy`), /signature/);
  await assert.rejects(() => auth.verifyToken('nonsense'), /malformed/);
});

test('an expired token is refused', async () => {
  const user = { id: 'u1', email: 'a@b.co', createdAt: new Date(0).toISOString() };
  // The lifetime is read when the module loads, so the module is loaded again with a lifetime that
  // has already run out. A token minted a moment ago is then already too old, which is the point.
  vi.stubEnv('RATATOSK_TOKEN_TTL', '-10');
  vi.resetModules();
  const fresh = await import('../src/auth.ts');

  const { token } = await fresh.issueToken(user);
  await assert.rejects(() => fresh.verifyToken(token), /expired/);

  vi.unstubAllEnvs();
  vi.resetModules();
});

test('every account keeps its own robots and its own telegram session', () => {
  const a = auth.robotsDirFor('user-a');
  const b = auth.robotsDirFor('user-b');
  assert.notEqual(a, b);
  assert.ok(a.includes('user-a'));
  assert.notEqual(auth.telegramFileFor('user-a'), auth.telegramFileFor('user-b'));
});
