import assert from 'node:assert/strict';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'vitest';
import { addProxy, findProxy, listProxies, parse, rememberCheck, removeProxy, toBrowser, view } from '../src/proxies.ts';

const dir = await mkdtemp(join(tmpdir(), 'ratatosk-proxies-'));
const file = join(dir, 'user.json');
test.afterAll(() => rm(dir, { recursive: true, force: true }));

test('an address is understood, or refused with a reason', () => {
  const parsed = parse('http://bob:placeholder@1.2.3.4:8080');
  assert.deepEqual(parsed, { scheme: 'http', host: '1.2.3.4:8080', username: 'bob', password: 'placeholder' });
  assert.equal(parse('socks5://1.2.3.4:1080').scheme, 'socks5');
  assert.equal(parse('1.2.3.4:8080').scheme, 'http', 'a bare host:port is taken as http');

  assert.throws(() => parse('ftp://1.2.3.4:21'), /unsupported proxy scheme/);
  assert.throws(() => parse('http://1.2.3.4'), /host and a port/);
});

test('the browser gets the credentials, the interface never does', async () => {
  const proxy = await addProxy(file, { url: 'http://bob:placeholder@1.2.3.4:8080', label: 'spain' });
  assert.deepEqual(toBrowser(proxy), { server: 'http://1.2.3.4:8080', username: 'bob', password: 'placeholder' });

  const shown = view(proxy);
  assert.equal(shown.host, '1.2.3.4:8080');
  assert.equal(shown.user, 'bo…', 'the user is hinted, not printed');
  assert.ok(!JSON.stringify(shown).includes('placeholder'), 'the password must not be in the view');
});

test('proxies are stored for the owner alone', async () => {
  assert.equal((await stat(file)).mode & 0o777, 0o600);
});

test('a check is remembered against the proxy it belongs to', async () => {
  const [proxy] = await listProxies(file);
  await rememberCheck(file, proxy.id, '203.0.113.9');
  const seen = await findProxy(file, proxy.id);
  assert.equal(seen.exitIp, '203.0.113.9');
  assert.ok(seen.checkedAt, 'and when it was seen');
});

test('removing one leaves the others alone', async () => {
  const second = await addProxy(file, { url: 'socks5://5.6.7.8:1080' });
  assert.equal(second.label, 'socks5://5.6.7.8:1080', 'an unnamed proxy is named by its address');

  const [first] = await listProxies(file);
  await removeProxy(file, first.id);

  const left = await listProxies(file);
  assert.equal(left.length, 1);
  assert.equal(left[0].id, second.id);
  assert.equal(await findProxy(file, first.id), undefined);
});
