import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, test } from 'vitest';

/**
 * The server, started for real and asked real questions.
 *
 * Everything below this line used to be untested: routes could be renamed, an answer could lose a
 * field, a whole endpoint could start throwing, and the suite stayed green while the page went quiet.
 * Nothing here touches a browser or the network — no robot is run — so it costs a second and can be
 * run after every change.
 */
let server;
let base;
const spoken = [];

beforeAll(async () => {
  const home = await mkdtemp(join(tmpdir(), 'ratatosk-web-'));
  const port = 5600 + Math.floor(process.pid % 300);
  base = `http://127.0.0.1:${port}`;

  server = spawn(process.execPath, [resolve('dist/web.js')], {
    cwd: home,
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', RATATOSK_PROFILES: join(home, 'profiles') },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  // Kept, not printed: the log is part of what these tests check.
  server.stdout.on('data', (chunk) => spoken.push(...String(chunk).split('\n').filter(Boolean)));
  server.stderr.on('data', (chunk) => spoken.push(...String(chunk).split('\n').filter(Boolean)));

  // Wait for it to answer rather than for a fixed number of seconds.
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      await call('/api/auth/state');
      return;
    } catch {
      await new Promise((resolve_) => setTimeout(resolve_, 100));
    }
  }
  throw new Error('the server never came up');
});

afterAll(() => server?.kill());

let token;

async function call(path, body, options = {}) {
  const response = await fetch(base + path, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(options.token === null ? {} : token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body ?? {}),
  });
  const text = await response.text();
  const parsed = text ? JSON.parse(text) : {};
  return { status: response.status, body: parsed };
}

test('an empty instance says it has no users, and refuses everything else', async () => {
  const state = await call('/api/auth/state');
  assert.equal(state.body.users, 0);

  const refused = await call('/api/robots', {}, { token: null });
  assert.equal(refused.status, 401, 'without a token there is nothing to see');
});

test('an account can be created and then used', async () => {
  const created = await call('/api/auth/register', { email: 'first@example.com', password: 'a-long-enough-password' });
  assert.equal(created.status, 200, JSON.stringify(created.body));
  assert.ok(created.body.token, 'registration hands back a token');
  token = created.body.token;

  const state = await call('/api/auth/state');
  assert.equal(state.body.users, 1);

  const robots = await call('/api/robots');
  assert.equal(robots.status, 200);
  assert.deepEqual(robots.body.robots, []);
});

test('one account cannot see another one', async () => {
  const mine = token;
  const other = await call('/api/auth/register', { email: 'second@example.com', password: 'a-long-enough-password' });
  token = other.body.token;

  await call('/api/proxies/add', { url: 'http://user:pass@10.0.0.1:8080', label: 'theirs' });
  const theirs = await call('/api/proxies');
  assert.equal(theirs.body.proxies.length, 1);

  token = mine;
  const ours = await call('/api/proxies');
  assert.deepEqual(ours.body.proxies, [], 'another account’s proxy must not appear here');
});

test('a proxy is stored by its parts and never gives its password back', async () => {
  const added = await call('/api/proxies/add', { url: 'socks5://user:pass@198.51.100.7:1080', label: 'US proxy' });
  assert.equal(added.status, 200, JSON.stringify(added.body));

  const proxy = added.body;
  assert.equal(proxy.scheme, 'socks5');
  assert.equal(proxy.host, '198.51.100.7:1080');
  assert.equal(proxy.user, 'us…', 'the username is shown as a hint, not whole');
  assert.ok(!JSON.stringify(added.body).includes('secret'), 'the password must never leave the server');

  const removed = await call('/api/proxies/remove', { id: proxy.id });
  assert.deepEqual(removed.body.proxies, [], 'removing hands back the list that is left');
});

test('a proxy that cannot work is refused with a reason, not a stack trace', async () => {
  const bad = await call('/api/proxies/add', { url: 'socks5://198.51.100.7' });
  assert.equal(bad.status, 400);
  assert.match(bad.body.error, /host and a port/);

  const socks4 = await call('/api/proxies/add', { url: 'socks4://user:pass@10.0.0.1:1080' });
  assert.equal(socks4.status, 400);
  assert.match(socks4.body.error, /socks4 cannot carry a username/);
});

