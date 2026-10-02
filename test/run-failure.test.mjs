import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, test } from 'vitest';

/**
 * A run that could not start is still a run that happened.
 *
 * Everything the product knows about a scraper is written after the run: the journal line, the kept
 * rows, the message to the owner. A throw on the way to the browser used to skip all three, so a
 * scraper failing every hour looked exactly like one nobody had started — the card showed the last
 * good run and nothing was ever said. That is how a dead screen in the browsers' container went two
 * days without being noticed.
 */
let home;
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'ratatosk-failure-'));
  delete process.env.RATATOSK_DB;
  process.env.RATATOSK_ROBOTS = join(home, 'robots');
  process.env.RATATOSK_HISTORY = join(home, 'history');
  process.env.RATATOSK_RESULTS = join(home, 'results');
  process.env.RATATOSK_MEMORY = join(home, 'memory');
  process.env.RATATOSK_SECRETS = join(home, 'secrets');

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

test('a run that never got a browser is written down as broken', async () => {
  const { runForAccount } = await import('../src/do-run.ts');

  const pool = {
    use: async () => {
      throw new Error('browserType.launch: Target page, context or browser has been closed\nBrowser logs: …');
    },
  };

  const run = await runForAccount('someone', 'board', { pool, rules: [] });

  assert.equal(run.status, 'broken');
  assert.match(run.reason, /Target page, context or browser has been closed/);
  assert.ok(!run.reason.includes('\n'), 'one line, because it is shown on a card');

  const journal = await readFile(join(home, 'history', 'someone.jsonl'), 'utf8');
  const last = JSON.parse(journal.trim().split('\n').at(-1));
  assert.equal(last.robot, 'board');
  assert.equal(last.status, 'broken');
  assert.match(last.why, /Target page, context or browser has been closed/);
});

test('between full walks a scraper takes a quick look, and says which it was', async () => {
  const { runForAccount } = await import('../src/do-run.ts');
  const { finishedPass } = await import('../src/catalogue.ts');
  process.env.RATATOSK_CATALOGUE = join(home, 'catalogue');

  const asked = [];
  const pool = {
    use: async (_key, work) =>
      work({
        page: {
          async goto() {},
          async currentUrl() { return 'https://board.test/list'; },
          async click() {},
          async waitMs() {},
          async evaluate(source) {
            if (source.includes('querySelectorAll(selector).length')) return 5;
            if (source.includes('blocksSeen')) return { rows: [{ title: 'a posting' }], blocksSeen: 1, missing: {} };
            if (source.includes('blocks.length')) return { count: 1, texts: ['one'] };
            return null;
          },
        },
      }),
  };

  // A scraper told to look often and walk the whole thing once a day.
  const { readFile, writeFile } = await import('node:fs/promises');
  const path = join(home, 'robots', 'u', 'someone', 'board.json');
  const robot = JSON.parse(await readFile(path, 'utf8'));
  robot.pagination = { type: 'link', next: 'a[rel=next]', maxPages: 20 };
  robot.quick = { maxPages: 1, fullEveryHours: 24 };
  await writeFile(path, JSON.stringify(robot));

  // Nothing has ever been walked: the first run has to be the full one, or the quick look would be
  // measuring itself against a walk that never happened.
  const first = await runForAccount('someone', 'board', { pool, rules: [] });
  assert.equal(first.status, 'ok');
  const journal = async () => {
    const lines = (await readFile(join(home, 'history', 'someone.jsonl'), 'utf8')).trim().split('\n');
    return JSON.parse(lines.at(-1));
  };
  assert.ok(!(await journal()).quick, 'the first walk is the whole walk');

  const second = await runForAccount('someone', 'board', { pool, rules: [] });
  assert.equal(second.status, 'ok');
  assert.equal((await journal()).quick, true, 'and the one right after it is a quick look');

  // A day later the whole walk is owed again.
  await finishedPass('someone', 'board', new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString());
  await runForAccount('someone', 'board', { pool, rules: [] });
  assert.ok(!(await journal()).quick, 'once a day it is walked to the end again');
});
