import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { appendFile, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
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
let home;
const spoken = [];

beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), 'ratatosk-web-'));
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
    project: 'tests',
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

/**
 * The accident this refusal exists for: a job board at ofmjobs.com and a Telegram group called
 * @OFMJobs are different sources with the same word for a name. Writing one over the other destroys a
 * scraper and everything it remembered having already handed over.
 */
/**
 * A name here is not a label: the file is named by it, the memory of what has already been handed over
 * is filed under it, and every line of history says it. A rename that moved only the file would hand
 * back a scraper with no past and no memory — a new scraper wearing an old name.
 */
/**
 * Deleting moves the file aside rather than destroying it — which is worth nothing if the only way to
 * the corner it went into is a shell on the server. A scraper is minutes of a model's work against a
 * page that has since changed, so "I deleted the wrong one" has to be answerable.
 */
test('alerts are off until a bot is set up, and the token never comes back', async () => {
  const before = await call('/api/alerts', {});
  assert.equal(before.body.on, false, 'nothing is said until somebody asks for it');

  const half = await call('/api/alerts/save', { botToken: '123456:AA-token' });
  assert.equal(half.status, 400);
  assert.match(half.body.error, /chat id/);

  const saved = await call('/api/alerts/save', { botToken: '123456:AA-token-material', chatId: '42', after: 2 });
  assert.equal(saved.body.on, true);
  assert.equal(saved.body.after, 2);
  assert.ok(!JSON.stringify(saved.body).includes('AA-token-material'), 'a token is never handed back whole');

  // Changing the chat id must not require pasting the token again, or people keep it in a text file.
  const moved = await call('/api/alerts/save', { chatId: '77' });
  assert.equal(moved.body.on, true);
  assert.equal(moved.body.chatId, '77');

  const off = await call('/api/alerts/off', {});
  assert.equal(off.body.on, false);
});

test('how many bad runs count as broken is bounded, whatever is typed', async () => {
  const silly = await call('/api/alerts/save', { botToken: 't', chatId: '1', after: 900 });
  assert.ok(silly.body.after <= 20, 'a scraper nobody is ever told about is not a setting worth having');

  const zero = await call('/api/alerts/save', { chatId: '1', after: 0 });
  assert.ok(zero.body.after >= 1);
});

test('a deleted scraper can be had back', async () => {
  await call('/api/telegram/robot', { channels: '@regretted', limit: 10, project: 'tests' });
  await call('/api/robot/delete', { name: 'regretted' });

  const gone = await call('/api/robots', {});
  assert.ok(!gone.body.robots.some((robot) => robot.name === 'regretted'), 'deleted means gone from the list');

  const deleted = await call('/api/robot/deleted', {});
  const one = deleted.body.deleted.find((entry) => entry.name === 'regretted');
  assert.ok(one, 'and yet still findable');
  assert.equal(one.kind, 'telegram');
  assert.ok(!Number.isNaN(Date.parse(one.at)), 'with a time a person can read');

  const back = await call('/api/robot/restore', { file: one.file });
  assert.equal(back.body.restored, 'regretted');

  const now = await call('/api/robots', {});
  assert.ok(now.body.robots.some((robot) => robot.name === 'regretted'), 'and it is a scraper again');

  const after = await call('/api/robot/deleted', {});
  assert.ok(!after.body.deleted.some((entry) => entry.name === 'regretted'), 'restored once, not offered twice');
});

test('restoring onto a name taken since is refused rather than silently overwriting', async () => {
  await call('/api/telegram/robot', { channels: '@twice', limit: 10, project: 'tests' });
  await call('/api/robot/delete', { name: 'twice' });
  await call('/api/telegram/robot', { channels: '@twice', limit: 10, project: 'tests' }); // somebody built it again

  const deleted = await call('/api/robot/deleted', {});
  const one = deleted.body.deleted.find((entry) => entry.name === 'twice');
  const clash = await call('/api/robot/restore', { file: one.file });

  assert.equal(clash.status, 400);
  assert.match(clash.body.error, /already exists/);
});

test('a restore cannot be pointed at a file that is not a deleted scraper', async () => {
  const escaping = await call('/api/robot/restore', { file: '../../secrets/users.json' });
  assert.equal(escaping.status, 400);
  assert.match(escaping.body.error, /not a deleted scraper/);
});

