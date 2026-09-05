import { closeDb } from './db.js';
import { makePool, runForAccount } from './do-run.js';
import { log } from './log.js';
import { closeQueue, enqueue, nextJob, releaseLock, takeLock, usingQueue, type Job } from './queue.js';
import { loadRules, type SiteRule } from './rules.js';
import { claimDue } from './schedule.js';

/**
 * The process that runs what is due.
 *
 * It is a separate container from the web service on purpose. A run holds a browser open for a minute
 * at a gigabyte a time; sharing a process with the thing serving the screen means one heavy scrape
 * makes the interface stop answering, and the person watching cannot tell a busy scraper from a dead
 * service.
 *
 * Two loops, both plain:
 *
 * - the **tick** asks the database what is due and puts it in line. It is safe to run in several
 *   workers at once, because "what is due" is claimed and rescheduled in one atomic statement.
 * - the **work** takes jobs off the line and runs them, one at a time, holding a lock for the length
 *   of the run so the same scraper is never walking a site in two browsers at once.
 *
 * Nothing here retries. A run that failed is in the history with its reason, the owner has been told
 * if they asked to be, and the next tick will come round soon enough — a queue that retries a broken
 * selector four times just breaks it four times.
 */
const TICK_MS = Number(process.env['RATATOSK_TICK_MS'] ?? 30_000);

let stopping = false;

async function tick(): Promise<void> {
  const due = await claimDue();
  for (const one of due) {
    await enqueue({ userId: one.userId, scraper: one.scraper, because: 'schedule' });
    log('info', 'scraper due', { robot: one.scraper, user: one.userId });
  }
}

async function work(rules: SiteRule[]): Promise<void> {
  const pool = makePool();

  while (!stopping) {
    let job: Job | undefined;
    try {
      job = await nextJob();
    } catch (error) {
      // The queue is unreachable. Say so once a cycle rather than spinning on it.
      log('warn', 'queue unreachable', { why: message(error) });
      await sleep(TICK_MS);
      continue;
    }
    if (!job) continue;

    if (!(await takeLock(job).catch(() => false))) {
      log('info', 'already running', { robot: job.scraper, user: job.userId });
      continue;
    }

    try {
      const run = await runForAccount(job.userId, job.scraper, { pool, rules });
      log(run.status === 'ok' ? 'info' : 'warn', 'worker ran', {
        robot: job.scraper,
        user: job.userId,
        status: run.status,
        rows: run.rows.length,
        because: job.because,
      });
    } catch (error) {
      // A scraper that has been deleted, a Telegram session that is gone, a browser that would not
      // start: all of them are one scraper's problem and none of them is a reason to stop working.
      log('error', 'worker failed', { robot: job.scraper, user: job.userId, why: message(error) });
    } finally {
      await releaseLock(job);
    }
  }

  await pool.closeAll?.();
}

async function main(): Promise<void> {
  if (!usingQueue()) {
    console.error('no queue configured — set RATATOSK_REDIS (the compose stack does this for you)');
    return process.exit(2);
  }

  const rules = await loadRules('rules');
  log('info', 'worker started', { tickMs: TICK_MS });

  const ticking = (async () => {
    while (!stopping) {
      try {
        await tick();
      } catch (error) {
        log('warn', 'tick failed', { why: message(error) });
      }
      await sleep(TICK_MS);
    }
  })();

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      // Let the run in flight finish: killing a browser mid-walk leaves a half-collected run that
      // looks exactly like a broken scraper.
      log('info', 'worker stopping', { signal });
      stopping = true;
    });
  }

  await Promise.all([ticking, work(rules)]);
  await Promise.all([closeQueue(), closeDb()]);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function message(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).split('\n')[0]!.slice(0, 200);
}

void main();
