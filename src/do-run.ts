import { join } from 'node:path';
import { alertsFileFor, readAlerts, tell, whatToSay, writeAlerts } from './alerts.js';
import { BrowserPool } from './browsers.js';
import { openBrowser } from './drivers/patchright.js';
import { historyFileFor, remember, standing } from './history.js';
import { log } from './log.js';
import { memoryFileFor, readMemory, writeMemory, type Seen } from './memory.js';
import { findProxy, proxiesFileFor, toRunningBrowser } from './proxies.js';
import { robotsDirFor } from './auth.js';
import { finishedPass, keepSeen, lastPassOf } from './catalogue.js';
import { isBrowserRobot, loadRobot } from './robots.js';
import { asker } from './api.js';
import { through } from './through.js';
import { keepResult } from './results.js';
import type { RunResult } from './run.js';
import { runRobot } from './run-robot.js';
import type { SiteRule } from './rules.js';
import { isTelegramRobot, sessionForRobot } from './telegram.js';

/**
 * Running one scraper for one account, with everything that a run is besides the scraping: what it
 * brought back, what the history says about it, whether the owner should be told, and one line in the
 * log for whoever is awake at four in the morning.
 *
 * It lives here rather than in the web service because a run started by a schedule and a run started
 * by somebody pressing a button have to be the same act. When they are two pieces of code, one of them
 * quietly stops writing history, or stops telling anybody, and nobody notices for a month.
 */
export interface RunOptions {
  pool: BrowserPool;
  rules: SiteRule[];
  maxPages?: number;
}

/**
 * A browser is bound to an account AND to the address it goes out through: switching proxy mid-profile
 * would mix two identities in one cookie jar, which is exactly what a proxy is meant to avoid.
 */
export const poolKey = (userId: string, proxyId?: string): string => (proxyId ? `${userId}|${proxyId}` : userId);

/** One pool per process — the web service has one, a worker has its own. */
export function makePool(): BrowserPool {
  return new BrowserPool({
    max: Number(process.env['RATATOSK_MAX_BROWSERS'] ?? 3),
    open: async (profileDir, key) => {
      const [userId, proxyId] = key.split('|');
      const proxy = proxyId ? await findProxy(proxiesFileFor(userId!), proxyId) : undefined;
      return openBrowser({
        profileDir,
        // Both forms on purpose: the settings for a browser started here, the address for one started
        // in a container of its own, which has to raise its own bridge. See proxies.ts.
        ...(proxy ? { proxy: await toRunningBrowser(proxy), proxyUrl: proxy.url } : {}),
      });
    },
    profileDir: (key) => join(process.env['RATATOSK_PROFILES'] ?? 'profiles', key.replace('|', '--')),
  });
}