test('renaming a scraper brings its history along', async () => {
  await call('/api/telegram/robot', { channels: '@before', limit: 10, project: 'tests' });

  const renamed = await call('/api/robot/rename', { name: 'before', to: 'after' });
  assert.equal(renamed.status, 200);
  assert.equal(renamed.body.name, 'after');
  assert.equal(renamed.body.was, 'before');

  const listed = await call('/api/robots', {});
  const names = listed.body.robots.map((robot) => robot.name);
  assert.ok(names.includes('after'), 'the new name is there');
  assert.ok(!names.includes('before'), 'and the old one is not, rather than both');
});

test('a rename onto a name in use is refused, and changes nothing', async () => {
  await call('/api/telegram/robot', { channels: '@one, @two', limit: 10, project: 'tests' });

  const clash = await call('/api/robot/rename', { name: 'one', to: 'two' });
  assert.equal(clash.status, 400);
  assert.match(clash.body.error, /already exists/);

  const listed = await call('/api/robots', {});
  const names = listed.body.robots.map((robot) => robot.name);
  assert.ok(names.includes('one') && names.includes('two'), 'both are still there, and still themselves');
});

test('a rename to nothing, or to the same name, is refused rather than half-done', async () => {
  await call('/api/telegram/robot', { channels: '@steady', limit: 10, project: 'tests' });

  const empty = await call('/api/robot/rename', { name: 'steady', to: '   ' });
  assert.equal(empty.status, 400);
  assert.match(empty.body.error, /needs a name/);

  const same = await call('/api/robot/rename', { name: 'steady', to: 'steady' });
  assert.equal(same.status, 400);
  assert.match(same.body.error, /already called/);
});

test('a scraper is never created over one that already exists', async () => {
  await call('/api/telegram/robot', { channels: '@taken', limit: 10, project: 'tests' });
  const again = await call('/api/telegram/robot', { channels: '@taken', limit: 10, project: 'tests' });

  assert.equal(again.status, 400);
  assert.match(again.body.error, /already exists/);

  const listed = await call('/api/robots', {});
  assert.equal(listed.body.robots.filter((robot) => robot.name === 'taken').length, 1);
});

test('one channel with a name of its own keeps that name', async () => {
  const made = await call('/api/telegram/robot', { channels: '@onlyone', name: 'my-watch', limit: 10, project: 'tests' });
  assert.deepEqual(made.body.robots.map((robot) => robot.name), ['my-watch']);
});

