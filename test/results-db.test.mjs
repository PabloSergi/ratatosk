import assert from 'node:assert/strict';
import { afterAll, beforeEach, test } from 'vitest';

/**
 * The same contract as the file store, against a real Postgres.
 *
 * It runs where there is one — the CI job starts a container, and `docker compose up` gives you one to
 * point at locally. Where there is not, these skip rather than fail: a laptop without a database is a
 * supported way to run this, and a suite that goes red on one would be lying about that.
 */
const url = process.env.RATATOSK_DB;
const when = url ? test : test.skip;

const load = async () => import('../src/results.ts');
const rows = (count) => Array.from({ length: count }, (_, index) => ({ title: `row ${index}`, city: 'Madrid' }));
const account = `test-${process.pid}`;

beforeEach(async () => {
  if (!url) return;
  const { forgetResults } = await load();
  for (const scraper of ['jobs', 'other', 'renamed']) await forgetResults(account, scraper);
});

afterAll(async () => {
  if (!url) return;
  const { closeDb } = await import('../src/db.ts');
  await closeDb();
});

when('a run goes in and comes back out whole', async () => {
  const { keepResult, keptRuns, readResult } = await load();

  await keepResult(account, 'jobs', {
    at: '2026-09-04T10:00:00.000Z',
    status: 'ok',
    rows: rows(3),
    pagesVisited: 2,
    reason: 'walk stopped early: no next control',
  });

  const listed = await keptRuns(account, 'jobs');
  assert.equal(listed.length, 1);
  assert.equal(listed[0].rows, 3, 'the list carries the count, not the rows');
  assert.equal(listed[0].at, '2026-09-04T10:00:00.000Z', 'and a timestamp that matches the history line');
  assert.match(listed[0].reason, /stopped early/);

  const back = await readResult(account, 'jobs', '2026-09-04T10:00:00.000Z');
  assert.equal(back.rows.length, 3);
  assert.equal(back.rows[0].city, 'Madrid');
  assert.equal(back.pagesVisited, 2);
});

when('the same run written twice is one run, not two', async () => {
  const { keepResult, keptRuns } = await load();
  const at = '2026-09-04T11:00:00.000Z';

  await keepResult(account, 'jobs', { at, status: 'ok', rows: rows(2), pagesVisited: 1 });
  await keepResult(account, 'jobs', { at, status: 'ok', rows: rows(5), pagesVisited: 1 });

  const listed = await keptRuns(account, 'jobs');
  assert.equal(listed.length, 1, 'a retry that lands twice must not double the history');
  assert.equal(listed[0].rows, 5, 'and the second write is what stands');
});

when('only the newest few are kept', async () => {
  process.env.RATATOSK_RESULTS_KEEP = '3';
  const { keepResult, keptRuns } = await load();

  for (const hour of ['08', '09', '10', '11', '12']) {
    await keepResult(account, 'jobs', { at: `2026-09-04T${hour}:00:00.000Z`, status: 'ok', rows: rows(1), pagesVisited: 1 });
  }

  const listed = await keptRuns(account, 'jobs');
  assert.equal(listed.length, 3);
  assert.deepEqual(listed.map((one) => one.at.slice(11, 13)), ['12', '11', '10']);
  delete process.env.RATATOSK_RESULTS_KEEP;
});

when('one scraper cannot see another one’s runs, and neither can another account', async () => {
  const { keepResult, keptRuns } = await load();

  await keepResult(account, 'jobs', { at: '2026-09-04T10:00:00.000Z', status: 'ok', rows: rows(1), pagesVisited: 1 });
  assert.deepEqual(await keptRuns(account, 'other'), []);
  assert.deepEqual(await keptRuns(`${account}-somebody-else`, 'jobs'), []);
});

when('renaming a scraper carries its runs, and deleting it takes them', async () => {
  const { keepResult, keptRuns, moveResults, forgetResults } = await load();

  await keepResult(account, 'jobs', { at: '2026-09-04T10:00:00.000Z', status: 'ok', rows: rows(4), pagesVisited: 1 });
  await moveResults(account, 'jobs', 'renamed');

  assert.deepEqual(await keptRuns(account, 'jobs'), [], 'nothing is left behind the old name');
  assert.equal((await keptRuns(account, 'renamed'))[0].rows, 4);

  await forgetResults(account, 'renamed');
  assert.deepEqual(await keptRuns(account, 'renamed'), []);
});

when('the rows are stored as data, not as a string of it', async () => {
  const { keepResult } = await load();
  const { db } = await import('../src/db.ts');

  await keepResult(account, 'jobs', { at: '2026-09-04T10:00:00.000Z', status: 'ok', rows: rows(3), pagesVisited: 1 });

  // The point of a database here rather than a file: asking a question of what was collected.
  const pool = await db();
  const { rows: found } = await pool.query(
    `SELECT count(*)::int AS n FROM results, jsonb_array_elements(rows) AS row
     WHERE user_id = $1 AND row->>'city' = 'Madrid'`,
    [account],
  );
  assert.equal(found[0].n, 3, '"every posting mentioning Madrid" is a query, which was the whole argument');
});
