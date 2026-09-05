import { db } from './db.js';

/**
 * When a scraper should run, and whether it is due.
 *
 * The platform had no scheduler on purpose: cron exists, n8n exists, and a scraping tool that grows a
 * worse copy of both is a tool with two jobs and neither done well. That argument holds right up until
 * somebody has fifteen scrapers, at which point "a robot is one command" means fifteen crontab lines
 * on a machine they have to ssh into, each carrying a key, and no way to see from the product whether
 * any of it is happening.
 *
 * So: an interval per scraper, kept beside everything else, and a worker that runs what is due. Not a
 * workflow engine — no branches, no retries with backoff, no fan-out. Those belong to whatever you
 * already use, and this stays the thing that knows how to read a page.
 *
 * Times are decided in the database rather than in a process, because two workers and a restart must
 * not turn one run into three.
 */
export interface Schedule {
  scraper: string;
  /** How often, in minutes. Absent means the scraper is not scheduled at all. */
  everyMinutes: number;
  nextAt: string;
  lastAt?: string;
  paused: boolean;
}

/** The shortest interval on offer. Below this a browser run barely finishes before the next is due. */
export const SHORTEST_MINUTES = 5;

export async function setSchedule(userId: string, scraper: string, everyMinutes: number | undefined): Promise<Schedule | undefined> {
  const pool = await db();

  if (!everyMinutes) {
    await pool.query('DELETE FROM schedules WHERE user_id = $1 AND scraper = $2', [userId, scraper]);
    return undefined;
  }

  const every = Math.max(SHORTEST_MINUTES, Math.round(everyMinutes));
  const { rows } = await pool.query<Row>(
    `INSERT INTO schedules (user_id, scraper, every_minutes, next_at, paused)
     VALUES ($1, $2, $3, now() + make_interval(mins => $3), false)
     ON CONFLICT (user_id, scraper) DO UPDATE
       SET every_minutes = EXCLUDED.every_minutes,
           -- A changed interval takes effect from now, not from whenever the old one would have fired.
           next_at = now() + make_interval(mins => EXCLUDED.every_minutes),
           paused = false
     RETURNING scraper, every_minutes, next_at, last_at, paused`,
    [userId, scraper, every],
  );
  return asSchedule(rows[0]!);
}

export async function schedulesFor(userId: string): Promise<Schedule[]> {
  const pool = await db();
  const { rows } = await pool.query<Row>(
    'SELECT scraper, every_minutes, next_at, last_at, paused FROM schedules WHERE user_id = $1 ORDER BY scraper',
    [userId],
  );
  return rows.map(asSchedule);
}

/**
 * Take the scrapers that are due, and move their next time forward in the same statement.
 *
 * This is the whole of the concurrency story and it is deliberately one query: the row is claimed and
 * rescheduled atomically, so a second worker asking at the same moment gets nothing rather than the
 * same job. `FOR UPDATE SKIP LOCKED` is what makes that true under two workers; the next time is set
 * from now rather than from the old next time, so a worker that was down for an hour does not come
 * back and run twelve times to catch up.
 */
export async function claimDue(limit = 5): Promise<Array<{ userId: string; scraper: string }>> {
  const pool = await db();
  const { rows } = await pool.query<{ user_id: string; scraper: string }>(
    `UPDATE schedules SET next_at = now() + make_interval(mins => every_minutes), last_at = now()
     WHERE (user_id, scraper) IN (
       SELECT user_id, scraper FROM schedules
       WHERE paused = false AND next_at <= now()
       ORDER BY next_at
       LIMIT $1
       FOR UPDATE SKIP LOCKED
     )
     RETURNING user_id, scraper`,
    [limit],
  );
  return rows.map((row) => ({ userId: row.user_id, scraper: row.scraper }));
}

/** A scraper that no longer exists must not keep a place in the queue. */
export async function forgetSchedule(userId: string, scraper: string): Promise<void> {
  const pool = await db();
  await pool.query('DELETE FROM schedules WHERE user_id = $1 AND scraper = $2', [userId, scraper]);
}

export async function moveSchedule(userId: string, from: string, to: string): Promise<void> {
  const pool = await db();
  await pool.query('UPDATE schedules SET scraper = $3 WHERE user_id = $1 AND scraper = $2', [userId, from, to]);
}

interface Row {
  scraper: string;
  every_minutes: number;
  next_at: Date;
  last_at: Date | null;
  paused: boolean;
}

function asSchedule(row: Row): Schedule {
  return {
    scraper: row.scraper,
    everyMinutes: row.every_minutes,
    nextAt: row.next_at.toISOString(),
    ...(row.last_at ? { lastAt: row.last_at.toISOString() } : {}),
    paused: row.paused,
  };
}
