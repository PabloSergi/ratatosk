import { access, copyFile, mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Scenario } from './scenario.js';
import { parseScenario } from './scenario.js';
import { InputError } from './errors.js';
import { isTelegramRobot, parseTelegramRobot, type TelegramRobot } from './telegram.js';

/** A robot is either a page walk or a Telegram read. Both are one JSON file on disk. */
export type Robot = Scenario | TelegramRobot;

/** One place decides which kind of robot a file holds, so nowhere else has to guess. */
export function parseRobot(data: unknown): Robot {
  return isTelegramRobot(data) ? parseTelegramRobot(data) : parseScenario(data);
}

/**
 * A robot is a saved scenario and nothing more: one JSON file, readable and editable by hand.
 * No database, no opaque format, no "export" feature needed to get your own work back out.
 */
export const ROBOTS_DIR = 'robots';

/**
 * Save a robot that is meant to be new.
 *
 * Names are chosen by people and by channels, and two different sources can easily want the same word:
 * a job board at ofmjobs.com and a Telegram group called @OFMJobs are not the same thing and must not
 * quietly become one. Writing over an existing scraper here would destroy minutes of a model's work and
 * a memory of everything it had already handed over, so it is refused and the name is the caller's
 * problem to solve.
 */
export async function createRobot(scenario: Robot, dir = ROBOTS_DIR): Promise<string> {
  const path = join(dir, `${safeName(scenario.name)}.json`);
  try {
    await access(path);
  } catch {
    return saveRobot(scenario, dir);
  }
  throw new NameTaken(`a scraper called "${scenario.name}" already exists — give this one another name`);
}

export class NameTaken extends InputError {}

export async function saveRobot(scenario: Robot, dir = ROBOTS_DIR): Promise<string> {
  await mkdir(dir, { recursive: true });
  const path = join(dir, `${safeName(scenario.name)}.json`);
  await writeFile(path, `${JSON.stringify(scenario, null, 2)}\n`, 'utf8');
  return path;
}

/**
 * Keep the version that was there before overwriting. A repair that turns out wrong must be one
 * `mv` away from being undone, without git and without asking anyone.
 */
export async function archivePrevious(name: string, dir = ROBOTS_DIR): Promise<string | undefined> {
  const path = join(dir, `${safeName(name)}.json`);
  const backup = join(dir, `${safeName(name)}.previous.json`);
  try {
    await copyFile(path, backup);
    return backup;
  } catch {
    return undefined;
  }
}

/**
 * Delete a robot — into a corner of the same directory, not into nothing.
 *
 * A robot is minutes of a model's work and somebody's afternoon of checking; a misplaced click should
 * not be the end of it. The file moves out of the way and stops being listed, and whoever wants it
 * back can lift it out of the directory by hand.
 */
export async function deleteRobot(name: string, dir = ROBOTS_DIR): Promise<string> {
  const path = join(dir, `${safeName(name)}.json`);
  const removed = join(dir, `${safeName(name)}.deleted-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  await rename(path, removed);
  return removed;
}

/**
 * Rename a scraper, with everything that its name is the key to.
 *
 * A name is not a label here: the file is named by it, so is the memory of what the scraper has already
 * handed over, and every line of its history says it. Renaming only the file leaves a scraper that has
 * forgotten everything it ever returned and has no past — which looks exactly like a new scraper, and
 * is the reason renaming was missing rather than half-done.
 */
export async function renameRobot(from: string, to: string, dir = ROBOTS_DIR): Promise<Robot> {
  const wanted = to.trim();
  if (!wanted) throw new InputError('a scraper needs a name');
  if (safeName(wanted) === safeName(from)) throw new InputError(`it is already called "${from}"`);

  const robot = await loadRobot(from, dir);
  const renamed = { ...robot, name: wanted } as Robot;

  // Refuses if the new name is taken, and does so before anything has moved.
  await createRobot(renamed, dir);
  await rm(join(dir, `${safeName(from)}.json`), { force: true });
  return renamed;
}

export async function loadRobot(name: string, dir = ROBOTS_DIR): Promise<Robot> {
  const path = join(dir, `${safeName(name)}.json`);
  try {
    return parseRobot(JSON.parse(await readFile(path, 'utf8')));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      const known = (await listRobots(dir)).map((robot) => robot.name);
      throw new InputError(
        known.length
          ? `no robot named "${name}". Known robots: ${known.join(', ')}`
          : `no robot named "${name}", and none are saved yet — build one with open → look → try → save`,
      );
    }
    throw error;
  }
}

export interface RobotSummary {
  name: string;
  /** What it reads: a kind, not a guess made by looking at the pagination text. */
  kind: 'web' | 'telegram';
  url: string;
  fields: string[];
  /** Columns that come from inside a row, not from the list. They cost a page load each. */
  deeper?: string[];
  /** How many patterns its rule carries, if it sifts at all. */
  sift?: number;
  pagination: string;
  /** Which proxy this robot goes out through, if any. */
  proxy?: string;
}

export async function listRobots(dir = ROBOTS_DIR): Promise<RobotSummary[]> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }

  const robots = [];
  // A deleted robot keeps its file so it can be lifted back out, but it is not one of the robots.
  const listable = (entry: string): boolean =>
    entry.endsWith('.json') && !entry.endsWith('.previous.json') && !/\.deleted-[^.]+\.json$/.test(entry);

  for (const file of names.filter(listable)) {
    try {
      const robot = parseRobot(JSON.parse(await readFile(join(dir, file), 'utf8')));
      robots.push(
        isTelegramRobot(robot)
          ? {
              name: robot.name,
              kind: 'telegram' as const,
              url: robot.channels.map((channel) => `@${channel.replace(/^@/, '')}`).join(', '),
              fields: ['channel', 'date', 'text', 'link'],
              ...(robot.sift ? { sift: robot.sift.keep.length + (robot.sift.drop?.length ?? 0) } : {}),
              pagination: `telegram, ${robot.limit} messages`,
            }
          : {
              name: robot.name,
              kind: 'web' as const,
              url: robot.url,
              fields: Object.keys(robot.list.fields),
              ...(robot.detail ? { deeper: Object.keys(robot.detail.fields) } : {}),
              ...(robot.sift ? { sift: robot.sift.keep.length + (robot.sift.drop?.length ?? 0) } : {}),
              pagination: robot.pagination.type,
              ...(robot.proxy ? { proxy: robot.proxy } : {}),
            },
      );
    } catch {
      // A file that is not a valid scenario is not a robot. Listing must not die because of it.
    }
  }
  return robots;
}

/** Robot names become file names, so they may not wander out of the directory. */
function safeName(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, '-');
}
