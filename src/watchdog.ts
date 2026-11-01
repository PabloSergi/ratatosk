import { mkdir, readdir, readFile, utimes, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { alertsFileFor, readAlerts, tell } from './alerts.js';
import { log } from './log.js';

/**
 * Knowing that the worker itself has stopped, as opposed to one of its scrapers.
 *
 * A scraper that breaks says so in its history. A worker that stops says nothing at all: a run that
 * never ends writes no history, a tick that never comes back schedules nothing, and the container stays
 * "Up" through all of it. Measured on a live queue — four hours of a frozen worker, found by a person
 * wondering why a board had gone quiet, and fixed by a restart in a second.
 *
 * So every part of the worker that is meant to keep moving — the tick, each pair of hands — says when
 * it last moved and how long it may stay still. Something that has been still for longer than it said
 * it would is stuck, and a stuck worker is restarted rather than reasoned with: whatever it is awaiting
 * is not going to answer, and a fresh process gets fresh connections to everything.
 */
export interface Stuck {
  part: string;
  doing: string;
  quietMs: number;
  user?: string;
}

export class Watchdog {
  private readonly parts = new Map<string, { since: number; limitMs: number; doing: string; user?: string }>();

  constructor(private readonly now: () => number = Date.now) {}

  /** This part moved just now, and will move again within `limitMs` unless it is stuck. */
  beat(part: string, limitMs: number, doing: string, user?: string): void {
    this.parts.set(part, { since: this.now(), limitMs, doing, ...(user ? { user } : {}) });
  }

  stuck(): Stuck[] {
    const now = this.now();
    return [...this.parts.entries()]
      .filter(([, part]) => now - part.since > part.limitMs)
      .map(([name, part]) => ({
        part: name,
        doing: part.doing,
        quietMs: now - part.since,
        ...(part.user ? { user: part.user } : {}),
      }));
  }
}

/**
 * The heartbeat a container health check can read.
 *
 * Touched by the watchdog while everything is moving, so a file that has gone stale means the watchdog
 * itself has stopped — a process too wedged to notice it is wedged. That is the one case the process
 * cannot restart itself out of, and the health check is there so it is at least visible.
 */
export async function touch(file: string, now = new Date()): Promise<void> {
  try {
    await utimes(file, now, now);
  } catch {
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, `${now.toISOString()}\n`, 'utf8');
  }
}

/**
 * Who hears about the worker. The worker belongs to nobody in particular — accounts own scrapers, not
 * processes — so: whoever `RATATOSK_OWNER` names, plus the owners of whatever was stuck. Without an
 * owner named, everyone who has set up alerts, which on an installation of one person is that person.
 */
export async function whomToTell(alertsDir: string, owner: string | undefined, stuck: Stuck[]): Promise<string[]> {
  const theirs = stuck.flatMap((part) => (part.user ? [part.user] : []));
  if (owner) return [...new Set([owner, ...theirs])];
  const files = await readdir(alertsDir).catch(() => [] as string[]);
  return [...new Set([...files.filter((file) => file.endsWith('.json')).map((file) => file.replace(/\.json$/, '')), ...theirs])];
}

/**
 * Tell them, at most once an hour.
 *
 * A worker that is restarted and gets stuck again — a database that is down, say — would otherwise
 * say the same thing every quarter of an hour all night. The time of the last message is kept on disk,
 * because the process that sent it is exactly the one that is about to be thrown away.
 */
export async function tellAboutWorker(
  text: string,
  stuck: Stuck[],
  options: {
    owner?: string;
    alertsDir?: string;
    toldFile?: string;
    everyMs?: number;
    now?: () => number;
    fetcher?: typeof fetch;
  } = {},
): Promise<string[]> {
  const now = options.now ?? Date.now;
  const toldFile = options.toldFile ?? join('secrets', 'watchdog.json');
  const everyMs = options.everyMs ?? 60 * 60 * 1000;

  const last = await readFile(toldFile, 'utf8')
    .then((body) => Date.parse((JSON.parse(body) as { at?: string }).at ?? ''))
    .catch(() => Number.NaN);
  if (now() - last < everyMs) return [];

  const told: string[] = [];
  for (const user of await whomToTell(options.alertsDir ?? join('secrets', 'alerts'), options.owner, stuck)) {
    const alerts = await readAlerts(options.alertsDir ? join(options.alertsDir, `${user}.json`) : alertsFileFor(user));
    if (!alerts.botToken || !alerts.chatId) continue;
    try {
      await tell(alerts, text, options.fetcher);
      told.push(user);
    } catch (error) {
      log('warn', 'could not tell the owner', { user, why: error instanceof Error ? error.message.slice(0, 200) : String(error) });
    }
  }

  if (told.length) {
    await mkdir(dirname(toldFile), { recursive: true });
    await writeFile(toldFile, `${JSON.stringify({ at: new Date(now()).toISOString(), text })}\n`, 'utf8');
  }
  return told;
}

/** What the message says: which part, doing what, for how long. */
export function describe(stuck: Stuck[]): string {
  const lines = stuck.map((part) => `• ${part.part}: ${part.doing}, silent for ${Math.round(part.quietMs / 60_000)} min`);
  return `🛑 The ratatosk worker is stuck and is restarting itself.\n${lines.join('\n')}`;
}
