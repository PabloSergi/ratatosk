import { closeDb } from './db.js';
import { withDeadline } from './deadline.js';
import { makePool, runForAccount } from './do-run.js';
import { log } from './log.js';
import { closeQueue, enqueue, keepLock, nextJob, releaseLock, takeLock, usingQueue, type Job } from './queue.js';
import { loadRules, type SiteRule } from './rules.js';
import { claimDue } from './schedule.js';
import { describe, tellAboutWorker, touch, Watchdog } from './watchdog.js';

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
 *
 * Nothing here waits for ever, either. A run has a deadline and ends as broken when it passes it; a
 * tick has one too; and a watchdog restarts the whole process when any part of it has gone quiet for
 * longer than it said it would. See deadline.ts and watchdog.ts for the morning that taught us this.
 */
const TICK_MS = Number(process.env['RATATOSK_TICK_MS'] ?? 30_000);

/**
 * How many runs may be in flight at once.
 *
 * One was right while everything ran daily. It stops being right the moment one source is read every
 * ten minutes and another takes half an hour to walk: the ten-minute look waits behind the half-hour
 * walk, and "every ten minutes" quietly becomes "whenever the big one finishes". Measured on a live
 * queue — a vacancy board's turn sat behind a property crawl.
 *
 * The same scraper still never runs twice at once: that is the lock's job, and it is unchanged.
 */
const HANDS = Math.max(1, Number(process.env['RATATOSK_WORKERS'] ?? 1));

/**
 * How long one run may take before it is stopped and written down as broken.
 *
 * Generous on purpose: the longest honest walk measured is a property board at a little over twenty
 * minutes, and a deadline that cuts honest walks short is a scraper that breaks every time it has a
 * lot to read. What this is for is the run that is not walking at all — see deadline.ts.
 */
const RUN_MS = Number(process.env['RATATOSK_RUN_TIMEOUT_MS'] ?? 30 * 60_000);

/** A tick is two short statements against Postgres and a push to Redis; five minutes is not a tick. */
const TICK_TIMEOUT_MS = Number(process.env['RATATOSK_TICK_TIMEOUT_MS'] ?? 5 * 60_000);

/**
 * How long the worker may go without a tick that worked before it is considered stuck, and how long
 * past its deadline a run may hold its hands — writing its history, keeping its rows — before the same.
 */
const STALE_MS = Number(process.env['RATATOSK_STALE_MS'] ?? 15 * 60_000);
const GRACE_MS = 5 * 60_000;

/** Read by the container's health check: see docker-compose.yml. */
const HEARTBEAT = process.env['RATATOSK_HEARTBEAT'] ?? '/tmp/ratatosk-worker.alive';
const WATCH_EVERY_MS = 60_000;

let stopping = false;
const watchdog = new Watchdog();

/**
 * A browser dying must not take the worker with it.
 *
 * patchright reacts to a session that has gone away on promises of its own, and a rejection there is
 * nobody's await: Node makes it fatal, docker restarts the process, the browser is still gone, and a
 * minute later it happens again. Measured on a live queue — the worker was restarting every sixty
 * seconds over one wedged Chromium, and every other scraper's turn died with it. From outside that
 * looks exactly like a pipeline that has quietly stopped collecting, which is the worst shape a
 * failure can take: nothing in any scraper's history, because no run ever finished.
 *
 * So a stray rejection is written down and the loop carries on. The run it belonged to still ends as
 * a failure in its own history, by the catch around the job, and the next run opens a fresh browser.
 */
process.on('unhandledRejection', (reason) => {
  log('error', 'stray rejection', { why: message(reason) });
});

async function tick(): Promise<void> {
  const due = await claimDue();
  for (const one of due) {
    await enqueue({ userId: one.userId, scraper: one.scraper, because: 'schedule' });
    log('info', 'scraper due', { robot: one.scraper, user: one.userId });
  }
}

async function work(rules: SiteRule[], hand: string): Promise<void> {
  const pool = makePool();

  while (!stopping) {
    // Waiting for a job takes five seconds at most, so a hand that is quiet for a quarter of an hour
    // between jobs is a hand whose queue connection has stopped answering.
    watchdog.beat(hand, STALE_MS, 'waiting for a job');
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

    const holding = keepLock(job);
    watchdog.beat(hand, RUN_MS + GRACE_MS, `running ${job.scraper}`, job.userId);
    try {
      const run = await runForAccount(job.userId, job.scraper, { pool, rules, deadlineMs: RUN_MS });
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
      holding();
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
    watchdog.beat('tick', STALE_MS, 'scheduling');
    while (!stopping) {
      try {
        await withDeadline('tick', TICK_TIMEOUT_MS, () => tick());
        // Only a tick that worked counts as moving. One that fails every time — a database that has
        // stopped answering — is a worker that schedules nothing, however busy it looks.
        watchdog.beat('tick', STALE_MS, 'scheduling');
      } catch (error) {
        log('warn', 'tick failed', { why: message(error) });
      }
      await sleep(TICK_MS);
    }
  })();

  const watching = setInterval(() => void watch(), WATCH_EVERY_MS);
  watching.unref();

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      // Let the run in flight finish: killing a browser mid-walk leaves a half-collected run that
      // looks exactly like a broken scraper.
      log('info', 'worker stopping', { signal });
      stopping = true;
    });
  }

  log('info', 'worker hands', { hands: HANDS });
  await Promise.all([ticking, ...Array.from({ length: HANDS }, (_, index) => work(rules, `hand ${index + 1}`))]);
  clearInterval(watching);
  await Promise.all([closeQueue(), closeDb()]);
}

/**
 * Once a minute: is everything still moving? If so, the heartbeat is touched. If not, the owner is
 * told and the process ends, and docker's `restart: unless-stopped` brings up a fresh one.
 *
 * Ending is the whole remedy, and it is deliberately not gentle: the await that is stuck will not come
 * back to be cancelled, and a graceful stop would wait for it. Whatever was in flight is written off;
 * the schedule has already moved on, so the next tick puts it back in line.
 */
async function watch(): Promise<void> {
  const stuck = watchdog.stuck();
  if (stuck.length === 0) {
    await touch(HEARTBEAT).catch((error: unknown) => log('warn', 'heartbeat not written', { why: message(error) }));
    return;
  }

  log('error', 'worker stuck', { stuck });
  const owner = process.env['RATATOSK_OWNER'];
  await withDeadline('telling the owner', 30_000, () =>
    tellAboutWorker(describe(stuck), stuck, owner ? { owner } : {}),
  ).catch((error: unknown) => log('warn', 'could not tell the owner', { why: message(error) }));
  process.exit(1);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function message(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).split('\n')[0]!.slice(0, 200);
}

void main();
