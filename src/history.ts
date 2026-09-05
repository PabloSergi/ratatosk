import { appendFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

/**
 * What each robot did, kept.
 *
 * The product's whole claim is that a robot says when it breaks — and a claim like that is worth
 * nothing without a memory. One run returning eleven rows means nothing; eleven where yesterday there
 * were four hundred means the site changed under it. So every run leaves a line, and the interface can
 * show a robot's life rather than its last second.
 *
 * A file of JSON lines per account: appending is one syscall, reading is a tail, and there is no
 * database to run, back up or migrate for what is essentially a logbook.
 */
export interface Run {
  at: string;
  robot: string;
  kind: 'run' | 'build' | 'repair';
  status: 'ok' | 'empty' | 'broken';
  rows: number;
  pages?: number;
  ms: number;
  why?: string;
  proxy?: string;
  /** A door meant for a person, not a broken selector — the two need different answers. */
  door?: boolean;
  /** Nothing new, rather than nothing at all: the scraper worked and had already handed it over. */
  quiet?: boolean;
}

/** How many lines a file keeps. Old enough to show a trend, small enough to read in one gulp. */
const KEEP = Number(process.env['RATATOSK_HISTORY_KEEP'] ?? 2000);

export function historyFileFor(userId: string): string {
  return join(process.env['RATATOSK_HISTORY'] ?? 'history', `${userId}.jsonl`);
}

/**
 * Carry a scraper's past over to its new name.
 *
 * History is a log of lines, each naming the scraper it belongs to, so a rename that ignores it leaves
 * the story behind under a name nothing points at any more. The file is rewritten once, in place.
 */
export async function renameInHistory(file: string, from: string, to: string): Promise<number> {
  let lines: string[];
  try {
    lines = (await readFile(file, 'utf8')).split('\n').filter(Boolean);
  } catch {
    return 0;
  }

  let moved = 0;
  const next = lines.map((line) => {
    const run = parse(line);
    if (!run || run.robot !== from) return line;
    moved++;
    return JSON.stringify({ ...run, robot: to });
  });

  if (moved > 0) {
    const temporary = `${file}.writing`;
    await writeFile(temporary, `${next.join('\n')}\n`, 'utf8');
    await rename(temporary, file);
  }
  return moved;
}

export async function remember(file: string, run: Run): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  await appendFile(file, `${JSON.stringify(run)}\n`, 'utf8');
  await trim(file);
}

/**
 * The most recent runs, newest first. A robot name narrows it to one robot's own story.
 */
export async function recent(file: string, options: { robot?: string; limit?: number } = {}): Promise<Run[]> {
  const limit = options.limit ?? 100;
  let lines: string[];
  try {
    lines = (await readFile(file, 'utf8')).split('\n').filter(Boolean);
  } catch {
    return [];
  }

  const runs: Run[] = [];
  for (let index = lines.length - 1; index >= 0 && runs.length < limit; index--) {
    const run = parse(lines[index]!);
    if (!run) continue;
    if (options.robot && run.robot !== options.robot) continue;
    runs.push(run);
  }
  return runs;
}

/**
 * A one-line verdict per robot: how it is now, and whether that is new.
 *
 * This is what an operator actually asks — not "what happened at 04:12" but "which of my fourteen
 * robots is in trouble, and since when".
 */
export interface Standing {
  robot: string;
  /**
   * How it is. A quiet run — one that found rows and had handed them all over before — counts as ok:
   * it is what a scraper with a memory does most days, and calling it empty makes a person start
   * every morning by dismissing fifteen false alarms.
   */
  status: Run['status'];
  at: string;
  rows: number;
  /** How many runs in a row have ended this way. A single bad run is noise; five are a verdict. */
  inARow: number;
  why?: string;
  door?: boolean;
  /** It is ok because nothing new came, not because rows came. Worth saying on the card. */
  quiet?: boolean;
}

export async function standing(file: string): Promise<Standing[]> {
  const runs = await recent(file, { limit: KEEP });
  const byRobot = new Map<string, { now: Standing; streak: boolean }>();

  // Newest first: the first line for a robot is how it is now, and the ones after it extend the streak
  // until one of them disagrees. After that the older runs are history, not the present state.
  for (const run of runs) {
    if (run.kind === 'build') continue; // a build is not how the scraper is doing

    // A quiet run is a working scraper with nothing new to say. Judged as itself it would read as
    // empty, and a streak of them as broken — which is what happens to every scraper that remembers,
    // every day, until nobody reads the warnings any more.
    const status = run.quiet ? 'ok' : run.status;
    const seen = byRobot.get(run.robot);
    if (!seen) {
      byRobot.set(run.robot, {
        now: {
          robot: run.robot,
          status,
          at: run.at,
          rows: run.rows,
          inARow: 1,
          ...(run.why ? { why: run.why } : {}),
          ...(run.door ? { door: true } : {}),
          ...(run.quiet ? { quiet: true } : {}),
        },
        streak: true,
      });
      continue;
    }
    if (!seen.streak) continue;
    if (status === seen.now.status) seen.now.inARow++;
    else seen.streak = false;
  }

  return [...byRobot.values()].map((entry) => entry.now).sort((left, right) => right.at.localeCompare(left.at));
}

function parse(line: string): Run | undefined {
  try {
    return JSON.parse(line) as Run;
  } catch {
    return undefined;
  }
}

/**
 * Keep the file from growing forever. Rewriting the tail is cheap at this size and needs no rotation
 * scheme, no cron and nothing to configure.
 */
async function trim(file: string): Promise<void> {
  const lines = (await readFile(file, 'utf8').catch(() => '')).split('\n').filter(Boolean);
  if (lines.length <= KEEP * 1.5) return;
  const temporary = `${file}.trimming`;
  await writeFile(temporary, `${lines.slice(-KEEP).join('\n')}\n`, 'utf8');
  await rename(temporary, file);
}
