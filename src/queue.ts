import { createClient, type RedisClientType } from 'redis';

/**
 * The line of work waiting to be done, and the one rule that keeps it honest.
 *
 * The schedule decides WHAT is due, in the database, in one atomic statement. This decides WHO does it
 * and WHEN they let go. Two things live here and nothing else:
 *
 * - a list a worker blocks on, so a due scraper is picked up in the same second rather than at the top
 *   of the next minute;
 * - a lock per scraper, taken for the length of a run, so the same scraper is never walking a site in
 *   two browsers at once. That is not a tidiness concern: two browsers on one site through one proxy
 *   is how an address gets blocked, and two runs writing one memory is how a posting gets handed over
 *   twice and then never again.
 *
 * The lock expires on its own. A worker killed mid-run must not leave a scraper locked out forever, so
 * the expiry is the run's own budget rather than "until somebody notices".
 */
export interface Job {
  userId: string;
  scraper: string;
  /** Why it is running: a schedule, or somebody pressing a button. Only ever said in logs. */
  because: 'schedule' | 'asked';
}

const QUEUE = 'ratatosk:due';
const LOCK = (job: Job): string => `ratatosk:running:${job.userId}:${job.scraper}`;

/**
 * How long a lock lives without being renewed.
 *
 * It is not a limit on a run: a deep walk takes half an hour and a lock that expires under it says
 * "nobody is running this" while somebody is — which is how two browsers end up on one profile. The
 * holder renews it while it works (see keepLock); this is only how long the right survives a holder
 * that has died.
 */
const LOCK_SECONDS = Number(process.env['RATATOSK_LOCK_SECONDS'] ?? 120);

export function redisUrl(): string | undefined {
  return process.env['RATATOSK_REDIS'] || undefined;
}

export function usingQueue(): boolean {
  return Boolean(redisUrl());
}

let client: RedisClientType | undefined;
let listener: RedisClientType | undefined;

async function connect(url: string): Promise<RedisClientType> {
  const made = createClient({ url }) as RedisClientType;
  // Without this an unreachable Redis takes the process down with an unhandled event, which is a
  // scraping platform dying because a queue blinked.
  made.on('error', () => undefined);
  await made.connect();
  return made;
}

export async function queue(): Promise<RedisClientType> {
  const url = redisUrl();
  if (!url) throw new Error('no queue is configured — set RATATOSK_REDIS');
  client ??= await connect(url);
  return client;
}

/**
 * A second connection, used for nothing but waiting.
 *
 * A blocking read holds its connection for as long as it waits, and every other command sent down the
 * same one queues up behind it. The worker does exactly that to itself — it waits for a job on one
 * side and puts jobs in the queue on the other — and the two wedged each other: a job sat in the
 * queue while the worker sat waiting for a job, both of them patient forever. Measured on a live
 * server; a restart cleared it, which is the shape of a deadlock, not of an outage.
 */
async function waitingLine(): Promise<RedisClientType> {
  const url = redisUrl();
  if (!url) throw new Error('no queue is configured — set RATATOSK_REDIS');
  listener ??= await connect(url);
  return listener;
}

export async function closeQueue(): Promise<void> {
  await client?.quit().catch(() => undefined);
  await listener?.quit().catch(() => undefined);
  client = undefined;
  listener = undefined;
}

/** Put a scraper in line. */
export async function enqueue(job: Job): Promise<void> {
  const redis = await queue();
  await redis.lPush(QUEUE, JSON.stringify(job));
}

/**
 * Wait for the next job, up to a few seconds.
 *
 * Blocking rather than polling, with a timeout rather than forever: a worker that never returns from
 * a read cannot notice that it has been asked to stop.
 */
export async function nextJob(seconds = 5): Promise<Job | undefined> {
  const redis = await waitingLine();
  const taken = await redis.brPop(QUEUE, seconds);
  if (!taken) return undefined;
  try {
    return JSON.parse(taken.element) as Job;
  } catch {
    return undefined; // somebody put something else in our queue; not a reason to stop working
  }
}

/** Take the right to run this scraper, or find that somebody else already has it. */
export async function takeLock(job: Job): Promise<boolean> {
  const redis = await queue();
  const got = await redis.set(LOCK(job), String(process.pid), { condition: 'NX', expiration: { type: 'EX', value: LOCK_SECONDS } });
  return got === 'OK';
}

/**
 * Hold on to the lock for as long as the work takes. Returns a function that stops the renewing.
 */
export function keepLock(job: Job, everyMs = (LOCK_SECONDS * 1000) / 3): () => void {
  const beat = setInterval(() => {
    void queue()
      .then((redis) => redis.expire(LOCK(job), LOCK_SECONDS))
      .catch(() => undefined);
  }, everyMs);
  beat.unref?.();
  return () => clearInterval(beat);
}

export async function releaseLock(job: Job): Promise<void> {
  const redis = await queue();
  await redis.del(LOCK(job)).catch(() => undefined);
}

/** How many are waiting — for the interface, so "scheduled" and "actually running" are different words. */
export async function waiting(): Promise<number> {
  const redis = await queue();
  return redis.lLen(QUEUE);
}