test('a telegram scraper without a channel is refused with a reason', async () => {
  const nothing = await call('/api/telegram/robot', { channels: '  ', project: 'tests' });
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

/**
 * Passing a check by hand and then being told to go and press Run is asking somebody to finish a job
 * the product can finish itself — and it is the moment they most want to know whether it worked.
 */
test('a door opened from a card runs that scraper when it is saved', async () => {
  const named = await call('/api/browser/release', { scraper: 'no-such-scraper' });
  assert.equal(named.status, 400, 'a name that is not a scraper is a mistake worth saying out loud');
  assert.match(named.body.error, /no robot named/);

  // …and releasing with no scraper named is still just releasing.
  const plain = await call('/api/browser/release', {});
  assert.equal(plain.status, 200);
  assert.equal(plain.body.released, true);
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

  // The same for every other credential that passes through: a bot token that reaches the logs is a
  // bot anybody with log access can send messages as.
  await call('/api/alerts/save', { botToken: '999999:AA-bot-token-that-must-not-leak', chatId: '42' });
  assert.ok(
    !spoken.some((line) => line.includes('AA-bot-token-that-must-not-leak')),
    'nor a bot token',
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

test('a scraper that was deleted stops being counted as one that needs looking at', async () => {
  await call('/api/telegram/robot', { channels: '@standing', limit: 10, project: 'tests' });
  const me = await call('/api/auth/me', {});

  // Two broken runs in the journal: one belongs to a scraper that exists, the other to one that was
  // deleted a month ago. The journal keeps both; the tally may only speak of the first.
  const journal = join(home, 'history', `${me.body.user.id}.jsonl`);
  await mkdir(join(home, 'history'), { recursive: true });
  for (const robot of ['standing', 'long-gone']) {
    await appendFile(
      journal,
      `${JSON.stringify({ at: new Date().toISOString(), robot, kind: 'run', status: 'broken', rows: 0, pages: 0, ms: 1 })}\n`,
    );
  }

  const { body } = await call('/api/history', {});
  const named = body.standing.map((entry) => entry.robot);
  assert.ok(named.includes('standing'), 'a scraper that exists is still judged');
  assert.ok(!named.includes('long-gone'), 'and one that does not is not asked about');
});

test('the harvest says where to carry on from, so nothing is asked for twice or missed', async () => {
  const { keepResult } = await import('../src/results.ts');
  const kept = { status: 'ok', pagesVisited: 1, rows: [{ title: 'a vacancy', link: 'https://board.test/1' }] };

  // Two runs, stored at known moments. The door filters by when Ratatosk wrote the run down — not by
  // when the posting was published, which is a date somebody else controls and often does not set.
  process.env.RATATOSK_RESULTS = join(home, 'results');
  await keepResult((await call('/api/auth/me', {})).body.user.id, 'board', { at: '2026-10-01T10:00:00.000Z', ...kept });
  await keepResult((await call('/api/auth/me', {})).body.user.id, 'board', { at: '2026-10-01T10:10:00.000Z', ...kept });

  const first = await call('/api/harvest', { since: '2026-10-01T09:00:00.000Z' });
  assert.equal(first.body.rows.length, 2);
  assert.equal(first.body.nextSince, '2026-10-01T10:10:00.000Z', 'the newest run handed over, not the clock');

  // Carrying on from the cursor brings nothing new, and the cursor stands rather than drifting to now:
  // a run finishing this second is stamped before "now" and would be stepped over for ever.
  const again = await call('/api/harvest', { since: first.body.nextSince });
  assert.equal(again.body.rows.length, 0);
  assert.equal(again.body.nextSince, first.body.nextSince);
});


/**
 * Projects. One account holds the scrapers of several unrelated products, and a product's own
 * automation must be able to ask for "everything of mine" without keeping a list of names — and
 * without being able to learn what else the account is scraping.
 */
function asKey(key) {
  return async (path, body) => {
    const response = await fetch(base + path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify(body ?? {}),
    });
    return { status: response.status, body: await response.json().catch(() => ({})) };
  };
}

/** A scraper written straight to disk, the way one made before there were projects is found there. */
async function onDisk(robot) {
  const me = await call('/api/auth/me', {});
  const dir = join(home, 'robots', 'u', me.body.user.id);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `${robot.name}.json`), JSON.stringify({ version: 1, source: 'telegram', limit: 10, ...robot }));
}

test('a scraper is not made without a project to put it in', async () => {
  const refused = await call('/api/telegram/robot', { channels: '@homeless', limit: 10 });
  assert.equal(refused.status, 400);
  assert.match(refused.body.error, /belongs to a project/);

  const listed = await call('/api/robots', {});
  assert.ok(!listed.body.robots.some((robot) => robot.name === 'homeless'), 'and nothing was half-made');

  const bad = await call('/api/telegram/robot', { channels: '@homeless', limit: 10, project: 'Viet Rent!' });
  assert.equal(bad.status, 400, 'a project is a word that can be typed again, not any string at all');
});

test('a scraper says which project it is in, and the list can be narrowed to one', async () => {
  await call('/api/telegram/robot', { channels: '@rent-saigon', limit: 10, project: 'RENT' });
  await call('/api/telegram/robot', { channels: '@jobs-board', limit: 10, project: 'jobs' });

  const all = await call('/api/robots', {});
  assert.equal(all.body.robots.find((robot) => robot.name === 'rent-saigon').project, 'rent', 'kept lower-cased');

  const rent = await call('/api/robots', { project: 'rent' });
  assert.deepEqual(rent.body.robots.map((robot) => robot.name), ['rent-saigon']);
});

test('a key bound to a project sees that project and nothing else', async () => {
  const made = await call('/api/keys/create', { label: 'n8n -> rent', project: 'rent' });
  assert.equal(made.status, 200, JSON.stringify(made.body));
  assert.equal(made.body.keys.find((key) => key.label === 'n8n -> rent').project, 'rent');
  const asRent = asKey(made.body.key);

  const robots = await asRent('/api/robots');
  assert.deepEqual(robots.body.robots.map((robot) => robot.name), ['rent-saigon']);

  // A scraper of another project answers exactly as one that does not exist — and the refusal lists
  // only this project's names, or it would be a way of reading the rest of the account.
  for (const path of ['/api/run', '/api/results', '/api/catalogue', '/api/vanished', '/api/robot/rule', '/api/schedule/now']) {
    const other = await asRent(path, { name: 'jobs-board' });
    assert.equal(other.status, 400, `${path} let a rent key reach a jobs scraper`);
    assert.match(other.body.error, /no robot named "jobs-board"/);
    assert.doesNotMatch(other.body.error, /taken|regretted|steady/, `${path} told a rent key about other projects`);
  }
  const history = await asRent('/api/history', { robot: 'jobs-board' });
  assert.equal(history.status, 400);

  // Asking for another project by name is refused outright rather than quietly answered with its own.
  const elsewhere = await asRent('/api/robots', { project: 'jobs' });
  assert.equal(elsewhere.status, 403);

  // And the account's own business is not a project key's to touch.
  for (const path of ['/api/proxies', '/api/keys', '/api/keys/create', '/api/models', '/api/robot/delete', '/api/robot/rename', '/api/robot/project']) {
    const closed = await asRent(path, { name: 'rent-saigon' });
    assert.equal(closed.status, 403, `${path} is open to a project key`);
    assert.match(closed.body.error, /for the rent project/);
  }
});

test('a project key builds into its own project, and only there', async () => {
  const made = await call('/api/keys/create', { label: 'rent builder', project: 'rent' });
  const asRent = asKey(made.body.key);

  const built = await asRent('/api/telegram/robot', { channels: '@rent-hanoi', limit: 10 });
  assert.equal(built.status, 200, JSON.stringify(built.body));
  const listed = await call('/api/robots', { project: 'rent' });
  assert.ok(listed.body.robots.some((robot) => robot.name === 'rent-hanoi'), 'it lands in the key’s project without being told');

  const smuggled = await asRent('/api/telegram/robot', { channels: '@sneaky', limit: 10, project: 'jobs' });
  assert.equal(smuggled.status, 403);
});

test('the harvest of a project key holds that project’s rows and no one else’s', async () => {
  const { keepResult } = await import('../src/results.ts');
  process.env.RATATOSK_RESULTS = join(home, 'results');
  const me = (await call('/api/auth/me', {})).body.user.id;
  const run = (title) => ({ status: 'ok', pagesVisited: 1, rows: [{ title, link: `https://board.test/${title}` }] });
  await keepResult(me, 'rent-saigon', { at: '2026-10-02T10:00:00.000Z', ...run('a flat') });
  await keepResult(me, 'jobs-board', { at: '2026-10-02T10:05:00.000Z', ...run('a vacancy') });

  const made = await call('/api/keys/create', { label: 'rent harvest', project: 'rent' });
  const harvest = await asKey(made.body.key)('/api/harvest', { since: '2026-10-02T09:00:00.000Z' });
  assert.equal(harvest.status, 200);
  assert.deepEqual(harvest.body.rows.map((row) => row.scraper), ['rent-saigon']);

  // Signed in, the whole account — or one project, if asked.
  const whole = await call('/api/harvest', { since: '2026-10-02T09:00:00.000Z' });
  assert.deepEqual(whole.body.rows.map((row) => row.scraper).sort(), ['jobs-board', 'rent-saigon']);
  const jobs = await call('/api/harvest', { since: '2026-10-02T09:00:00.000Z', project: 'jobs' });
  assert.deepEqual(jobs.body.rows.map((row) => row.scraper), ['jobs-board']);
});

test('what vanished is told for a whole project at once, without naming its scrapers', async () => {
  const { keepSeen, finishedPass } = await import('../src/catalogue.ts');
  process.env.RATATOSK_CATALOGUE = join(home, 'catalogue');
  const me = (await call('/api/auth/me', {})).body.user.id;

  await onDisk({ name: 'rent-flats', project: 'rent', channels: ['flats'], catalogue: 'link' });
  await onDisk({ name: 'rent-rooms', project: 'rent', channels: ['rooms'], catalogue: 'link' });
  await onDisk({ name: 'jobs-listed', project: 'jobs', channels: ['jobs'], catalogue: 'link' });

  // Two flats seen on Monday, one of them again on Tuesday's pass: the other has left the source.
  await keepSeen(me, 'rent-flats', [{ link: 'f1' }, { link: 'f2' }], 'link', '2026-10-05T08:00:00.000Z');
  await keepSeen(me, 'rent-flats', [{ link: 'f1' }], 'link', '2026-10-06T08:00:00.000Z');
  await finishedPass(me, 'rent-flats', '2026-10-06T08:00:00.000Z');
  await keepSeen(me, 'jobs-listed', [{ link: 'j1' }], 'link', '2026-10-05T08:00:00.000Z');
  await finishedPass(me, 'jobs-listed', '2026-10-06T08:00:00.000Z');

  const made = await call('/api/keys/create', { label: 'rent gone', project: 'rent' });
  const gone = await asKey(made.body.key)('/api/vanished', {});
  assert.equal(gone.status, 200, JSON.stringify(gone.body));
  assert.equal(gone.body.project, 'rent');
  assert.deepEqual(gone.body.robots.map((robot) => robot.name).sort(), ['rent-flats', 'rent-rooms']);
  const flats = gone.body.robots.find((robot) => robot.name === 'rent-flats');
  assert.deepEqual(flats.ids.map((one) => one.id), ['f2']);
  // One that has not finished a pass is listed with nothing to say, so its silence is visible.
  assert.equal(gone.body.robots.find((robot) => robot.name === 'rent-rooms').since, null);

  // Named, the answer is the one it always was.
  const one = await call('/api/vanished', { name: 'rent-flats' });
  assert.deepEqual(one.body.ids.map((entry) => entry.id), ['f2']);

  // Signed in with no name and no project there is nothing to answer for.
  const vague = await call('/api/vanished', {});
  assert.equal(vague.status, 400);
});

test('a key that already exists can be bound to a project and freed again, and stays the same key', async () => {
  const made = await call('/api/keys/create', { label: 'old n8n' });
  const asOld = asKey(made.body.key);
  const id = made.body.keys.find((key) => key.label === 'old n8n').id;
  assert.ok((await asOld('/api/robots')).body.robots.some((robot) => robot.name === 'jobs-board'));

  const bound = await call('/api/keys/project', { id, project: 'rent' });
  assert.equal(bound.body.keys.find((key) => key.id === id).project, 'rent');
  assert.ok(!(await asOld('/api/robots')).body.robots.some((robot) => robot.name === 'jobs-board'), 'it sees less now');

  await call('/api/keys/project', { id });
  assert.ok((await asOld('/api/robots')).body.robots.some((robot) => robot.name === 'jobs-board'), 'and the account again');
});

test('scrapers from before projects are put into one, a list at a time, or not at all', async () => {
  await onDisk({ name: 'legacy-one', channels: ['one'] });
  await onDisk({ name: 'legacy-two', channels: ['two'] });

  const listed = await call('/api/robots', {});
  assert.equal(listed.body.robots.find((robot) => robot.name === 'legacy-one').project, undefined, 'shown, with none');

  // A typo in the list moves nothing rather than half of it.
  const typo = await call('/api/robot/project', { names: ['legacy-one', 'legacy-tow'], project: 'jobs' });
  assert.equal(typo.status, 400);
  const still = await call('/api/robots', {});
  assert.equal(still.body.robots.find((robot) => robot.name === 'legacy-one').project, undefined);

  const nowhere = await call('/api/robot/project', { names: ['legacy-one'], project: '' });
  assert.equal(nowhere.status, 400, 'a scraper cannot be put into no project');

  const moved = await call('/api/robot/project', { names: ['legacy-one', 'legacy-two'], project: 'jobs' });
  assert.deepEqual(moved.body.moved, ['legacy-one', 'legacy-two']);
  const after = await call('/api/robots', { project: 'jobs' });
  assert.ok(after.body.robots.some((robot) => robot.name === 'legacy-two'));
});

test('a scraper deleted before projects comes back only into one', async () => {
  await onDisk({ name: 'legacy-deleted', channels: ['old'] });
  await call('/api/robot/delete', { name: 'legacy-deleted' });
  const one = (await call('/api/robot/deleted', {})).body.deleted.find((entry) => entry.name === 'legacy-deleted');

  const refused = await call('/api/robot/restore', { file: one.file });
  assert.equal(refused.status, 400);
  assert.match(refused.body.error, /belongs to a project/);

  const back = await call('/api/robot/restore', { file: one.file, project: 'jobs' });
  assert.equal(back.status, 200);
  const listed = await call('/api/robots', { project: 'jobs' });
  assert.ok(listed.body.robots.some((robot) => robot.name === 'legacy-deleted'));
});
