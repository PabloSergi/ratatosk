import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, test } from 'vitest';

import { whatToSay } from '../src/alerts.ts';
import { Overdue, withDeadline } from '../src/deadline.ts';
import { runTelegramRobot } from '../src/telegram.ts';
import { describe, tellAboutWorker, Watchdog, whomToTell } from '../src/watchdog.ts';

/**
 * A worker that waits for ever is a worker that says nothing.
 *
 * On 2026-10-29 one batch of runs stopped at 05:46 and the container stayed "Up" until somebody
 * restarted it four hours later. No run ended, so no history said anything, and no owner was told.
 * These are the pieces that make that impossible to miss: a deadline on every run, a client that is
 * let go of when the run is given up on, and a watchdog that restarts what has stopped moving.
 */
const never = () => new Promise(() => {});

test('work that finishes in time comes back as it was', async () => {
  assert.equal(await withDeadline('quick', 1000, async () => 'rows'), 'rows');
});

test('work that does not finish is stopped, told so, and reported as overdue', async () => {
  let told;
  const answer = withDeadline('slow', 20, (signal) => {
    signal.addEventListener('abort', () => (told = signal.reason));
    return never();
  });

  await assert.rejects(answer, (error) => error instanceof Overdue && /slow did not finish in 20 ms/.test(error.message));
  assert.ok(told instanceof Overdue, 'the work heard about it, so it can close what it holds');
});

/** A Telegram client that answers what it is asked to, or nothing at all. */
function reader({ hangOn, failConnect } = {}) {
  const calls = [];
  return {
    calls,
    client: {
      connect: async () => {
        calls.push('connect');
        if (failConnect) throw new Error('could not reach a data centre');
      },
      disconnect: async () => calls.push('disconnect'),
      destroy: async () => calls.push('destroy'),
      getEntity: async (channel) => (channel === hangOn ? never() : { channel }),
      iterMessages: async function* () {
        yield { id: 7, date: Date.parse('2026-10-29T05:00:00Z') / 1000, message: 'a vacancy' };
      },
    },
  };
}

const robot = { name: 'tg-jobs', version: 1, source: 'telegram', channels: ['jobs'], limit: 10 };

test('a Telegram read destroys its client, because disconnect leaves the ping loop running', async () => {
  const fake = reader();
  const { rows } = await runTelegramRobot(robot, undefined, fake);

  assert.equal(rows.length, 1);
  assert.deepEqual(fake.calls, ['connect', 'destroy'], 'destroy, not disconnect: only destroy stops gramJS pinging');
});

test('a client that failed to connect is let go of too — gramJS starts pinging either way', async () => {
  const fake = reader({ failConnect: true });
  await assert.rejects(runTelegramRobot(robot, undefined, fake), /could not reach a data centre/);
  assert.deepEqual(fake.calls, ['connect', 'destroy']);
});

test('a Telegram read that is given up on lets go of its client at once', async () => {
  const fake = reader({ hangOn: 'jobs' });
  const stop = new AbortController();
  void runTelegramRobot(robot, undefined, fake, stop.signal);
  await new Promise((resolve) => setTimeout(resolve, 10));

  stop.abort(new Error('overdue'));
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(fake.calls, ['connect', 'destroy'], 'not when getEntity comes back — it never will');
});

let home;
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'ratatosk-watchdog-'));
  delete process.env.RATATOSK_DB;
  process.env.RATATOSK_ROBOTS = join(home, 'robots');
  process.env.RATATOSK_HISTORY = join(home, 'history');
  process.env.RATATOSK_RESULTS = join(home, 'results');
  process.env.RATATOSK_MEMORY = join(home, 'memory');

  await mkdir(join(home, 'robots', 'u', 'someone'), { recursive: true });
  await writeFile(
    join(home, 'robots', 'u', 'someone', 'board.json'),
    JSON.stringify({
      name: 'board',
      version: 1,
      url: 'https://board.test/list',
      wait: { selector: '.card', minCount: 1, timeoutMs: 300, settleMs: 0 },
      list: { rows: '.card', fields: { title: { type: 'text' } } },
      pagination: { type: 'none' },
      expect: { minRowsPerPage: 1 },
    }),
  );
});

