import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { db, usingDatabase } from './db.js';
import type { RunStatus } from './run.js';

/**
 * What a run brought back, kept.
 *
 * Until now a run handed its rows to whoever asked and forgot them: press Run, close the tab, and the
 * work is gone. That is fine for a machine — n8n asked, n8n has them — and useless for a person, who
 * ran something yesterday and wants to look at it today.
 *
 * Two ways of keeping it, chosen by whether `RATATOSK_DB` is set, and nothing else:
 *
 * - **Postgres**, which is what the compose stack starts and what a server installation uses. Rows go
 *   in as JSONB, which means they can be asked questions later — "every posting mentioning Madrid
 *   since March" is a query rather than a wish.
 * - **A file per run**, for a clone on somebody's laptop, the command line and the tests. A scraper
 *   handing back two hundred rows should not require a database server to be running first.
 *
 * Both forget on purpose: a scraper running every half hour would otherwise fill a disk with pages
 * nobody will open, so only the last few runs of each scraper are kept.
 */
export interface Kept {
  at: string;
  status: RunStatus;
  rows: Array<Record<string, string | null>>;
  pagesVisited: number;
  reason?: string;
}

/**
 * How many runs of one scraper are kept. Enough to compare today with last week, not an archive.
 * Read when it is used rather than when the file loads, so a test can say what it means to test.
 */
const keepPerScraper = (): number => Number(process.env['RATATOSK_RESULTS_KEEP'] ?? 20);

export function resultsDirFor(userId: string, robot?: string): string {
  const root = join(process.env['RATATOSK_RESULTS'] ?? 'results', userId);
  return robot ? join(root, safe(robot)) : root;
}

/**
 * Keep what this run brought back, and forget the oldest if there are now too many.
 *
 * A run with no rows is not kept: its verdict and its reason are already in the history, and a folder
 * of empty files is a folder that hides the runs worth opening.
 */
export async function keepResult(userId: string, robot: string, kept: Kept): Promise<string | undefined> {
  if (kept.rows.length === 0) return undefined;
  if (usingDatabase()) return keepInDatabase(userId, robot, kept);

  const dir = resultsDirFor(userId, robot);
  await mkdir(dir, { recursive: true });

  const file = join(dir, `${kept.at.replace(/[:.]/g, '-')}.json`);
  const temporary = `${file}.writing`;
  await writeFile(temporary, `${JSON.stringify(kept)}\n`, 'utf8');
  await rename(temporary, file);

  const kept_ = (await readdir(dir)).filter((name) => name.endsWith('.json')).sort();
  for (const old of kept_.slice(0, Math.max(0, kept_.length - keepPerScraper()))) {
    await rm(join(dir, old), { force: true });
  }
  return file;
}

/** What is kept for one scraper, newest first — without the rows, which is what a list is for. */
export async function keptRuns(
  userId: string,
  robot: string,
): Promise<Array<{ at: string; status: RunStatus; rows: number; reason?: string }>> {
  if (usingDatabase()) {
    const pool = await db();
    const { rows } = await pool.query<{ at: Date; status: RunStatus; row_count: number; reason: string | null }>(
      'SELECT at, status, row_count, reason FROM results WHERE user_id = $1 AND scraper = $2 ORDER BY at DESC',
      [userId, robot],
    );
    return rows.map((one) => ({
      at: one.at.toISOString(),
      status: one.status,
      rows: one.row_count,
      ...(one.reason ? { reason: one.reason } : {}),
    }));
  }

  const dir = resultsDirFor(userId, robot);
  let names: string[];
  try {
    names = (await readdir(dir)).filter((name) => name.endsWith('.json'));
  } catch {
    return [];
  }

  const runs = [];
  for (const name of names) {
    try {
      const one = JSON.parse(await readFile(join(dir, name), 'utf8')) as Kept;
      runs.push({ at: one.at, status: one.status, rows: one.rows.length, ...(one.reason ? { reason: one.reason } : {}) });
    } catch {
      // A half-written file from a machine that lost power is not a run. It is also not a crash here.
    }
  }
  return runs.sort((one, other) => other.at.localeCompare(one.at));
}

