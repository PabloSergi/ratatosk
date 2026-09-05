import assert from 'node:assert/strict';
import { afterAll, beforeEach, test } from 'vitest';

/**
 * The scheduler's whole job is to be boring under two workers and a restart: one run when one run is
 * due, and never three because two processes asked at the same moment or because somebody was down
 * for an hour. That is a claim about SQL, so it is tested against Postgres or not at all.
 */
const url = process.env.RATATOSK_DB;
const when = url ? test : test.skip;
const account = `sched-${process.pid}`;

const load = async () => import('../src/schedule.ts');

beforeEach(async () => {
  if (!url) return;
  const { db } = await import('../src/db.ts');
  const pool = await db();
  await pool.query('DELETE FROM schedules WHERE user_id LIKE $1', [`${account}%`]);
});

afterAll(async () => {
  if (!url) return;
  const { closeDb } = await import('../src/db.ts');
  await closeDb();
});

when('an interval is set, changed and taken away', async () => {
  const { setSchedule, schedulesFor } = await load();

  const set = await setSchedule(account, 'jobs', 30);
  assert.equal(set.everyMinutes, 30);
  assert.ok(new Date(set.nextAt).getTime() > Date.now(), 'the next time is in the future');

  const changed = await setSchedule(account, 'jobs', 60);
  assert.equal(changed.everyMinutes, 60);
  assert.equal((await schedulesFor(account)).length, 1, 'changing an interval does not make a second schedule');

  await setSchedule(account, 'jobs', undefined);
  assert.deepEqual(await schedulesFor(account), [], 'and "by hand" means there is no schedule at all');
});

when('an interval below the floor is lifted to it', async () => {
  const { setSchedule, SHORTEST_MINUTES } = await load();
  const eager = await setSchedule(account, 'jobs', 1);
  assert.equal(eager.everyMinutes, SHORTEST_MINUTES, 'a browser run barely finishes before the next would be due');
});

when('what is due is claimed once, however many workers ask', async () => {
  const { setSchedule, claimDue } = await load();
  const { db } = await import('../src/db.ts');

  await setSchedule(account, 'jobs', 30);
  // Make it due: the same as an hour passing, without waiting an hour.
  const pool = await db();
  await pool.query("UPDATE schedules SET next_at = now() - interval '1 minute' WHERE user_id = $1", [account]);

  // Two workers asking at the same moment. Exactly one of them gets the job.
  const [first, second] = await Promise.all([claimDue(), claimDue()]);
  const taken = [...first, ...second].filter((one) => one.userId === account);
  assert.equal(taken.length, 1, `two workers must not run one scraper twice: ${JSON.stringify(taken)}`);
  assert.equal(taken[0].scraper, 'jobs');
});

when('a worker that was down for an hour does not run twelve times to catch up', async () => {
  const { setSchedule, claimDue, schedulesFor } = await load();
  const { db } = await import('../src/db.ts');

  await setSchedule(account, 'jobs', 5);
  const pool = await db();
  await pool.query("UPDATE schedules SET next_at = now() - interval '1 hour' WHERE user_id = $1", [account]);

  const first = (await claimDue()).filter((one) => one.userId === account);
  assert.equal(first.length, 1);

  const again = (await claimDue()).filter((one) => one.userId === account);
  assert.deepEqual(again, [], 'the next time is set from now, not from the time it slept through');

  const [now] = await schedulesFor(account);
  assert.ok(new Date(now.nextAt).getTime() > Date.now(), 'and it is due again in five minutes, not twelve times over');
  assert.ok(now.lastAt, 'the run it just claimed is recorded');
});

when('a schedule follows a rename and dies with a delete', async () => {
  const { setSchedule, schedulesFor, moveSchedule, forgetSchedule } = await load();

  await setSchedule(account, 'jobs', 30);
  await moveSchedule(account, 'jobs', 'renamed');
  assert.deepEqual((await schedulesFor(account)).map((one) => one.scraper), ['renamed']);

  await forgetSchedule(account, 'renamed');
  assert.deepEqual(await schedulesFor(account), [], 'a schedule for a scraper that no longer exists is a lie');
});
