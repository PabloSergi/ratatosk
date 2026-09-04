import assert from 'node:assert/strict';
import { test } from 'vitest';

import { DEFAULT_AFTER, tell, viewAlerts, whatToSay } from '../src/alerts.ts';

/**
 * The two ways this can be wrong are opposite and both fatal: say too much and it becomes noise people
 * turn off, say too little and it is a feature that does not exist. So the deciding is a pure function
 * and it is tested here, without a bot, a token or a network.
 */
const broken = (over = {}) => ({ robot: 'jobs', status: 'broken', at: '2026-09-04T04:00:00Z', rows: 0, inARow: 3, ...over });

test('one bad run is weather, a streak is a verdict', () => {
  assert.equal(whatToSay(broken({ inARow: 1 }), {}), undefined, 'a site hiccups; that is not news');
  assert.equal(whatToSay(broken({ inARow: 2 }), {}), undefined);
  assert.ok(whatToSay(broken({ inARow: 3 }), {}), `three in a row is the default (${DEFAULT_AFTER})`);
});

test('how long a streak has to be is the owner’s to set', () => {
  assert.ok(whatToSay(broken({ inARow: 1 }), { after: 1 }), 'somebody who wants to know immediately can');
  assert.equal(whatToSay(broken({ inARow: 4 }), { after: 5 }), undefined, 'and somebody who wants patience gets it');
});

test('a breakage is said once, not once per run', () => {
  const first = whatToSay(broken({ inARow: 3 }), {});
  assert.ok(first);
  assert.match(first.say, /broken 3 runs in a row/);

  const told = { told: { jobs: { status: 'broken', inARow: 3, at: '2026-09-04T04:00:00Z' } } };
  assert.equal(whatToSay(broken({ inARow: 4 }), told), undefined, 'a scraper running every half hour');
  assert.equal(whatToSay(broken({ inARow: 40 }), told), undefined, 'must not send forty eight of these');
});

test('a scraper that has started coming back empty instead of broken is a different thing to say', () => {
  const told = { told: { jobs: { status: 'broken', inARow: 3, at: '2026-09-04T04:00:00Z' } } };
  const nowEmpty = whatToSay(broken({ status: 'empty', inARow: 3, why: 'the rule kept none of them' }), told);
  assert.ok(nowEmpty, 'the state changed, so it is worth saying');
  assert.match(nowEmpty.say, /the rule kept none of them/);
});

test('recovery is worth exactly one message, and only to somebody who was told', () => {
  const fine = { robot: 'jobs', status: 'ok', at: '2026-09-04T06:00:00Z', rows: 120, inARow: 1 };

  assert.equal(whatToSay(fine, {}), undefined, 'a scraper that has always worked is not news every half hour');

  const told = { told: { jobs: { status: 'broken', inARow: 3, at: '2026-09-04T04:00:00Z' } } };
  const back = whatToSay(fine, told);
  assert.ok(back);
  assert.equal(back.kind, 'recovered');
  assert.match(back.say, /working again/);
  assert.match(back.say, /120 rows/);

  const already = { told: { jobs: { status: 'ok', inARow: 1, at: '2026-09-04T06:00:00Z' } } };
  assert.equal(whatToSay(fine, already), undefined, 'and said once');
});

test('a door meant for a person says so, because Repair cannot help with that', () => {
  const wall = whatToSay(broken({ door: true, why: 'a challenge page' }), {});
  assert.match(wall.say, /meant for a person/);
  assert.match(wall.say, /Open it yourself/);
  assert.doesNotMatch(wall.say, /Repair rebuilds/, 'sending somebody to press Repair on a CAPTCHA is a lie');
});

test('the token is never handed back, only its last four characters', () => {
  const shown = viewAlerts({ botToken: '123456:AAsecret-token-material', chatId: '42', after: 2 });
  assert.equal(shown.on, true);
  assert.equal(shown.after, 2);
  assert.equal(shown.tokenHint, '…rial');
  assert.ok(!JSON.stringify(shown).includes('secret-token-material'), 'the token stays on the server');
});

test('half a setup is off, not on', () => {
  assert.equal(viewAlerts({ botToken: 'x' }).on, false, 'a bot with nobody to write to says nothing');
  assert.equal(viewAlerts({ chatId: '42' }).on, false);
  assert.equal(viewAlerts({}).on, false);
});

test('sending without a setup refuses instead of pretending', async () => {
  await assert.rejects(() => tell({}, 'hello'), /no bot token or chat id/);
});

test('what Telegram says about a refusal is what the person is shown', async () => {
  const refusing = async () => ({
    ok: false,
    status: 400,
    json: async () => ({ description: 'chat not found' }),
  });

  await assert.rejects(
    () => tell({ botToken: 't', chatId: 'nobody' }, 'hello', refusing),
    /chat not found/,
    'our own "something went wrong" would be less useful than theirs',
  );
});

test('a message goes to the chat it was set up for, as plain text', async () => {
  let sent;
  const sending = async (url, options) => {
    sent = { url, body: JSON.parse(options.body) };
    return { ok: true, json: async () => ({ ok: true }) };
  };

  await tell({ botToken: '123:AA', chatId: '42' }, 'a scraper broke', sending);
  assert.match(sent.url, /^https:\/\/api\.telegram\.org\/bot123:AA\/sendMessage$/);
  assert.equal(sent.body.chat_id, '42');
  assert.equal(sent.body.text, 'a scraper broke');
});
