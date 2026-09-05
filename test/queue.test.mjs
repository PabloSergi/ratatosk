import assert from 'node:assert/strict';
import { afterAll, test } from 'vitest';

/**
 * The queue holds one rule worth testing: a scraper is never walking a site in two browsers at once.
 * That is not tidiness — two browsers on one site through one proxy is how an address gets blocked,
 * and two runs writing one memory is how a posting is handed over twice and then never again.
 */
const url = process.env.RATATOSK_REDIS;
const when = url ? test : test.skip;
const job = (scraper) => ({ userId: `q-${process.pid}`, scraper, because: 'asked' });

afterAll(async () => {
  if (!url) return;
  const { closeQueue } = await import('../src/queue.ts');
  await closeQueue();
});

when('a job goes in and comes back out', async () => {
  const { enqueue, nextJob } = await import('../src/queue.ts');

  await enqueue(job('jobs'));
  const taken = await nextJob(2);
  assert.equal(taken.scraper, 'jobs');
  assert.equal(taken.because, 'asked');
});

when('waiting for an empty queue ends, rather than hanging forever', async () => {
  const { nextJob } = await import('../src/queue.ts');
  const started = Date.now();
  assert.equal(await nextJob(1), undefined, 'a worker that never returns cannot notice it was asked to stop');
  assert.ok(Date.now() - started < 4000);
});

when('only one worker can hold a scraper at a time', async () => {
  const { takeLock, releaseLock } = await import('../src/queue.ts');
  const one = job('contested');

  assert.equal(await takeLock(one), true, 'the first worker takes it');
  assert.equal(await takeLock(one), false, 'the second finds it taken rather than running the same site twice');

  await releaseLock(one);
  assert.equal(await takeLock(one), true, 'and it is free again once the run is over');
  await releaseLock(one);
});

when('two scrapers do not block each other', async () => {
  const { takeLock, releaseLock } = await import('../src/queue.ts');

  assert.equal(await takeLock(job('one')), true);
  assert.equal(await takeLock(job('two')), true, 'the lock is per scraper, not a queue of one');

  await releaseLock(job('one'));
  await releaseLock(job('two'));
});