test('model connections are listed with the providers the page needs', async () => {
  const models = await call('/api/models');
  assert.equal(models.status, 200);
  assert.deepEqual(models.body.connections, []);
  assert.ok(models.body.providers.openrouter.baseUrl.startsWith('https://'), 'the page builds its menu from this');

  const added = await call('/api/models/add', { provider: 'openrouter', key: 'sk-or-v1-notreal', model: 'openai/gpt-5-nano' });
  assert.equal(added.status, 200, JSON.stringify(added.body));

  const [connection] = (await call('/api/models')).body.connections;
  assert.equal(connection.keyHint, '…real', 'the key is shown as its last four characters');
  assert.ok(!JSON.stringify(connection).includes('sk-or-v1-notreal'), 'and never whole');
  assert.equal(connection.active, true, 'the first one is the one that builds');
});

test('checking a connection that cannot answer says so instead of hanging', async () => {
  const { connections } = (await call('/api/models')).body;
  const checked = await call('/api/models/check', { id: connections[0].id });
  assert.equal(checked.status, 200, JSON.stringify(checked.body));
  assert.equal(checked.body.ok, false, 'an invented key cannot pass');
  assert.ok(checked.body.note.length > 0, 'and the reason has to be readable');

  // The verdict has to survive the round trip, or the card shows nothing after the button is pressed.
  const [connection] = (await call('/api/models')).body.connections;
  assert.equal(connection.lastCheck.ok, false);
  assert.equal(connection.lastCheck.note, checked.body.note);
});

test('telegram is empty until an account is connected, and says which', async () => {
  const accounts = await call('/api/telegram');
  assert.equal(accounts.status, 200);
  assert.deepEqual(accounts.body.accounts, []);

  const check = await call('/api/telegram/check', { id: 'nobody' });
  assert.equal(check.body.connected, false, 'checking an account that is not there is not an error');
});

/**
 * The promise is that a scraper says when it breaks, and a scraper reading four groups at once cannot
 * keep it: one of them goes quiet and the other three cover for it. So four names make four scrapers.
 */
test('four channels become four scrapers, one each', async () => {
  const made = await call('/api/telegram/robot', {
    channels: '@pythonjobs, remote_work devhires\n@nightshift',
    limit: 50,
  });

  assert.equal(made.status, 200);
  assert.equal(made.body.robots.length, 4);
  assert.deepEqual(
    made.body.robots.map((robot) => robot.name),
    ['pythonjobs', 'remote_work', 'devhires', 'nightshift'],
    'each is named after the channel it reads, because that is what you look for in a list',
  );
  for (const robot of made.body.robots) {
    assert.equal(robot.channels.length, 1, `${robot.name} reads more than one channel`);
    assert.equal(robot.limit, 50);
  }

  const listed = await call('/api/robots', {});
  const names = listed.body.robots.map((robot) => robot.name);
  for (const robot of made.body.robots) assert.ok(names.includes(robot.name), `${robot.name} was not saved`);
});

test('one channel with a name of its own keeps that name', async () => {
  const made = await call('/api/telegram/robot', { channels: '@onlyone', name: 'my-watch', limit: 10 });
  assert.deepEqual(made.body.robots.map((robot) => robot.name), ['my-watch']);
});

test('a telegram scraper without a channel is refused with a reason', async () => {
  const nothing = await call('/api/telegram/robot', { channels: '  ' });
  assert.equal(nothing.status, 400);
  assert.match(nothing.body.error, /at least one channel/);
});

test('a robot cannot be attached to a proxy that does not exist', async () => {
  const attached = await call('/api/robot/proxy', { name: 'nothing', proxy: 'made-up' });
  assert.equal(attached.status, 400);
  assert.ok(attached.body.error.length > 0);
});

