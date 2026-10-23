import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { access, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, test } from 'vitest';

/**
 * What a run marks as handed over must be what was actually kept.
 *
 * A scraper that remembers decides what is new at the start of its handover and, for a feed, walks
 * into every new row after deciding. The memory used to be written at the deciding: a worker restarted
 * during the walk — a deploy, nothing more — left a memory that called a whole first pass "seen" and no
 * rows anywhere, and every run after it said "1711 of 1715 had been seen before" about listings nobody
 * had ever received.
 */
let server;
let board;
let home;

beforeAll(async () => {
  server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ items: [{ id: 'a1', title: 'a flat' }, { id: 'a2', title: 'another flat' }] }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  board = `http://127.0.0.1:${server.address().port}/list`;
});

afterAll(() => server?.close());

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'ratatosk-kept-'));
  delete process.env.RATATOSK_DB;
  process.env.RATATOSK_ROBOTS = join(home, 'robots');
  process.env.RATATOSK_HISTORY = join(home, 'history');
  process.env.RATATOSK_RESULTS = join(home, 'results');
  process.env.RATATOSK_MEMORY = join(home, 'memory');

  await mkdir(join(home, 'robots', 'u', 'someone'), { recursive: true });
  await writeFile(
    join(home, 'robots', 'u', 'someone', 'flats.json'),
    JSON.stringify({
      name: 'flats',
      version: 1,
      source: 'api',
      project: 'rent',
      url: board,
      rowsAt: 'items',
      identity: 'id',
      fields: { id: 'id', title: 'title' },
      remember: { mode: 'new', by: 'id' },
    }),
  );
});

const exists = (path) => access(path).then(() => true, () => false);

test('rows that could not be kept are not remembered, and come again next time', async () => {
  const { runForAccount } = await import('../src/do-run.ts');
  const { memoryFileFor } = await import('../src/memory.ts');

  // Somewhere rows cannot be written: a file standing where their directory should be.
  await writeFile(join(home, 'results'), 'not a directory');
  const lost = await runForAccount('someone', 'flats', { pool: {}, rules: [] });
  assert.equal(lost.rows.length, 2, 'the run itself found them');
  assert.equal(await exists(memoryFileFor('someone', 'flats')), false, 'but nothing says they were handed over');

  process.env.RATATOSK_RESULTS = join(home, 'results-fixed');
  const again = await runForAccount('someone', 'flats', { pool: {}, rules: [] });
  assert.equal(again.rows.length, 2, 'so they are offered again rather than called "seen before"');
});

test('a run stopped between finding rows and keeping them leaves the memory as it was', async () => {
  const { runForAccount } = await import('../src/do-run.ts');
  const { memoryFileFor } = await import('../src/memory.ts');

  // The journal is written before the rows are kept; failing there is the same as the process dying
  // there, which is what a restarted worker does.
  await writeFile(join(home, 'history'), 'not a directory');
  await assert.rejects(() => runForAccount('someone', 'flats', { pool: {}, rules: [] }));
  assert.equal(await exists(memoryFileFor('someone', 'flats')), false);
});

test('rows that were kept are remembered, and a second run is quiet about them', async () => {
  const { runForAccount } = await import('../src/do-run.ts');

  const first = await runForAccount('someone', 'flats', { pool: {}, rules: [] });
  assert.equal(first.rows.length, 2);

  const second = await runForAccount('someone', 'flats', { pool: {}, rules: [] });
  assert.equal(second.rows.length, 0);
  assert.equal(second.quiet, true);
  assert.match(second.reason, /2 of 2 had been seen before/);
});
