import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'vitest';

import { recent, remember, renameInHistory, standing } from '../src/history.ts';

/**
 * The product's claim is that a scraper says when it breaks, and a claim like that needs a memory:
 * one run returning eleven rows means nothing, eleven where yesterday there were four hundred means
 * the site changed under it.
 */
async function logbook() {
  return join(await mkdtemp(join(tmpdir(), 'ratatosk-history-')), 'runs.jsonl');
}

const run = (over = {}) => ({
  at: '2026-08-27T10:00:00.000Z',
  robot: 'city-jobs',
  kind: 'run',
  status: 'ok',
  rows: 173,
  pages: 5,
  ms: 4200,
  ...over,
});

test('runs come back newest first', async () => {
  const file = await logbook();
  await remember(file, run({ at: '2026-08-27T10:00:00.000Z', rows: 173 }));
  await remember(file, run({ at: '2026-08-27T11:00:00.000Z', rows: 12 }));

  const runs = await recent(file);
  assert.equal(runs.length, 2);
  assert.equal(runs[0].rows, 12, 'the latest is the one you came to see');
  assert.equal(runs[1].rows, 173);
});

test('one robot can be asked about on its own', async () => {
  const file = await logbook();
  await remember(file, run({ robot: 'city-jobs' }));
  await remember(file, run({ robot: 'erosjobs', rows: 12 }));

  const mine = await recent(file, { robot: 'erosjobs' });
  assert.equal(mine.length, 1);
  assert.equal(mine[0].robot, 'erosjobs');
});

test('a logbook nobody has written to is empty, not an error', async () => {
  assert.deepEqual(await recent(join(await mkdtemp(join(tmpdir(), 'r-')), 'nothing.jsonl')), []);
});

test('a line that got mangled does not take the rest of the story with it', async () => {
  const file = await logbook();
  await remember(file, run({ rows: 173 }));
  await writeFile(file, (await readFile(file, 'utf8')) + 'half a line, no newline, no JSON\n');
  await remember(file, run({ at: '2026-08-27T12:00:00.000Z', rows: 12 }));

  const runs = await recent(file);
  assert.equal(runs.length, 2, 'both real runs survive');
});

test('standing says how each robot is now, and for how long', async () => {
  const file = await logbook();
  // Oldest first, as they happened: fine, fine, then the site changed.
  await remember(file, run({ at: '2026-08-27T08:00:00.000Z', status: 'ok', rows: 173 }));
  await remember(file, run({ at: '2026-08-27T09:00:00.000Z', status: 'broken', rows: 0, why: 'page never rendered' }));
  await remember(file, run({ at: '2026-08-27T10:00:00.000Z', status: 'broken', rows: 0, why: 'page never rendered' }));
  await remember(file, run({ robot: 'erosjobs', at: '2026-08-27T10:30:00.000Z', status: 'ok', rows: 12 }));

  const now = await standing(file);
  const cityJobs = now.find((entry) => entry.robot === 'city-jobs');
  assert.equal(cityJobs.status, 'broken');
  assert.equal(cityJobs.inARow, 2, 'two in a row is a verdict; one would be noise');
  assert.match(cityJobs.why, /never rendered/);

  const erosjobs = now.find((entry) => entry.robot === 'erosjobs');
  assert.equal(erosjobs.status, 'ok');
  assert.equal(erosjobs.inARow, 1);
});

test('a run that recovered ends the streak of the ones before it', async () => {
  const file = await logbook();
  await remember(file, run({ at: '2026-08-27T08:00:00.000Z', status: 'broken', rows: 0 }));
  await remember(file, run({ at: '2026-08-27T09:00:00.000Z', status: 'broken', rows: 0 }));
  await remember(file, run({ at: '2026-08-27T10:00:00.000Z', status: 'ok', rows: 173 }));

  const [cityJobs] = await standing(file);
  assert.equal(cityJobs.status, 'ok');
  assert.equal(cityJobs.inARow, 1, 'it is fine now, and it has been fine for exactly one run');
});

test('a build is not how a robot is doing', async () => {
  const file = await logbook();
  await remember(file, run({ kind: 'build', status: 'ok', rows: 12, at: '2026-08-27T11:00:00.000Z' }));
  assert.deepEqual(await standing(file), [], 'building it says nothing about whether it still works');
});

test('a renamed scraper keeps its past, under the new name', async () => {
  const file = join(await mkdtemp(join(tmpdir(), 'ratatosk-history-')), 'runs.jsonl');
  await remember(file, run({ robot: 'before', rows: 40 }));
  await remember(file, run({ robot: 'somebody-else', rows: 7 }));
  await remember(file, run({ robot: 'before', rows: 41 }));

  const moved = await renameInHistory(file, 'before', 'after');
  assert.equal(moved, 2, 'both of its runs, and only its own');

  const now = await recent(file);
  assert.equal(now.filter((entry) => entry.robot === 'after').length, 2);
  assert.equal(now.filter((entry) => entry.robot === 'before').length, 0, 'nothing is left behind the old name');
  assert.equal(now.filter((entry) => entry.robot === 'somebody-else').length, 1, "and nobody else's story moved");
});

test('renaming in a history that does not exist yet is not an error', async () => {
  const file = join(await mkdtemp(join(tmpdir(), 'ratatosk-history-')), 'nothing.jsonl');
  assert.equal(await renameInHistory(file, 'a', 'b'), 0, 'a scraper that never ran has nothing to carry');
});