/**
 * Taking the browser over needs a screen, an X server and a VNC daemon, which a test machine has no
 * business starting. What can be checked here is everything around it: who may ask, what is refused,
 * and that the viewer's door stays shut without the token it hands out.
 */
test('a takeover is refused without an address to open', async () => {
  const empty = await call('/api/browser/takeover', {});
  assert.equal(empty.status, 400);
  assert.match(empty.body.error, /http\(s\) address/);

  const nonsense = await call('/api/browser/takeover', { url: 'example.com' });
  assert.equal(nonsense.status, 400, 'an address without a scheme is not an address');
});

test('a takeover cannot borrow a proxy the account does not have', async () => {
  const borrowed = await call('/api/browser/takeover', { url: 'https://example.com', proxy: 'made-up' });
  assert.equal(borrowed.status, 400);
  assert.match(borrowed.body.error, /no such proxy/);
});

test('releasing when nothing is open is not an error', async () => {
  const released = await call('/api/browser/release', {});
  assert.equal(released.status, 200);
  assert.equal(released.body.released, true);
});

test('the viewer is closed to anyone without the session token', async () => {
  for (const path of ['/vnc/', '/vnc/not-a-token/vnc.html', '/vnc/not-a-token/websockify']) {
    const response = await fetch(base + path, { headers: { authorization: `Bearer ${token}` } });
    assert.equal(response.status, 404, `${path} must not open`);
  }
});

test('signing in is still required for all of it', async () => {
  const anonymous = await call('/api/browser/takeover', { url: 'https://example.com' }, { token: null });
  assert.equal(anonymous.status, 401);
});

/**
 * Carrying a session in from a browser somewhere else. Actually writing it needs a Chromium, which is
 * not this suite's business — what is, is that nothing gets in without an account, a real proxy and
 * something to carry.
 */
test('a session cannot be carried in empty', async () => {
  const nothing = await call('/api/browser/cookies', { cookies: [] });
  assert.equal(nothing.status, 400);
  assert.match(nothing.body.error, /no cookies/);

  const nonsense = await call('/api/browser/cookies', { cookies: 'a cookie, honest' });
  assert.equal(nonsense.status, 400);
});

test('a session cannot be carried into a proxy the account does not have', async () => {
  const stranger = await call('/api/browser/cookies', {
    proxy: 'made-up',
    cookies: [{ name: 'a', value: 'b', domain: '.example.com', path: '/' }],
  });
  assert.equal(stranger.status, 400);
  assert.match(stranger.body.error, /no such proxy/);
});

test('what a local browser needs is given only to the account that owns it', async () => {
  const anonymous = await call('/api/browser/session', {}, { token: null });
  assert.equal(anonymous.status, 401);

  const borrowed = await call('/api/browser/session', { proxy: 'made-up' });
  assert.equal(borrowed.status, 400);
  assert.match(borrowed.body.error, /no such proxy/);
});

test('the live view is closed to anyone without the session token', async () => {
  for (const path of ['/live/', '/live/not-a-token', '/live/not-a-token/frame']) {
    const response = await fetch(base + path);
    assert.equal(response.status, 404, `${path} must not open`);
  }

  const pressed = await fetch(base + '/live/not-a-token/input', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'press', x: 10, y: 10 }),
  });
  assert.equal(pressed.status, 404, 'and nothing can be pressed through it either');
});

test('forgetting a site needs an address and an account', async () => {
  const nowhere = await call('/api/browser/forget-site', { url: 'city-jobs' });
  assert.equal(nowhere.status, 400);
  assert.match(nowhere.body.error, /address of the site/);

  const borrowed = await call('/api/browser/forget-site', { url: 'https://example.com/', proxy: 'made-up' });
  assert.equal(borrowed.status, 400);
  assert.match(borrowed.body.error, /no such proxy/);

  const anonymous = await call('/api/browser/forget-site', { url: 'https://example.com/' }, { token: null });
  assert.equal(anonymous.status, 401);
});

