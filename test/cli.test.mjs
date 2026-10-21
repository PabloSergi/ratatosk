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
 *
 * What a page scraper does needs a browser, so it is proved in the browser suite instead: this one
 * runs in seconds on a machine that has no Chromium, and a test that quietly needs one would fail
 * there for a reason that has nothing to do with the code.
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

test('a scraper file that is not a scraper is refused with a readable reason', async () => {
  const answer = await cli({ name: 'nonsense', version: 1 });
  assert.equal(answer.code, 2);
  assert.doesNotMatch(answer.stderr, /at Object|at Module|\.js:\d+/, 'a stack trace is not a reason');
});

test('the scrapers are listed project by project, or for one project alone', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ratatosk-cli-'));
  const channel = (name, project) => ({ name, version: 1, source: 'telegram', channels: [name], limit: 5, ...(project ? { project } : {}) });
  await writeFile(join(dir, 'flats.json'), JSON.stringify(channel('flats', 'vietrent')));
  await writeFile(join(dir, 'jobs.json'), JSON.stringify(channel('jobs', 'adult-job')));
  await writeFile(join(dir, 'old.json'), JSON.stringify(channel('old')));

  const all = await run('node', ['dist/cli.js', 'robots'], { env: { ...process.env, RATATOSK_ROBOTS: dir } });
  assert.match(all.stdout, /vietrent: 1\n {2}flats/);
  assert.match(all.stdout, /\(no project — give it one\): 1\n {2}old/);

  const one = await run('node', ['dist/cli.js', 'robots', '--project', 'vietrent', '--json'], {
    env: { ...process.env, RATATOSK_ROBOTS: dir },
  });
  assert.deepEqual(JSON.parse(one.stdout).map((robot) => robot.name), ['flats']);
});