/** One kept run, rows and all. */
export async function readResult(userId: string, robot: string, at: string): Promise<Kept | undefined> {
  if (usingDatabase()) {
    const pool = await db();
    const { rows } = await pool.query<{ at: Date; status: RunStatus; pages: number; reason: string | null; rows: Kept['rows'] }>(
      'SELECT at, status, pages, reason, rows FROM results WHERE user_id = $1 AND scraper = $2 AND at = $3',
      [userId, robot, at],
    );
    const one = rows[0];
    return one
      ? {
          at: one.at.toISOString(),
          status: one.status,
          rows: one.rows,
          pagesVisited: one.pages,
          ...(one.reason ? { reason: one.reason } : {}),
        }
      : undefined;
  }

  const file = join(resultsDirFor(userId, robot), `${safe(at).replace(/[:.]/g, '-')}.json`);
  try {
    return JSON.parse(await readFile(file, 'utf8')) as Kept;
  } catch {
    return undefined;
  }
}

/**
 * Everything every scraper of one account brought back since a moment.
 *
 * The one-scraper calls answer "what did this one do" — which is what a person on the page wants and
 * exactly the wrong shape for a machine downstream, which does not care which of seventeen scrapers a
 * posting came from and would otherwise ask seventeen times, then once more per run, to find out that
 * on most days most of them brought back nothing. One question, one answer, and the run each row came
 * out of travels with it so the far side can tell today's harvest from yesterday's.
 *
 * `since` is exclusive, so handing back the `until` of the last harvest asks for exactly what is new.
 */
export async function harvestSince(
  userId: string,
  since: string,
): Promise<Array<{ scraper: string; at: string; rows: Kept['rows'] }>> {
  if (usingDatabase()) {
    const pool = await db();
    const { rows } = await pool.query<{ scraper: string; at: Date; rows: Kept['rows'] }>(
      'SELECT scraper, at, rows FROM results WHERE user_id = $1 AND at > $2 ORDER BY at',
      [userId, since],
    );
    return rows.map((one) => ({ scraper: one.scraper, at: one.at.toISOString(), rows: one.rows }));
  }

  // The file store keeps a directory per scraper, named the way a file may be named, so a scraper
  // called "jobs (EU)" answers here as "jobs--EU-". That is the store for a laptop and the tests; a
  // server installation has the database, where the name is the name.
  let scrapers: string[];
  try {
    scrapers = await readdir(resultsDirFor(userId));
  } catch {
    return [];
  }

  const harvest = [];
  for (const scraper of scrapers) {
    for (const run of await keptRuns(userId, scraper)) {
      if (run.at <= since) continue;
      const kept = await readResult(userId, scraper, run.at);
      if (kept) harvest.push({ scraper, at: kept.at, rows: kept.rows });
    }
  }
  return harvest.sort((one, other) => one.at.localeCompare(other.at));
}

/** When a scraper goes, so does what it brought back. */
export async function forgetResults(userId: string, robot: string): Promise<void> {
  if (usingDatabase()) {
    const pool = await db();
    await pool.query('DELETE FROM results WHERE user_id = $1 AND scraper = $2', [userId, robot]);
    return;
  }
  await rm(resultsDirFor(userId, robot), { recursive: true, force: true });
}

/** A rename moves what the scraper brought back along with it, wherever that is being kept. */
export async function moveResults(userId: string, from: string, to: string): Promise<void> {
  if (usingDatabase()) {
    const pool = await db();
    await pool.query('UPDATE results SET scraper = $3 WHERE user_id = $1 AND scraper = $2', [userId, from, to]);
    return;
  }
  await rename(resultsDirFor(userId, from), resultsDirFor(userId, to)).catch(() => undefined);
}

async function keepInDatabase(userId: string, robot: string, kept: Kept): Promise<string> {
  const pool = await db();
  await pool.query(
    `INSERT INTO results (user_id, scraper, at, status, pages, reason, rows, row_count)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8)
     ON CONFLICT (user_id, scraper, at) DO UPDATE
       SET status = EXCLUDED.status, pages = EXCLUDED.pages, reason = EXCLUDED.reason,
           rows = EXCLUDED.rows, row_count = EXCLUDED.row_count`,
    [userId, robot, kept.at, kept.status, kept.pagesVisited, kept.reason ?? null, JSON.stringify(kept.rows), kept.rows.length],
  );

  // The same forgetting as on disk, said in SQL: keep the newest few, drop the rest.
  await pool.query(
    `DELETE FROM results WHERE user_id = $1 AND scraper = $2 AND at NOT IN (
       SELECT at FROM results WHERE user_id = $1 AND scraper = $2 ORDER BY at DESC LIMIT $3
     )`,
    [userId, robot, keepPerScraper()],
  );
  return `${robot}@${kept.at}`;
}

/** A name from a person becomes a path here, so it may not contain a way out of the directory. */
function safe(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, '-');
}
