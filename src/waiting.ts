import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

/**
 * Sources that could not be built because the way in is a door meant for a person.
 *
 * A build that walks into an anti-bot check is not a failure to be logged and forgotten: the site is
 * readable, the robot is buildable, and the only missing step is somebody passing the check once in
 * the profile the scraper will use. Until now that fact lived in the output of whoever ran the build
 * — which is to say nowhere — and the sources were lost. Seven of them at once, in one batch, and the
 * only record was a sentence in a chat window telling the owner to press a button on a card that was
 * never saved.
 *
 * So the attempt is written down where the interface can show it, next to the one button that fixes
 * it. A parked source is not a robot: it has no selectors and has never returned a row, and listing
 * it among the robots would be a lie. It is a short list of its own.
 */
export interface Waiting {
  name: string;
  url: string;
  /** What was asked for, so the build can be repeated without typing it again. */
  want?: string;
  /** Which door it was: the page title, or whatever the attempt could say about it. */
  why: string;
  /** Which way out the attempt went, because the pass belongs to that profile and no other. */
  proxy?: string;
  at: string;
}

export function waitingFileFor(userId: string): string {
  return join('robots', 'u', userId, '_waiting.json');
}

export async function listWaiting(file: string): Promise<Waiting[]> {
  try {
    return JSON.parse(await readFile(file, 'utf8')) as Waiting[];
  } catch {
    return [];
  }
}

async function write(file: string, waiting: Waiting[]): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(waiting, null, 2)}\n`, 'utf8');
}

/** Noted once per name: a nightly batch that keeps hitting the same door must not grow a list. */
export async function park(file: string, one: Omit<Waiting, 'at'>): Promise<Waiting[]> {
  const waiting = (await listWaiting(file)).filter((entry) => entry.name !== one.name);
  waiting.push({ ...one, at: new Date().toISOString() });
  await write(file, waiting);
  return waiting;
}

export async function unpark(file: string, name: string): Promise<Waiting[]> {
  const left = (await listWaiting(file)).filter((entry) => entry.name !== name);
  await write(file, left);
  return left;
}