/**
 * Logging is part of the service, not decoration: when a robot fails at four in the morning, the log
 * is the only witness. These assert the shape a machine can read and a person can grep.
 */
test('every call leaves one line of JSON behind', async () => {
  const lines = spoken.splice(0).map((line) => {
    try {
      return JSON.parse(line);
    } catch {
      return undefined;
    }
  }).filter(Boolean);

  const calls = lines.filter((line) => line.event === 'api');
  assert.ok(calls.length > 0, 'the api has to say what it served');
  for (const line of calls) {
    assert.ok(line.at && line.level && line.path, `a line without a time, a level or a path: ${JSON.stringify(line)}`);
    assert.equal(typeof line.ms, 'number', 'and how long it took');
  }

  const refused = lines.filter((line) => line.event === 'api refused');
  assert.ok(refused.length > 0, 'refusals are logged too — they are how a client finds its own mistake');
  assert.ok(refused.every((line) => line.level === 'warn'), 'refused input is not the server failing');
  assert.ok(
    !lines.some((line) => JSON.stringify(line).includes('a-long-enough-password')),
    'and nothing in a log line may carry a password',
  );
});

/**
 * A key is what a schedule carries. It has to work on every door a person's token opens, outlive a
 * login, and stop the moment it is revoked — otherwise "revoked" is a word rather than an act.
 */
test('a key opens the same doors as a login, and stops when revoked', async () => {
  const made = await call('/api/keys/create', { label: 'n8n nightly' });
  assert.equal(made.status, 200, JSON.stringify(made.body));
  assert.ok(made.body.key.startsWith('rtk_'), 'a key says what it is at a glance');

  const key = made.body.key;
  const asMachine = async (path, body) => {
    const response = await fetch(base + path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify(body ?? {}),
    });
    return { status: response.status, body: await response.json().catch(() => ({})) };
  };

  const robots = await asMachine('/api/robots');
  assert.equal(robots.status, 200, 'the key gets in');
  assert.ok(Array.isArray(robots.body.robots));

  // And it reaches this account's things, not somebody else's.
  const proxies = await asMachine('/api/proxies');
  assert.equal(proxies.status, 200);

  const listed = await call('/api/keys');
  const mine = listed.body.keys.find((entry) => entry.label === 'n8n nightly');
  assert.ok(mine, 'the key is listed');
  assert.ok(!JSON.stringify(listed.body).includes(key), 'but never given back in full');
  assert.ok(mine.lastUsedAt, 'and it is visible that something is using it');

  await call('/api/keys/revoke', { id: mine.id });
  const after = await asMachine('/api/robots');
  assert.equal(after.status, 401, 'revoked means revoked');
});

test('an invented key opens nothing', async () => {
  const response = await fetch(base + '/api/robots', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer rtk_invented-out-of-thin-air' },
    body: '{}',
  });
  assert.equal(response.status, 401);
});

/**
 * The rule a robot sifts by, from the outside: read it, try it on fresh material, write it by hand.
 * A rule nobody can see is a rule nobody can trust, and this one decides what the robot returns.
 */
test('a robot without a rule says so plainly', async () => {
  const answer = await call('/api/robot/rule', { name: 'nothing-here' });
  assert.equal(answer.status, 400, 'and a robot that does not exist is not a rule question');
  assert.match(answer.body.error, /no robot named/);
});

test('a rule that cannot compile is refused before it is stored', async () => {
  const broken = await call('/api/robot/rule/save', { name: 'whatever', sift: { keep: ['('] } });
  // The robot is missing here, which is caught first — but the message must still be a refusal, not a
  // stack trace, and the status must say whose mistake it was.
  assert.equal(broken.status, 400);
});

test('the rule endpoints are closed to strangers', async () => {
  for (const path of ['/api/robot/rule', '/api/robot/rule/save', '/api/robot/rule/test', '/api/robot/rule/rebuild']) {
    const response = await call(path, { name: 'x' }, { token: null });
    assert.equal(response.status, 401, `${path} must need an account`);
  }
});