test('a run past its deadline ends as broken in its history, and its browser is closed', async () => {
  const { runForAccount } = await import('../src/do-run.ts');

  const closed = [];
  const pool = { use: never, close: async (key) => closed.push(key) };

  const run = await runForAccount('someone', 'board', { pool, rules: [], deadlineMs: 30 });

  assert.equal(run.status, 'broken');
  assert.match(run.reason, /board did not finish in 30 ms and was stopped/);
  assert.deepEqual(closed, ['someone'], 'the page it was stuck on is closed under it');

  const journal = await readFile(join(home, 'history', 'someone.jsonl'), 'utf8');
  const last = JSON.parse(journal.trim().split('\n').at(-1));
  assert.equal(last.status, 'broken');
  assert.match(last.why, /did not finish/);
});

test('a run that had to be stopped is told about the first time, not the third', () => {
  const now = { robot: 'board', status: 'broken', at: '2026-10-29T06:16:39Z', rows: 0, inARow: 1, why: 'board did not finish in 30 min and was stopped' };

  assert.equal(whatToSay(now, { after: 3 }), undefined, 'an ordinary bad run is still weather');
  const telling = whatToSay(now, { after: 3 }, { urgent: true });
  assert.equal(telling?.kind, 'broken');
  assert.match(telling.say, /did not finish in 30 min/);

  const alreadyTold = { after: 3, told: { board: { status: 'broken', inARow: 1, at: now.at } } };
  assert.equal(whatToSay(now, alreadyTold, { urgent: true }), undefined, 'and not again until it changes');
});

test('a part is stuck once it has been quiet for longer than it said it would be', () => {
  let clock = 0;
  const watchdog = new Watchdog(() => clock);
  watchdog.beat('tick', 15 * 60_000, 'scheduling');
  watchdog.beat('hand 1', 35 * 60_000, 'running tg-ofmcareers', 'someone');

  clock = 14 * 60_000;
  assert.deepEqual(watchdog.stuck(), []);

  clock = 16 * 60_000;
  assert.deepEqual(watchdog.stuck().map((part) => part.part), ['tick'], 'a long run is not a stuck one');

  clock = 36 * 60_000;
  watchdog.beat('tick', 15 * 60_000, 'scheduling');
  const [hand, ...others] = watchdog.stuck();
  assert.deepEqual(others, []);
  assert.equal(hand.part, 'hand 1');
  assert.equal(hand.user, 'someone');
  assert.match(describe([hand]), /hand 1: running tg-ofmcareers, silent for 36 min/);
});

test('the worker being stuck is told to whoever has alerts set up, and not again within the hour', async () => {
  const alertsDir = join(home, 'alerts');
  await mkdir(alertsDir, { recursive: true });
  await writeFile(join(alertsDir, 'someone.json'), JSON.stringify({ botToken: '1:abc', chatId: '42' }));
  await writeFile(join(alertsDir, 'quiet.json'), JSON.stringify({}));

  const sent = [];
  const fetcher = async (url, init) => {
    sent.push(JSON.parse(init.body));
    return { ok: true, json: async () => ({}) };
  };
  const toldFile = join(home, 'watchdog.json');
  let clock = Date.parse('2026-10-29T06:01:00Z');
  const options = { alertsDir, toldFile, fetcher, now: () => clock };
  const stuck = [{ part: 'tick', doing: 'scheduling', quietMs: 16 * 60_000 }];

  assert.deepEqual(await tellAboutWorker('stuck', stuck, options), ['someone']);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].chat_id, '42');

  clock += 15 * 60_000;
  assert.deepEqual(await tellAboutWorker('stuck again', stuck, options), [], 'a restart loop is one message, not four an hour');

  clock += 60 * 60_000;
  assert.deepEqual(await tellAboutWorker('still stuck', stuck, options), ['someone']);
});

test('a named owner hears about the worker, and so does whoever owned the run that was stuck', async () => {
  const stuck = [{ part: 'hand 2', doing: 'running board', quietMs: 1, user: 'someone' }];
  assert.deepEqual(await whomToTell(join(home, 'nowhere'), 'pavel', stuck), ['pavel', 'someone']);
  assert.deepEqual(await whomToTell(join(home, 'nowhere'), undefined, stuck), ['someone']);
});
