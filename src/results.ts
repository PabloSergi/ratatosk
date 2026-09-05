import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { RunStatus } from './run.js';

/**
 * What a run brought back, kept.
 *
 * Until now a run handed its rows to whoever asked and forgot them: press Run, close the tab, and the
 * work is gone. That is fine for a machine — n8n asked, n8n has them — and useless for a person, who
 * ran something yesterday and wants to look at it today.
 *
 * Other platforms answer this with a database, an object store and a queue. This one keeps a file per
 * run, because that is what the data is: a few hundred rows of text that nobody queries and everybody
 * reads whole. Nothing to install, nothing to migrate, and a backup is `tar`. The cost is that you
 * cannot ask it "every posting mentioning Madrid since March" — and if you want that, the rows belong
 * in whatever you already keep such things in, which is exactly what the API is for.
 *
 * It forgets on purpose: a scraper running every half hour would otherwise fill a disk with pages
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
  const file = join(resultsDirFor(userId, robot), `${safe(at).replace(/[:.]/g, '-')}.json`);
  try {
    return JSON.parse(await readFile(file, 'utf8')) as Kept;
  } catch {
    return undefined;
  }
}

/** When a scraper goes, so does what it brought back. */
export async function forgetResults(userId: string, robot: string): Promise<void> {
  await rm(resultsDirFor(userId, robot), { recursive: true, force: true });
}

/** A name from a person becomes a path here, so it may not contain a way out of the directory. */
function safe(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, '-');
}
