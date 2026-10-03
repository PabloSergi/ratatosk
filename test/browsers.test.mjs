import assert from 'node:assert/strict';
import { test } from 'vitest';
import { BrowserPool } from '../src/browsers.ts';

/** A stand-in for a browser: it records that it was opened and closed, and says whether it is still there. */
function fakePool({ max = 2 } = {}) {
  const opened = [];
  const closed = [];
  const live = [];
  const pool = new BrowserPool({
    max,
    profileDir: (key) => `profiles/${key}`,
    open: async (profileDir) => {
      opened.push(profileDir);
      const session = {
        gone: false,
        page: {
          id: profileDir,
          async currentUrl() {
            if (session.gone) throw new Error('Target page, context or browser has been closed');
            return 'about:blank';
          },
        },
        close: async () => { closed.push(profileDir); },
      };
      live.push(session);
      return session;
    },
  });
  return { pool, opened, closed, live };
}

test('each account gets its own browser and its own profile', async () => {
  const { pool, opened } = fakePool();
  const a = await pool.use('user-a', async (session) => session.page.id);
  const b = await pool.use('user-b', async (session) => session.page.id);
  assert.equal(a, 'profiles/user-a');
  assert.equal(b, 'profiles/user-b');
  assert.deepEqual(opened, ['profiles/user-a', 'profiles/user-b']);
  await pool.closeAll();
});

test('the same account reuses its browser instead of starting another', async () => {
  const { pool, opened } = fakePool();
  await pool.use('user-a', async () => 1);
  await pool.use('user-a', async () => 2);
  assert.equal(opened.length, 1);
  await pool.closeAll();
});

test('work for one account never overlaps', async () => {
  const { pool } = fakePool();
  const order = [];
  const slow = pool.use('user-a', async () => {
    order.push('first in');
    await new Promise((resolve) => setTimeout(resolve, 30));
    order.push('first out');
  });
  const quick = pool.use('user-a', async () => { order.push('second in'); });
  await Promise.all([slow, quick]);
  assert.deepEqual(order, ['first in', 'first out', 'second in']);
  await pool.closeAll();
});

test('past the cap, the least recently used browser is closed', async () => {
  const { pool, closed } = fakePool({ max: 2 });
  await pool.use('a', async () => 1);
  await pool.use('b', async () => 1);
  await pool.use('a', async () => 1);   // a is now the fresher of the two
  await pool.use('c', async () => 1);   // needs a slot: b must go
  assert.deepEqual(closed, ['profiles/b']);
  assert.equal(pool.openCount, 2);
  await pool.closeAll();
});

test('a browser that throws is dropped, and the next call starts a fresh one', async () => {
  const { pool, opened, closed } = fakePool();
  await assert.rejects(() => pool.use('a', async () => { throw new Error('the page exploded'); }), /exploded/);
  assert.deepEqual(closed, ['profiles/a']);
  await pool.use('a', async () => 1);
  assert.equal(opened.length, 2);
  await pool.closeAll();
});

test('a browser that went away behind our back is replaced, not handed out', async () => {
  const { pool, opened, closed, live } = fakePool();
  await pool.use('a', async () => 1);
  assert.equal(opened.length, 1);

  // The browsers live in a container of their own; it was restarted. Nothing told this pool, and the
  // handle it kept now answers every call with "target closed".
  live[0].gone = true;

  const used = await pool.use('a', async (session) => session.page.id);
  assert.equal(used, 'profiles/a');
  assert.equal(opened.length, 2, 'a fresh one was started');
  assert.deepEqual(closed, ['profiles/a'], 'and the dead one was let go');
  await pool.closeAll();
});
