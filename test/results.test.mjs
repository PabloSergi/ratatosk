import assert from 'node:assert/strict';
import { mkdtemp, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, beforeEach } from 'vitest';

/**
 * Until now a run handed its rows over and forgot them: press Run, close the tab, and the work is gone.
 * Fine for a machine, which asked and has them; useless for a person, who ran something yesterday.
 *
 * A file per run, and no database — with the two things a file per run needs to be honest about: it
 * forgets the old ones on purpose, and it never keeps an empty one.
 */
let dir;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ratatosk-results-'));
  process.env.RATATOSK_RESULTS = dir;
  // These are about the file store, so they say so: with a database configured the same functions
  // would write there instead, and this file would be testing the wrong half of the code.
  delete process.env.RATATOSK_DB;
});

const load = async () => import('../src/results.ts');
const rows = (count) => Array.from({ length: count }, (_, index) => ({ title: `row ${index}` }));

test('what a run brought back can be read again afterwards', async () => {
  const { keepResult, keptRuns, readResult } = await load();

  await keepResult('u1', 'jobs', { at: '2026-09-04T10:00:00.000Z', status: 'ok', rows: rows(3), pagesVisited: 2 });

  const listed = await keptRuns('u1', 'jobs');
  assert.equal(listed.length, 1);
  assert.equal(listed[0].rows, 3, 'the list says how many without carrying them');
  assert.equal(listed[0].status, 'ok');

  const back = await readResult('u1', 'jobs', '2026-09-04T10:00:00.000Z');
  assert.equal(back.rows.length, 3);
  assert.equal(back.rows[0].title, 'row 0', 'and the rows are the rows');
  assert.equal(back.pagesVisited, 2);
});

test('a run that brought nothing back is not kept', async () => {
  const { keepResult, keptRuns } = await load();

  await keepResult('u1', 'jobs', { at: '2026-09-04T10:00:00.000Z', status: 'empty', rows: [], pagesVisited: 1 });
  assert.deepEqual(await keptRuns('u1', 'jobs'), [], 'its verdict is in the history; an empty file hides the useful ones');
});

test('only the last few runs are kept, or a scraper on a schedule fills a disk', async () => {
  process.env.RATATOSK_RESULTS_KEEP = '3';
  const { keepResult, keptRuns } = await load();

  for (const hour of ['08', '09', '10', '11', '12']) {
    await keepResult('u1', 'jobs', { at: `2026-09-04T${hour}:00:00.000Z`, status: 'ok', rows: rows(1), pagesVisited: 1 });
  }

  const listed = await keptRuns('u1', 'jobs');
  assert.equal(listed.length, 3);
  assert.deepEqual(
    listed.map((one) => one.at.slice(11, 13)),
    ['12', '11', '10'],
    'newest first, and the oldest are the ones that went',
  );
  delete process.env.RATATOSK_RESULTS_KEEP;
});

test('one scraper cannot read another scraper’s runs, and a name cannot be a path', async () => {
  const { keepResult, keptRuns, readResult } = await load();

  await keepResult('u1', 'jobs', { at: '2026-09-04T10:00:00.000Z', status: 'ok', rows: rows(2), pagesVisited: 1 });
  assert.deepEqual(await keptRuns('u2', 'jobs'), [], 'another account sees nothing');
  assert.deepEqual(await keptRuns('u1', 'other'), []);

  // A name comes from a person and becomes a path here, so it has to stay one path segment: the
  // separators are what would let it climb out, not the dots.
  await keepResult('u1', '../../escaped', { at: '2026-09-04T10:00:00.000Z', status: 'ok', rows: rows(1), pagesVisited: 1 });
  const inside = await readdir(join(dir, 'u1'));
  assert.ok(inside.includes('..-..-escaped'), `it went somewhere unexpected: ${inside.join(', ')}`);
  assert.deepEqual(await readdir(dir), ['u1'], 'and nothing was written beside the account, let alone above it');
});

test('asking for a run that has aged out is an empty answer, not a crash', async () => {
  const { readResult } = await load();
  assert.equal(await readResult('u1', 'jobs', '2020-01-01T00:00:00.000Z'), undefined);
});

test('deleting a scraper takes what it brought back with it', async () => {
  const { keepResult, keptRuns, forgetResults } = await load();

  await keepResult('u1', 'jobs', { at: '2026-09-04T10:00:00.000Z', status: 'ok', rows: rows(2), pagesVisited: 1 });
  await forgetResults('u1', 'jobs');
  assert.deepEqual(await keptRuns('u1', 'jobs'), []);
});
