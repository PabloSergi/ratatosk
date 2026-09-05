import { join } from 'node:path';
import { alertsFileFor, readAlerts, tell, whatToSay, writeAlerts } from './alerts.js';
import { BrowserPool } from './browsers.js';
import { openBrowser } from './drivers/patchright.js';
import { historyFileFor, remember, standing } from './history.js';
import { log } from './log.js';
import { memoryFileFor, readMemory, writeMemory, type Seen } from './memory.js';
import { findProxy, proxiesFileFor, toRunningBrowser } from './proxies.js';
import { robotsDirFor } from './auth.js';
import { loadRobot } from './robots.js';
import { keepResult } from './results.js';
import type { RunResult } from './run.js';
import { runRobot } from './run-robot.js';
import type { SiteRule } from './rules.js';
import { runConnection, settingsFileFor } from './settings.js';
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
      return openBrowser({ profileDir, ...(proxy ? { proxy: await toRunningBrowser(proxy) } : {}) });
    },
    profileDir: (key) => join(process.env['RATATOSK_PROFILES'] ?? 'profiles', key.replace('|', '--')),
  });
}

export async function runForAccount(userId: string, name: string, options: RunOptions): Promise<RunResult> {
  const robot = await loadRobot(name, robotsDirFor(userId));
      const telegramSession = isTelegramRobot(robot) ? await sessionForRobot(userId, robot.account) : undefined;
  const started = Date.now();

  // A robot only gets a way to ask if its own rule says it needs one — and it is this account's
  // connection that pays for it, not the server's.
  const needsJudge = Boolean((robot as { sift?: { judge?: unknown } }).sift?.judge);
  const connection = needsJudge ? await runConnection(settingsFileFor(userId)) : undefined;
  const ask = connection
    ? async (prompt: string): Promise<string> => {
        const answer = await fetch(`${connection.baseUrl}/chat/completions`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${connection.key}`,
            'x-title': 'ratatosk',
          },
          body: JSON.stringify({
            model: connection.model,
            messages: [{ role: 'user', content: prompt }],
            temperature: 0,
          }),
        });
        if (!answer.ok) throw new Error(`the model answered ${answer.status}`);
        const body = (await answer.json()) as { choices?: Array<{ message?: { content?: string } }> };
        return body.choices?.[0]?.message?.content ?? '';
      }
    : undefined;

  // What this robot has already returned. Without it, a posting reposted every ten minutes is a new
  // row every ten minutes, and a week of that buries the eleven things that actually happened.
  const memoryFile = memoryFileFor(userId, robot.name);
  const memory = (robot as { remember?: unknown }).remember
    ? { seen: await readMemory(memoryFile), save: (next: Record<string, Seen>) => writeMemory(memoryFile, next) }
    : undefined;

  const run = await options.pool.use(poolKey(userId, isTelegramRobot(robot) ? undefined : robot.proxy), (session) =>
    runRobot(robot, {
      page: async () => session.page,
      rules: options.rules,
      ...(options.maxPages ? { maxPages: options.maxPages } : {}),
      telegramSession,
      ...(ask ? { ask } : {}),
      ...(memory ? { memory } : {}),
    }),
  );

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
    ...(isTelegramRobot(robot) ? {} : { proxy: robot.proxy ?? 'direct' }),
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
    ...(isTelegramRobot(robot) ? {} : { proxy: robot.proxy ?? 'direct' }),
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

