import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'vitest';

const dir = await mkdtemp(join(tmpdir(), 'ratatosk-scope-'));
process.env.RATATOSK_USERS = join(dir, 'users.json');
process.env.RATATOSK_JWT_SECRET = 'another-test-secret';
const auth = await import('../src/auth.ts');
const { resolveScope } = await import('../src/scope.ts');

test.afterAll(() => rm(dir, { recursive: true, force: true }));

test('with no accounts, MCP works on the plain robots directory', async () => {
  const scope = await resolveScope();
  assert.equal(scope.robotsDir, 'robots');
  assert.equal(scope.telegramSession, undefined);
});

test('once accounts exist, a token is required and names the account', async () => {
  const user = await auth.registerUser('owner@example.com', 'long enough password');
  await assert.rejects(() => resolveScope(), /token is required/);

  const { token } = await auth.issueToken(user);
  const scope = await resolveScope(token);
  assert.ok(scope.robotsDir.includes(user.id), 'the scope points at that account');
  assert.ok(scope.telegramSession.includes(user.id));
  assert.equal(scope.who, 'owner@example.com');
});

test('a token that was tampered with opens nothing', async () => {
  await assert.rejects(() => resolveScope('not.a.token'), /signature|malformed/);
});
