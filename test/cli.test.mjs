import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { test } from 'vitest';

const run = promisify(execFile);

/**
 * The command line is the path cron takes, and cron is the documented way to put a scraper on a
 * schedule. It has to accept every kind of scraper the web view can make — a Telegram one used to be
 * refused with "url is required", which meant the documented way to schedule one did not exist.
 */
async function cli(robot, extra = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'ratatosk-cli-'));
  const path = join(dir, 'scraper.json');
  await writeFile(path, JSON.stringify(robot), 'utf8');

  try {
    const done = await run('node', ['dist/cli.js', path, '--json'], {
      env: { ...process.env, RATATOSK_ROBOTS: dir, ...extra },
    });
    return { code: 0, ...done };
  } catch (error) {
    return { code: error.code, stdout: error.stdout ?? '', stderr: error.stderr ?? '' };
  }
}

test('a telegram scraper is understood rather than refused for having no url', async () => {
  const answer = await cli(
    { name: 'a-channel', version: 1, source: 'telegram', channels: ['pythonjobs'], limit: 5 },
    { RATATOSK_TG_SESSION: join(tmpdir(), 'no-such-session.json') },
  );

  // It cannot read anything without a session, and that is the honest complaint — the point is that
  // the complaint is about the session and not about a field a Telegram scraper never has.
  assert.doesNotMatch(`${answer.stdout}${answer.stderr}`, /url is required/);
  assert.match(`${answer.stdout}${answer.stderr}`, /telegram|session|sign in|connect/i);
});

test('a page scraper still runs, and a broken one exits non-zero', async () => {
  const answer = await cli({
    name: 'nowhere',
    version: 1,
    url: 'http://127.0.0.1:1/nothing-here',
    wait: { selector: 'article', minCount: 1, timeoutMs: 2000 },
    list: { rows: 'article', fields: { title: { type: 'text', selector: 'h1' } } },
    pagination: { type: 'none' },
  });

  assert.equal(answer.code, 1, 'a scraper that could not read anything must not report success');
  assert.match(answer.stdout, /"status": "broken"/);
});

test('a scraper file that is not a scraper is refused with a readable reason', async () => {
  const answer = await cli({ name: 'nonsense', version: 1 });
  assert.equal(answer.code, 2);
  assert.doesNotMatch(answer.stderr, /at Object|at Module|\.js:\d+/, 'a stack trace is not a reason');
});
