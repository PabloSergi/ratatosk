import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, test } from 'vitest';

import { claim } from '../src/together.ts';
import { runRobot } from '../src/run-robot.ts';

let where;
beforeEach(async () => {
  where = await mkdtemp(join(tmpdir(), 'together-'));
  process.chdir(where);
});
afterEach(async () => {
  process.chdir(tmpdir());
  await rm(where, { recursive: true, force: true });
});

test('первый забравший отдаёт, остальные молчат', async () => {
  const first = await claim({ userId: 'u', group: 'reddit', keys: ['a', 'b'] });
  assert.deepEqual([...first].sort(), ['a', 'b']);

  const second = await claim({ userId: 'u', group: 'reddit', keys: ['b', 'c'] });
  assert.deepEqual([...second], ['c'], 'b уже отдан кем-то из группы');

  const other = await claim({ userId: 'u', group: 'forums', keys: ['b'] });
  assert.deepEqual([...other], ['b'], 'другая группа — другой счёт');

  const another = await claim({ userId: 'кто-то ещё', group: 'reddit', keys: ['b'] });
  assert.deepEqual([...another], ['b'], 'и другой аккаунт тоже');
});

/**
 * Зачем это вообще: один и тот же пост reddit приходит и из ленты саба, и из поиска по всему
 * reddit. Для каждой ленты он новый — своя память, — и без общего прохода он уезжает дважды.
 */
test('две ленты на один поток отдают пост один раз', async () => {
  const post = { title: 'Hiring chatter', link: 'https://reddit.com/r/x/comments/1/' };
  const feed = { name: 'f', version: 1, source: 'feed', url: 'https://x.test/f.rss',
                 remember: { by: 'link', mode: 'new', with: 'reddit' } };

  const atom = `<feed><entry><title>Hiring chatter</title><link href="${post.link}"/><updated>2026-10-09T00:00:00Z</updated></entry></feed>`;
  const get = async () => ({ status: 200, statusText: 'OK', body: atom });
  const page = async () => { throw new Error('браузер тут не нужен'); };

  const memoryOf = () => {
    let held = {};
    return { seen: held, save: async (next) => { held = next; } };
  };

  const fromSub = await runRobot({ ...feed, name: 'reddit-sub' }, { page, get, memory: memoryOf(), together: { userId: 'u', group: 'reddit' } });
  assert.equal(fromSub.rows.length, 1, 'кто первый, тот и отдаёт');

  const fromSearch = await runRobot({ ...feed, name: 'reddit-search' }, { page, get, memory: memoryOf(), together: { userId: 'u', group: 'reddit' } });
  assert.equal(fromSearch.rows.length, 0, 'вторая лента видит, что пост уже отдан');
  assert.match(String(fromSearch.reason), /already handed over by reddit/);
});
