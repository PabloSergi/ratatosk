import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'vitest';
import { buildScenario } from '../src/index.ts';
import { deleteRobot, listRobots, loadRobot, saveRobot } from '../src/robots.ts';

const scenario = (name) =>
  buildScenario({
    name,
    url: 'https://example.com/jobs',
    rows: '.card',
    fields: { title: { type: 'text', selector: 'h3' } },
    pagination: { type: 'none' },
  });

test('a robot saved is a robot loaded', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ratatosk-'));
  try {
    const path = await saveRobot(scenario('jobs'), dir);
    assert.ok(path.endsWith('jobs.json'));
    const loaded = await loadRobot('jobs', dir);
    assert.equal(loaded.list.rows, '.card');
    assert.deepEqual(await listRobots(dir), [
      { name: 'jobs', kind: 'web', url: 'https://example.com/jobs', fields: ['title'], pagination: 'none' },
    ]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('asking for a robot that is not there says which ones are', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ratatosk-'));
  try {
    await saveRobot(scenario('jobs'), dir);
    await assert.rejects(() => loadRobot('flats', dir), /no robot named "flats". Known robots: jobs/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a robot name cannot wander out of the directory', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ratatosk-'));
  try {
    const path = await saveRobot(scenario('../../etc/passwd'), dir);
    assert.equal(path, join(dir, '..-..-etc-passwd.json'));
    assert.ok(!path.slice(dir.length + 1).includes('/'), 'the file name must not contain a path');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a stray file in the directory does not break the listing', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ratatosk-'));
  try {
    await saveRobot(scenario('jobs'), dir);
    await writeFile(join(dir, 'notes.json'), '{"this":"is not a scenario"}', 'utf8');
    const robots = await listRobots(dir);
    assert.equal(robots.length, 1);
    assert.equal(robots[0].name, 'jobs');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a deleted robot leaves the list but not the disk', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ratatosk-robots-'));
  await saveRobot(buildScenario({ name: 'goes', url: 'https://example.com/a', rows: '.card', fields: { title: { type: 'text' } }, pagination: { type: 'none' } }), dir);
  await saveRobot(buildScenario({ name: 'stays', url: 'https://example.com/b', rows: '.card', fields: { title: { type: 'text' } }, pagination: { type: 'none' } }), dir);

  const removed = await deleteRobot('goes', dir);

  const left = await listRobots(dir);
  assert.deepEqual(left.map((robot) => robot.name), ['stays'], 'it is gone from the list');
  assert.ok(removed.includes('deleted-'), 'and kept under a name that says what happened to it');
  assert.ok(JSON.parse(await readFile(removed, 'utf8')).name === 'goes', 'the file itself survives a misplaced click');
  await assert.rejects(() => loadRobot('goes', dir), /no robot named/);
});