export async function runForAccount(userId: string, name: string, options: RunOptions): Promise<RunResult> {
  const robot = await loadRobot(name, robotsDirFor(userId));
      const telegramSession = isTelegramRobot(robot) ? await sessionForRobot(userId, robot.account) : undefined;
  const started = Date.now();

  // What this robot has already returned. Without it, a posting reposted every ten minutes is a new
  // row every ten minutes, and a week of that buries the eleven things that actually happened.
  const memoryFile = memoryFileFor(userId, robot.name);
  const memory = (robot as { remember?: unknown }).remember
    ? { seen: await readMemory(memoryFile), save: (next: Record<string, Seen>) => writeMemory(memoryFile, next) }
    : undefined;

  // What the source holds, as opposed to what this run hands over. A scraper that remembers returns
  // increments, and increments cannot be added back up into a source — the oldest of them ages out.
  const catalogued = (robot as { catalogue?: string }).catalogue;
  const startedAt = new Date().toISOString();
  const saw = catalogued
    ? (rows: Array<Record<string, string | null>>) => keepSeen(userId, robot.name, rows, catalogued, startedAt).then(() => undefined)
    : undefined;

  /**
   * A run that threw is a run that failed, and it has to be written down as one.
   *
   * Everything below this line — the journal, the kept rows, the message to the owner — happens after
   * the run. Let the throw through and none of it happens: the card still shows the last run that
   * worked, nobody is told, and a scraper failing every hour looks exactly like a scraper nobody has
   * started. Measured the expensive way: a dead screen in the browsers' container took two days to
   * notice, because every run since had ended here.
   */
  /**
   * A quick look, or the whole thing.
   *
   * A source worth reading every ten minutes is not worth walking from end to end every ten minutes:
   * what arrived since the last look is on the first page, and the pages behind it cost the site
   * something and us nothing. So a scraper may say how deep a frequent look goes, and how often the
   * whole walk is owed anyway — the full one is what keeps "what the source holds" honest, and what
   * catches anything the first page quietly stopped showing.
   */
  const quick = (robot as { quick?: { maxPages?: number; fullEveryHours?: number } }).quick;
  const lastFull = quick ? await lastPassOf(userId, robot.name) : undefined;
  const fullIsDue =
    !quick ||
    !lastFull ||
    Date.now() - Date.parse(lastFull) >= (quick.fullEveryHours ?? 24) * 60 * 60 * 1000;
  const maxPages = options.maxPages ?? (fullIsDue ? undefined : (quick.maxPages ?? 1));

  /**
   * How a feed robot asks, when it is not asking from here.
   *
   * A browser robot's proxy is handed to Chromium at launch. A feed robot has no Chromium, so the
   * asking itself has to go out through the proxy — and whether it does is decided here, where the
   * account's proxies live, rather than in the robot, which must never see a password.
   */
  const feedProxy = !isBrowserRobot(robot) ? (robot as { proxy?: string }).proxy : undefined;
  const headers = (robot as { headers?: Record<string, string> }).headers ?? {};
  const get = feedProxy ? await through((await findProxy(proxiesFileFor(userId), feedProxy))?.url ?? '') : undefined;
  const askJson = get ? asker(headers, get) : Object.keys(headers).length > 0 ? asker(headers) : undefined;

  let run: RunResult;
  try {
    run = await options.pool.use(poolKey(userId, isBrowserRobot(robot) ? robot.proxy : undefined), (session) =>
      runRobot(robot, {
        page: async () => session.page,
        rules: options.rules,
        ...(maxPages ? { maxPages } : {}),
        telegramSession,
        ...(memory ? { memory } : {}),
        ...(saw ? { saw } : {}),
        ...(askJson ? { askJson } : {}),
        ...(get ? { get } : {}),
      }),
    );
  } catch (error) {
    run = {
      status: 'broken',
      rows: [],
      pagesVisited: 0,
      reason: error instanceof Error ? error.message.split('\n')[0]! : String(error).slice(0, 200),
    };
  }

  // A walk that reached its end, said so. The catalogue is written as the walk goes, so without this
  // there is no way to tell a source of thirty thousand from the first two pages of one — and "what
  // has gone" is exactly that difference. A broken run says nothing: it did not finish.
  if (fullIsDue && run.status !== 'broken') await finishedPass(userId, robot.name, startedAt).catch(() => undefined);

  // One timestamp for both, because they are two halves of the same event: the line in the history
  // and the rows it is about have to be findable from each other.
  const at = new Date().toISOString();
  await remember(historyFileFor(userId), {
    at,
    robot: robot.name,
    kind: 'run',
    status: run.status,
    rows: run.rows.length,
    pages: run.pagesVisited,
    ms: Date.now() - started,
    ...(run.reason ? { why: run.reason.slice(0, 200) } : {}),
    ...(run.challenge ? { door: true } : {}),
    ...(run.quiet ? { quiet: true } : {}),
    ...(maxPages && !fullIsDue ? { quick: true } : {}),
    ...(isBrowserRobot(robot) ? { proxy: robot.proxy ?? 'direct' } : feedProxy ? { proxy: feedProxy } : {}),
  });

  // Kept so that "I ran it yesterday" is answerable today. Only the rows: the verdict and the reason
  // are in the history already.
  await keepResult(userId, robot.name, {
    at,
    status: run.status,
    rows: run.rows,
    pagesVisited: run.pagesVisited,
    ...(run.reason ? { reason: run.reason } : {}),
  }).catch(() => undefined);

  // A scraper that says when it breaks says it to whoever opens the screen; one on a schedule breaks
  // at four in the morning and is found on Friday. So a run is also where the owner gets told —
  // once per breakage and once per recovery, and never for a single bad run.
  await maybeTell(userId, robot.name);

  // The line an operator wants at four in the morning: which robot, what it returned, why not more.
  log(run.status === 'ok' ? 'info' : 'warn', 'robot ran', {
    robot: robot.name,
    user: userId,
    status: run.status,
    rows: run.rows.length,
    pages: run.pagesVisited,
    ms: Date.now() - started,
    ...(run.reason ? { why: run.reason.slice(0, 200) } : {}),
    ...(isBrowserRobot(robot) ? { proxy: robot.proxy ?? 'direct' } : feedProxy ? { proxy: feedProxy } : {}),
  });
  return run;
}

/**
 * Tell the owner, if there is anything to tell.
 *
 * Everything that could go wrong here is somebody else's service being unreachable, and a scrape that
 * worked must not be reported as failed because a bot did not answer. So a failure to tell is logged
 * and swallowed.
 */
async function maybeTell(userId: string, robot: string): Promise<void> {
  const file = alertsFileFor(userId);
  const alerts = await readAlerts(file);
  if (!alerts.botToken || !alerts.chatId) return;

  const now = (await standing(historyFileFor(userId))).find((entry) => entry.robot === robot);
  if (!now) return;

  const telling = whatToSay(now, alerts);
  if (!telling) return;

  try {
    await tell(alerts, telling.say);
    await writeAlerts(file, {
      ...alerts,
      told: { ...alerts.told, [robot]: { status: now.status, inARow: now.inARow, at: now.at } },
    });
    log('info', 'owner told', { robot, user: userId, about: telling.kind });
  } catch (error) {
    // Somebody else's service being unreachable must not turn a scrape that worked into a failure.
    log('warn', 'could not tell the owner', {
      robot,
      user: userId,
      why: error instanceof Error ? error.message.slice(0, 200) : String(error),
    });
  }
}

