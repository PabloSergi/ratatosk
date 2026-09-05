import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse } from 'node:http';
import { connect } from 'node:net';
import { randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { buildWithModel } from './agent.js';
import { BrowserPool } from './browsers.js';
import {
  AuthError,
  countUsers,
  findUser,
  issueToken,
  registerUser,
  robotsDirFor,
  userIds,
  verifyToken,
  verifyUser,
} from './auth.js';
import { createKey, keysFileFor, listKeys, looksLikeKey, revokeKey, whoseKey } from './keys.js';
import { draftScenario } from './draft.js';
import { openBrowser } from './drivers/patchright.js';
import { repairScenario } from './repair.js';
import {
  archivePrevious,
  createRobot,
  deletedRobots,
  deleteRobot,
  listRobots,
  loadRobot,
  renameRobot,
  restoreRobot,
  saveRobot,
} from './robots.js';
import type { SiteRule } from './rules.js';
import {
  addProxy,
  findProxy,
  listProxies,
  proxiesFileFor,
  rememberCheck,
  removeProxy,
  toRunningBrowser,
  view as proxyView,
} from './proxies.js';
import { runRobot } from './run-robot.js';
import { buildSift, type Ask, type SiftBuild } from './sift-agent.js';
import { repairRule } from './rule-repair.js';
import { memoryFileFor, readMemory, writeMemory, type Seen } from './memory.js';
import { judgeSift, sift, type Sift } from './sift.js';
import { closeBridges } from './socks-bridge.js';
import { findTakeover, startTakeover, stopAllTakeovers, stopTakeover, takeoversOf } from './takeover.js';
import { liveLog, liveStream, nextFrame, viewerPage } from './live-view.js';
import { InputError } from './errors.js';
import { failure, info, log, warn } from './log.js';
import { alertsFileFor, DEFAULT_AFTER, readAlerts, tell, viewAlerts, whatToSay, writeAlerts } from './alerts.js';
import { forgetResults, keepResult, keptRuns, moveResults, readResult } from './results.js';
import { historyFileFor, recent, remember, renameInHistory, standing } from './history.js';
import {
  activeConnection,
  runConnection,
  setRunConnection,
  activeConnectionById,
  addConnection,
  checkConnection,
  listConnections,
  listModels,
  PROVIDERS,
  removeConnection,
  setActiveConnection,
  setModel,
  settingsFileFor,
  type ProviderId,
} from './settings.js';
import {
  isTelegramRobot,
  runTelegramRobot,
  listTelegramAccounts,
  parseTelegramRobot,
  sessionForRobot,
  telegramAccountFile,
  telegramCheck,
  telegramForget,
  telegramSendCode,
  telegramSignIn,
} from './telegram.js';
import { extname, join as joinPath, normalize, resolve } from 'node:path';

/**
 * A thin operator view: which robots exist, what they return right now, and what to do when one breaks.
 * Not the scenario editor from the plan — that is still an open question — and deliberately not a
 * dashboard. It binds to localhost by default: this is a window onto a machine, not a public service.
 */
const PORT = Number(process.env['PORT'] ?? 5544);
const HOST = process.env['HOST'] ?? '127.0.0.1';

let rules: SiteRule[] = [];

/**
 * A browser per account, capped so a busy server does not fill up with them. Work inside one account
 * is serialised — one browser, one page — while different accounts run side by side.
 */
const pool = new BrowserPool({
  max: Number(process.env['RATATOSK_MAX_BROWSERS'] ?? 3),
  open: async (profileDir, key) => {
    const [userId, proxyId] = key.split('|');
    const proxy = proxyId ? await findProxy(proxiesFileFor(userId!), proxyId) : undefined;
    return openBrowser({ profileDir, ...(proxy ? { proxy: await toRunningBrowser(proxy) } : {}) });
  },
  profileDir: (key) => join(process.env['RATATOSK_PROFILES'] ?? 'profiles', key.replace('|', '--')),
});

/**
 * A browser is bound to an account AND to the address it goes out through: switching proxy mid-profile
 * would mix two identities in one cookie jar, which is exactly what a proxy is meant to avoid.
 */
const poolKey = (userId: string, proxyId?: string): string => (proxyId ? `${userId}|${proxyId}` : userId);

interface Caller {
  id: string;
  email: string;
}

/** Open to anyone: creating an account and signing in. Everything else needs a token. */
const publicRoutes: Record<string, (body: Record<string, unknown>) => Promise<unknown>> = {
  '/api/auth/state': async () => ({ users: await countUsers() }),

  '/api/auth/register': async (body) => {
    const first = (await countUsers()) === 0;
    const user = await registerUser(String(body['email'] ?? ''), String(body['password'] ?? ''));
    // Robots that existed before there were accounts belong to whoever opens the first one — the
    // person who was already running this. Better than leaving them orphaned in a directory nobody
    // looks at any more.
    if (first) await adoptExistingRobots(robotsDirFor(user.id));
    return { user, ...(await issueToken(user)) };
  },

  '/api/auth/login': async (body) => {
    const user = await verifyUser(String(body['email'] ?? ''), String(body['password'] ?? ''));
    return { user, ...(await issueToken(user)) };
  },
};

const routes: Record<string, (body: Record<string, unknown>, user: Caller) => Promise<unknown>> = {
  '/api/auth/me': async (_body, user) => ({ user }),

  '/api/robots': async (_body, user) => ({ robots: await listRobots(robotsDirFor(user.id)) }),

  '/api/run': async (body, user) => {
    const robot = await loadRobot(String(body['name']), robotsDirFor(user.id));
    const maxPages = Number(body['maxPages'] ?? 0) || undefined;
    const telegramSession = isTelegramRobot(robot) ? await sessionForRobot(user.id, robot.account) : undefined;
    const started = Date.now();

    // A robot only gets a way to ask if its own rule says it needs one — and it is this account's
    // connection that pays for it, not the server's.
    const needsJudge = Boolean((robot as { sift?: { judge?: unknown } }).sift?.judge);
    const connection = needsJudge ? await runConnection(settingsFileFor(user.id)) : undefined;
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
    const memoryFile = memoryFileFor(user.id, robot.name);
    const memory = (robot as { remember?: unknown }).remember
      ? { seen: await readMemory(memoryFile), save: (next: Record<string, Seen>) => writeMemory(memoryFile, next) }
      : undefined;

    const run = await pool.use(poolKey(user.id, isTelegramRobot(robot) ? undefined : robot.proxy), (session) =>
      runRobot(robot, {
        page: async () => session.page,
        rules,
        maxPages,
        telegramSession,
        ...(ask ? { ask } : {}),
        ...(memory ? { memory } : {}),
      }),
    );

    // One timestamp for both, because they are two halves of the same event: the line in the history
    // and the rows it is about have to be findable from each other.
    const at = new Date().toISOString();
    await remember(historyFileFor(user.id), {
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
    await keepResult(user.id, robot.name, {
      at,
      status: run.status,
      rows: run.rows,
      pagesVisited: run.pagesVisited,
      ...(run.reason ? { reason: run.reason } : {}),
    }).catch(() => undefined);

    // A scraper that says when it breaks says it to whoever opens the screen; one on a schedule breaks
    // at four in the morning and is found on Friday. So a run is also where the owner gets told —
    // once per breakage and once per recovery, and never for a single bad run.
    await maybeTell(user.id, robot.name);

    // The line an operator wants at four in the morning: which robot, what it returned, why not more.
    log(run.status === 'ok' ? 'info' : 'warn', 'robot ran', {
      robot: robot.name,
      user: user.id,
      status: run.status,
      rows: run.rows.length,
      pages: run.pagesVisited,
      ms: Date.now() - started,
      ...(run.reason ? { why: run.reason.slice(0, 200) } : {}),
      ...(isTelegramRobot(robot) ? {} : { proxy: robot.proxy ?? 'direct' }),
    });
    return run;
  },

  /**
   * Keys for the machines. A schedule in n8n, a cron, somebody else's script: they all need a
   * credential that outlives a login, is named so it can be recognised a year later, and can be
   * revoked one at a time without disturbing the others.
   */
  '/api/keys': async (_body, user) => ({ keys: await listKeys(keysFileFor(user.id)) }),

  '/api/keys/create': async (body, user) => {
    const made = await createKey(keysFileFor(user.id), String(body['label'] ?? ''));
    // The only time the key itself is ever returned. After this there is only its hash.
    return { key: made.key, keys: await listKeys(keysFileFor(user.id)) };
  },

  '/api/keys/revoke': async (body, user) => {
    await revokeKey(keysFileFor(user.id), String(body['id'] ?? ''));
    return { keys: await listKeys(keysFileFor(user.id)) };
  },

  /** A robot's own story: what it returned, when, and how long it has been like that. */
  '/api/history': async (body, user) => {
    const file = historyFileFor(user.id);
    const robot = body['robot'] ? String(body['robot']) : undefined;
    return {
      runs: await recent(file, { ...(robot ? { robot } : {}), limit: Number(body['limit'] ?? 60) || 60 }),
      standing: await standing(file),
    };
  },

  /**
   * Repair, for whichever half of a robot has rotted.
   *
   * Selectors rot when a site changes its markup; a rule rots when people change how they write. Both
   * fail the same way — quietly, returning less or returning rubbish — so both are looked at here, and
   * neither is replaced until the new one has been proved on material collected now.
   */
  '/api/repair': async (body, user) => {
    const dir = robotsDirFor(user.id);
    const name = String(body['name']);
    const robot = await loadRobot(name, dir);
    const rule = (robot as { sift?: Sift }).sift;

    if (isTelegramRobot(robot) && !rule) {
      throw new InputError(
        `${name} reads Telegram and sifts by nothing — there is nothing to repair. Give it a rule, or edit its channels.`,
      );
    }

    // The page half first: a rule measured against rows a broken scenario collected proves nothing.
    let selectors;
    if (!isTelegramRobot(robot)) {
      selectors = await pool.use(poolKey(user.id, robot.proxy), async (session) => {
        const repair = await repairScenario(session.page, robot, { rules });
        if (repair.status === 'repaired' && repair.scenario) {
          await archivePrevious(name, dir);
          await saveRobot({ ...repair.scenario, ...(rule ? { sift: rule } : {}) }, dir);
        }
        return repair;
      });
    }

    if (!rule) return selectors;

    const connection = await activeConnection(settingsFileFor(user.id));
    if (!connection) throw new InputError('no model connection yet — a rule cannot be judged without one');

    const current = await loadRobot(name, dir); // the scenario may have just been repaired under us
    const fresh = await freshRows(current, user.id);
    const repaired = await repairRule({
      rows: fresh.rows,
      sift: rule,
      ask: askModel(connection),
      model: { apiKey: connection.key, model: connection.model, baseUrl: connection.baseUrl },
    });

    if (repaired.status === 'repaired' && repaired.sift) {
      await archivePrevious(name, dir);
      await saveRobot({ ...current, sift: repaired.sift } as typeof current, dir);
    }

    log(repaired.status === 'unfixable' ? 'warn' : 'info', 'rule repaired', {
      robot: name,
      user: user.id,
      status: repaired.status,
      sampled: repaired.before.sampled,
      ...(repaired.reason ? { why: repaired.reason } : {}),
    });

    return { ...(selectors ?? {}), rule: repaired };
  },

  /** The model builds it: a URL and a sentence about what is wanted. */
  '/api/agent': async (body, user) => {
    // The account's own key comes first; the server's is a fallback for a single-user install.
    const connection = await activeConnection(settingsFileFor(user.id));
    if (!connection) throw new Error('no model connection yet — add one in Model, it takes a minute');
    const url = String(body['url']);
    const want = String(body['want'] || 'the main list on this page, with every column that carries meaning');
    const name = String(body['name'] || new URL(url).hostname.replace(/^www\./, '').split('.')[0]);
    const proxy = body['proxy'] ? String(body['proxy']) : undefined;
    return pool.use(poolKey(user.id, proxy), async (session) => {
      const started = Date.now();
      const result = await buildWithModel(session.page, {
        url,
        want,
        name,
        rules,
        apiKey: connection.key,
        model: connection.model,
        baseUrl: connection.baseUrl,
      });
      await remember(historyFileFor(user.id), {
        at: new Date().toISOString(),
        robot: name,
        kind: 'build',
        status: result.verdict?.good ? 'ok' : 'broken',
        rows: result.rows.length,
        ms: Date.now() - started,
        ...(result.reason ? { why: result.reason.slice(0, 200) } : {}),
        ...(result.challenge ? { door: true } : {}),
        proxy: proxy ?? 'direct',
      });

      log(result.verdict?.good ? 'info' : 'warn', 'robot built', {
        robot: name,
        user: user.id,
        url,
        proxy: proxy ?? 'direct',
        model: connection.model,
        rows: result.rows.length,
        calls: result.usage.calls,
        tokens: result.usage.promptTokens + result.usage.completionTokens,
        ms: Date.now() - started,
        ...(result.challenge ? { door: true } : {}),
        ...(result.reason ? { why: result.reason.slice(0, 200) } : {}),
      });

      // A robot built through a proxy must keep going through it: the address is part of how it works.
      if (result.scenario && result.verdict?.good) {
        await createRobot({ ...result.scenario, ...(proxy ? { proxy } : {}) }, robotsDirFor(user.id));
      }
      return result;
    });
  },

  /**
   * Connecting a Telegram account is the user's own business: their api_id, their phone, their code.
   * Nothing here is stored anywhere but this machine, and it can be dropped again from the same view.
   */
  /** Proxies belong to the account; a robot names the one it goes out through. */
  '/api/proxies': async (_body, user) => ({
    proxies: (await listProxies(proxiesFileFor(user.id))).map(proxyView),
  }),

  '/api/proxies/add': async (body, user) => {
    const proxy = await addProxy(proxiesFileFor(user.id), {
      url: String(body['url'] ?? ''),
      label: body['label'] ? String(body['label']) : undefined,
    });
    return proxyView(proxy);
  },

  '/api/proxies/remove': async (body, user) => {
    await removeProxy(proxiesFileFor(user.id), String(body['id']));
    return { proxies: (await listProxies(proxiesFileFor(user.id))).map(proxyView) };
  },

  /** The only honest check: go out through it and see which address the world reports back. */
  '/api/proxies/check': async (body, user) => {
    const file = proxiesFileFor(user.id);
    const id = String(body['id']);
    const proxy = await findProxy(file, id);
    if (!proxy) throw new InputError('no such proxy');

    const started = Date.now();
    const session = await openBrowser({ proxy: await toRunningBrowser(proxy), profileDir: '' });
    try {
      await session.page.goto('https://api.ipify.org?format=json');
      const text = await session.page.evaluate<string>('() => document.body.innerText');
      const exitIp = (JSON.parse(text) as { ip?: string }).ip ?? 'unknown';
      const updated = await rememberCheck(file, id, exitIp);
      return { ...proxyView(updated ?? proxy), exitIp, latencyMs: Date.now() - started };
    } catch (error) {
      throw new Error(
        `that proxy did not carry us anywhere: ${error instanceof Error ? (error.message.split('\n')[0] ?? '') : String(error)}`,
      );
    } finally {
      await session.close().catch(() => undefined);
    }
  },

  /**
   * Take the browser over for a minute.
   *
   * Some doors are meant for a person: a check that asks whether you are one, a login, an age gate.
   * The robot's own browser is put on a screen only this account can reach, the person deals with it
   * themselves, and whatever the site leaves behind stays in the profile the robot uses.
   */
  '/api/browser/takeover': async (body, user) => {
    const proxyId = body['proxy'] ? String(body['proxy']) : undefined;
    const proxy = proxyId ? await findProxy(proxiesFileFor(user.id), proxyId) : undefined;
    if (proxyId && !proxy) throw new InputError('no such proxy');

    // The same profile the robot uses — a different one would keep the cookie somewhere useless.
    const key = poolKey(user.id, proxyId);
    await pool.close(key);

    const takeover = await startTakeover({
      userId: user.id,
      url: String(body['url'] ?? ''),
      profileDir: join(process.env['RATATOSK_PROFILES'] ?? 'profiles', key.replace('|', '--')),
      ...(proxy ? { proxy: await toRunningBrowser(proxy) } : {}),
    });

    return {
      // The tab itself, watched and pressed by coordinates. The desktop over VNC stays available for
      // the rare case where the whole browser window is what someone needs.
      view: `/live/${takeover.token}`,
      desktop:
        `/vnc/${takeover.token}/vnc.html?path=${encodeURIComponent(`vnc/${takeover.token}/websockify`)}` +
        `&autoconnect=1&resize=scale&quality=4&compression=6&reconnect=1`,
      vncPort: takeover.vncPort,
      url: takeover.url,
      expiresAt: new Date(takeover.expiresAt).toISOString(),
    };
  },

  /**
   * Everything a browser on this person's own machine needs to look like the robot: the same way out,
   * and what the robot's own Chromium calls itself. A gate that binds its answer to an address and a
   * browser will not accept a cookie earned from somewhere else by something else.
   *
   * The proxy comes back whole, credentials included — it is this account's own proxy, going to this
   * account's own machine, over a request this account had to sign in to make.
   */
  '/api/browser/session': async (body, user) => {
    const proxyId = body['proxy'] ? String(body['proxy']) : undefined;
    const proxy = proxyId ? await findProxy(proxiesFileFor(user.id), proxyId) : undefined;
    if (proxyId && !proxy) throw new InputError('no such proxy');

    return {
      proxyUrl: proxy?.url ?? null,
      userAgent: await robotUserAgent(),
    };
  },

  /**
   * A session earned elsewhere, put where the robot will find it. The profile is the robot's own, so
   * the next run arrives as whoever passed the gate — which is the entire point of doing it by hand.
   */
  '/api/browser/cookies': async (body, user) => {
    const cookies = body['cookies'];
    if (!Array.isArray(cookies) || cookies.length === 0) throw new InputError('there were no cookies to bring over');

    const proxyId = body['proxy'] ? String(body['proxy']) : undefined;
    const proxy = proxyId ? await findProxy(proxiesFileFor(user.id), proxyId) : undefined;
    if (proxyId && !proxy) throw new InputError('no such proxy');

    const key = poolKey(user.id, proxyId);
    await pool.close(key);

    const session = await openBrowser({
      profileDir: join(process.env['RATATOSK_PROFILES'] ?? 'profiles', key.replace('|', '--')),
    });
    try {
      if (!session.setCookies) throw new Error('this browser cannot be given a session');
      await session.setCookies(cookies);

      // A cookie without an expiry lives in memory and dies with the browser — it would arrive here,
      // be accepted, and be gone before the next run. Better to say which ones will not survive.
      const fleeting = cookies.filter((cookie) => {
        const expires = (cookie as { expires?: number }).expires;
        return expires === undefined || expires <= 0;
      }).length;

      const hosts = [...new Set(cookies.map((cookie) => String((cookie as { domain?: string }).domain ?? '')))];
      return {
        taken: cookies.length,
        kept: cookies.length - fleeting,
        hosts,
        into: proxy ? proxy.label : 'the direct profile',
        ...(fleeting ? { note: `${fleeting} of them end when the browser closes and will not last` } : {}),
      };
    } finally {
      // Closing is what writes them to disk.
      await session.close().catch(() => undefined);
    }
  },

  /**
   * Forget one site in this robot's profile — the cookie that got past a gate, the session behind a
   * login. Pressing a gate again to see whether it still works is impossible while the profile still
   * remembers passing it the first time.
   */
  '/api/browser/forget-site': async (body, user) => {
    let host: string;
    try {
      host = new URL(String(body['url'] ?? '')).hostname;
    } catch {
      throw new InputError('give the address of the site to forget');
    }

    const proxyId = body['proxy'] ? String(body['proxy']) : undefined;
    const proxy = proxyId ? await findProxy(proxiesFileFor(user.id), proxyId) : undefined;
    if (proxyId && !proxy) throw new InputError('no such proxy');

    // A browser that is still open would write its own idea of the cookies back over ours on closing.
    for (const takeover of takeoversOf(user.id)) await stopTakeover(takeover.token);
    const key = poolKey(user.id, proxyId);
    await pool.close(key);

    const session = await openBrowser({
      profileDir: join(process.env['RATATOSK_PROFILES'] ?? 'profiles', key.replace('|', '--')),
    });
    try {
      if (!session.forgetSite) throw new Error('this browser cannot forget anything');
      return { host, forgotten: await session.forgetSite(host) };
    } finally {
      await session.close().catch(() => undefined);
    }
  },

  '/api/browser/release': async (_body, user) => {
    for (const takeover of takeoversOf(user.id)) await stopTakeover(takeover.token);
    return { released: true };
  },

  /**
   * The rule a robot sifts by: shown, tried on fresh material, rebuilt, or written by hand.
   *
   * A rule nobody can see is a rule nobody can trust — and this one decides what the robot returns.
   * Everything here works the same for a page and for a message stream, because a rule that separates
   * what was asked for from what was not is the same thing in both.
   */
  '/api/robot/rule': async (body, user) => {
    const dir = robotsDirFor(user.id);
    const robot = await loadRobot(String(body['name'] ?? ''), dir);
    return {
      name: robot.name,
      sift: (robot as { sift?: unknown }).sift ?? null,
      remember: Boolean((robot as { remember?: unknown }).remember),
      dedupe: (robot as { dedupe?: boolean }).dedupe !== false,
    };
  },

  '/api/robot/rule/save': async (body, user) => {
    const dir = robotsDirFor(user.id);
    const robot = await loadRobot(String(body['name'] ?? ''), dir);
    const rule = readRule(body['sift']);
    const remembering = body['remember'] === true || body['remember'] === 'true';
    // Absent means yes: a scraper saved before this existed keeps doing the sensible thing.
    const deduping = body['dedupe'] === undefined || body['dedupe'] === true || body['dedupe'] === 'true';

    // Compiled before it is written: a rule that cannot run is worse than no rule, because it fails at
    // four in the morning rather than here.
    try {
      sift([], rule);
    } catch (error) {
      throw new InputError(error instanceof Error ? error.message : String(error));
    }

    const updated = {
      ...robot,
      ...(rule.keep.length || rule.drop?.length ? { sift: rule } : {}),
      ...(remembering ? { remember: { mode: 'new' as const } } : {}),
      ...(deduping ? {} : { dedupe: false }),
    };
    if (!rule.keep.length && !rule.drop?.length) delete (updated as { sift?: unknown }).sift;
    if (!remembering) delete (updated as { remember?: unknown }).remember;
    if (deduping) delete (updated as { dedupe?: unknown }).dedupe;

    await archivePrevious(robot.name, dir);
    await saveRobot(updated as typeof robot, dir);
    return {
      saved: robot.name,
      sift: (updated as { sift?: unknown }).sift ?? null,
      remember: Boolean((updated as { remember?: unknown }).remember),
      dedupe: (updated as { dedupe?: boolean }).dedupe !== false,
    };
  },

  /** Try a rule on material collected now, and say exactly what it would do with it. */
  '/api/robot/rule/test': async (body, user) => {
    const dir = robotsDirFor(user.id);
    const robot = await loadRobot(String(body['name'] ?? ''), dir);
    const rule = body['sift'] ? readRule(body['sift']) : ((robot as { sift?: Sift }).sift ?? { keep: [] });

    const fresh = await freshRows(robot, user.id);
    const result = sift(fresh.rows, rule);
    const verdict = judgeSift(result, fresh.rows.length);

    return {
      sampled: fresh.rows.length,
      kept: result.kept,
      dropped: result.dropped,
      unclaimed: result.unclaimed.length,
      collisions: result.collisions.length,
      good: verdict.good,
      note: verdict.note,
      examples: result.examples,
    };
  },

  /** Write the rule again from fresh material. Proposed, never applied — the diff is for a person. */
  '/api/robot/rule/rebuild': async (body, user) => {
    const dir = robotsDirFor(user.id);
    const robot = await loadRobot(String(body['name'] ?? ''), dir);
    const stored = (robot as { sift?: Sift }).sift;
    const want = String(body['want'] ?? stored?.want ?? stored?.judge?.want ?? '').trim();
    if (!want) throw new InputError('say what this scraper should keep, in your own words');

    const connection = await activeConnection(settingsFileFor(user.id));
    if (!connection) throw new InputError('no model connection yet — add one in Model');

    const fresh = await freshRows(robot, user.id);
    const built = await buildSift({
      sample: fresh.rows,
      want,
      apiKey: connection.key,
      model: connection.model,
      baseUrl: connection.baseUrl,
    });

    log(built.sift ? 'info' : 'warn', 'rule rebuilt', {
      robot: robot.name,
      user: user.id,
      sampled: fresh.rows.length,
      calls: built.usage.calls,
      ...(built.reason ? { why: built.reason } : {}),
    });

    return {
      sampled: fresh.rows.length,
      proposed: built.sift ?? null,
      was: stored ?? null,
      attempts: built.attempts,
      usage: built.usage,
      ...(built.reason ? { reason: built.reason } : {}),
    };
  },

  /**
   * Delete a robot, and with it what its profile remembers about that site — the cookie that got past a
   * gate, the session behind a login. Keeping those after the robot is gone would leave a stranger's
   * session lying in a profile nobody looks at.
   *
   * Unless another robot still reads the same site: profiles are shared by account and proxy, and one
   * robot's deletion has no business logging another one out.
   */
  '/api/robot/delete': async (body, user) => {
    const dir = robotsDirFor(user.id);
    const name = String(body['name'] ?? '');
    const robot = await loadRobot(name, dir);
    const removed = await deleteRobot(name, dir);
    // Its memory of what it has seen goes too: keeping it would silence a scraper recreated later.
    await rm(memoryFileFor(user.id, name), { force: true }).catch(() => undefined);
    await forgetResults(user.id, name).catch(() => undefined);

    if (isTelegramRobot(robot)) return { deleted: name, removed, forgotten: 0 };

    const host = new URL(robot.url).hostname;
    const stillRead = (await listRobots(dir)).some(
      (other) => other.kind === 'web' && sameHost(other.url, host),
    );
    if (stillRead) return { deleted: name, removed, forgotten: 0, kept: `${host} is still read by another robot` };

    const key = poolKey(user.id, robot.proxy);
    await pool.close(key);
    const session = await openBrowser({
      profileDir: join(process.env['RATATOSK_PROFILES'] ?? 'profiles', key.replace('|', '--')),
    });
    try {
      const forgotten = session.forgetSite ? await session.forgetSite(host) : 0;
      return { deleted: name, removed, forgotten, host };
    } finally {
      await session.close().catch(() => undefined);
    }
  },

  /**
   * Is this scraper still alive?
   *
   * One page, nothing else: no pagination, no walking into rows, no model, and — the part that matters
   * — no memory. A check must never mark rows as seen, or checking a scraper would quietly eat the very
   * rows its next run was meant to hand over. It is not written to the run history either: a probe is
   * not a delivery, and counting it as one would make "three runs in a row" mean nothing.
   */
  '/api/robot/check': async (body, user) => {
    const robot = await loadRobot(String(body['name']), robotsDirFor(user.id));
    const started = Date.now();
    const telegramSession = isTelegramRobot(robot) ? await sessionForRobot(user.id, robot.account) : undefined;

    const result = await pool.use(poolKey(user.id, isTelegramRobot(robot) ? undefined : robot.proxy), (session) =>
      runRobot(robot, {
        page: async () => session.page,
        rules,
        maxPages: 1,
        ...(telegramSession ? { telegramSession } : {}),
      }),
    );

    const ms = Date.now() - started;
    const note =
      result.status === 'ok'
        ? `${result.rows.length} rows on the first page · ${ms} ms`
        : (result.reason ?? 'nothing came back');

    log(result.status === 'ok' ? 'info' : 'warn', 'robot checked', {
      robot: robot.name,
      user: user.id,
      status: result.status,
      rows: result.rows.length,
      ms,
    });

    return {
      name: robot.name,
      ok: result.status === 'ok',
      status: result.status,
      rows: result.rows.length,
      challenge: result.challenge ?? false,
      note,
      at: new Date().toISOString(),
    };
  },

  /** Being told when something breaks: what is set up, without the token itself. */
  '/api/alerts': async (_body, user) => viewAlerts(await readAlerts(alertsFileFor(user.id))),

  '/api/alerts/save': async (body, user) => {
    const file = alertsFileFor(user.id);
    const before = await readAlerts(file);

    // An empty token means "leave the one you have": a form that clears the credential every time it
    // is used to change the chat id is a form that punishes editing.
    const botToken = String(body['botToken'] ?? '').trim() || before.botToken;
    const chatId = String(body['chatId'] ?? '').trim() || before.chatId;
    const after = Math.max(1, Math.min(20, Number(body['after'] ?? before.after ?? DEFAULT_AFTER) || DEFAULT_AFTER));

    if (!botToken) throw new InputError('a bot token is needed — make a bot with @BotFather and paste its token');
    if (!chatId) throw new InputError('a chat id is needed — @userinfobot tells you yours');

    const alerts = { ...before, botToken, chatId, after };
    await writeAlerts(file, alerts);
    log('info', 'alerts set up', { user: user.id, after });
    return viewAlerts(alerts);
  },

  '/api/alerts/off': async (_body, user) => {
    const file = alertsFileFor(user.id);
    const before = await readAlerts(file);
    // The streak memory goes too: turning it back on later should not stay silent about a scraper
    // that broke while nobody was being told.
    await writeAlerts(file, { after: before.after ?? DEFAULT_AFTER });
    return viewAlerts({});
  },

  /** Say something now, so "it is set up" and "it works" are not the same claim. */
  '/api/alerts/test': async (_body, user) => {
    const alerts = await readAlerts(alertsFileFor(user.id));
    await tell(alerts, 'Ratatosk is set up to tell you here when a scraper stops working.');
    return { sent: true };
  },

  /** What this scraper brought back on its last few runs — the list, without the rows. */
  '/api/results': async (body, user) => ({
    kept: await keptRuns(user.id, String(body['name'] ?? '')),
  }),

  /** One kept run, rows and all, so yesterday's work can be looked at and taken away today. */
  '/api/results/get': async (body, user) => {
    const kept = await readResult(user.id, String(body['name'] ?? ''), String(body['at'] ?? ''));
    if (!kept) throw new InputError('nothing kept from that run — it may have aged out');
    return kept;
  },

  /** What has been deleted and can still be had back. */
  '/api/robot/deleted': async (_body, user) => ({ deleted: await deletedRobots(robotsDirFor(user.id)) }),

  /**
   * Lift a deleted scraper back out. Its memory of what it had handed over went with the deletion on
   * purpose — a scraper brought back after a fortnight should say what is there now, not stay silent
   * about everything it saw before it was deleted.
   */
  '/api/robot/restore': async (body, user) => {
    const robot = await restoreRobot(String(body['file'] ?? ''), robotsDirFor(user.id));
    log('info', 'scraper restored', { robot: robot.name, user: user.id });
    return { restored: robot.name };
  },

  /**
   * Rename a scraper, and everything its name is the key to: the file, the memory of what it has
   * already handed over, and every line of its history. A rename that moved only the file would hand
   * back a scraper with no past and no memory, which is a new scraper wearing an old name.
   */
  '/api/robot/rename': async (body, user) => {
    const from = String(body['name'] ?? '');
    const to = String(body['to'] ?? '');
    const dir = robotsDirFor(user.id);

    const renamed = await renameRobot(from, to, dir);

    const wasMemory = memoryFileFor(user.id, from);
    const nowMemory = memoryFileFor(user.id, renamed.name);
    await rename(wasMemory, nowMemory).catch(() => undefined); // a scraper that never remembered has no file

    await moveResults(user.id, from, renamed.name).catch(() => undefined);
    const runs = await renameInHistory(historyFileFor(user.id), from, renamed.name);

    log('info', 'scraper renamed', { from, to: renamed.name, user: user.id, runs });
    return { name: renamed.name, was: from, runs };
  },

  /** Attach or detach a proxy on a robot that already exists. */
  '/api/robot/proxy': async (body, user) => {
    const dir = robotsDirFor(user.id);
    const robot = await loadRobot(String(body['name']), dir);
    if (isTelegramRobot(robot)) throw new InputError('a Telegram scraper does not go through a browser proxy');

    const proxy = body['proxy'] ? String(body['proxy']) : undefined;
    if (proxy && !(await findProxy(proxiesFileFor(user.id), proxy))) throw new InputError('no such proxy');

    const updated = { ...robot, ...(proxy ? { proxy } : {}) };
    if (!proxy) delete (updated as { proxy?: string }).proxy;
    await saveRobot(updated, dir);
    return { name: robot.name, proxy: proxy ?? null };
  },

  /** Model connections: several per account, one of them active. */
  '/api/models': async (_body, user) => ({
    connections: await listConnections(settingsFileFor(user.id)),
    providers: PROVIDERS,
  }),

  '/api/models/catalogue': async (body, user) => {
    // Asked for an existing connection, the key comes from the file — the browser never holds it.
    if (body['id']) {
      const connections = await listConnections(settingsFileFor(user.id));
      const known = connections.find((connection) => connection.id === String(body['id']));
      if (!known) throw new InputError('no such connection');
      const withKey = await activeConnectionById(settingsFileFor(user.id), known.id);
      return listModels({
        provider: known.provider,
        baseUrl: known.baseUrl,
        key: withKey?.key,
        force: Boolean(body['refresh']),
      });
    }

    return listModels({
      provider: String(body['provider'] ?? 'openrouter') as ProviderId,
      baseUrl: body['baseUrl'] ? String(body['baseUrl']) : undefined,
      key: body['key'] ? String(body['key']) : undefined,
      force: Boolean(body['refresh']),
    });
  },

  '/api/models/add': async (body, user) =>
    addConnection(settingsFileFor(user.id), {
      provider: String(body['provider'] ?? 'openrouter') as ProviderId,
      key: String(body['key'] ?? ''),
      model: String(body['model'] ?? ''),
      label: body['label'] ? String(body['label']) : undefined,
      baseUrl: body['baseUrl'] ? String(body['baseUrl']) : undefined,
    }),

  '/api/models/remove': async (body, user) => {
    await removeConnection(settingsFileFor(user.id), String(body['id']));
    return { connections: await listConnections(settingsFileFor(user.id)) };
  },

  /** Which connection does the repeating work. Empty means "the same one that builds". */
  '/api/models/runs': async (body, user) => {
    await setRunConnection(settingsFileFor(user.id), body['id'] ? String(body['id']) : undefined);
    return { connections: await listConnections(settingsFileFor(user.id)) };
  },

  '/api/models/use': async (body, user) => {
    await setActiveConnection(settingsFileFor(user.id), String(body['id']));
    return { connections: await listConnections(settingsFileFor(user.id)) };
  },

  '/api/models/model': async (body, user) => {
    await setModel(settingsFileFor(user.id), String(body['id']), String(body['model']));
    return { connections: await listConnections(settingsFileFor(user.id)) };
  },

  '/api/models/check': async (body, user) => {
    const checked = await checkConnection(settingsFileFor(user.id), String(body['id']));
    return { ...checked, connections: await listConnections(settingsFileFor(user.id)) };
  },

  /** Telegram accounts: several per user, each connected the same way. */
  '/api/telegram': async (_body, user) => ({ accounts: await listTelegramAccounts(user.id) }),

  '/api/telegram/check': async (body, user) => {
    const robots = await listRobots(robotsDirFor(user.id));
    const channels = new Set<string>();
    for (const summary of robots) {
      if (summary.kind !== 'telegram') continue;
      for (const name of summary.url.split(',')) channels.add(name.trim().replace(/^@/, ''));
    }
    return telegramCheck(telegramAccountFile(user.id, String(body['id'])), [...channels].filter(Boolean));
  },

  '/api/telegram/send-code': async (body, user) =>
    telegramSendCode({
      apiId: Number(body['apiId']),
      apiHash: String(body['apiHash']),
      phone: String(body['phone']).trim(),
      file: telegramAccountFile(user.id, 'pending'),
    }),

  '/api/telegram/sign-in': async (body, user) => {
    // A fresh id per connection: two accounts must never land in one file.
    const signed = await telegramSignIn({
      phone: String(body['phone']).trim(),
      code: String(body['code']).trim(),
      password: body['password'] ? String(body['password']) : undefined,
      file: telegramAccountFile(user.id, 'pending'),
    });
    const id = randomUUID().slice(0, 8);
    await rename(telegramAccountFile(user.id, 'pending'), telegramAccountFile(user.id, id));
    return { ...signed, id, accounts: await listTelegramAccounts(user.id) };
  },

  '/api/telegram/forget': async (body, user) => {
    await telegramForget(telegramAccountFile(user.id, String(body['id'])));
    return { accounts: await listTelegramAccounts(user.id) };
  },

  /**
   * One channel, one scraper.
   *
   * Several channels behind a single scraper reads as tidier and is worse at the only thing this
   * product promises: when one of four groups goes quiet or throws us out, a merged scraper still
   * returns rows from the other three and looks perfectly healthy. Split, each one has its own state,
   * its own history, its own memory of what it has already handed over, and can be deleted or repaired
   * without disturbing its neighbours.
   *
   * The rule is written once, from a sample pooled across all of them — that is one model call for the
   * whole batch rather than one each, and they are the same task by definition, since the person
   * described it once. Each scraper then carries its own copy and can be rebuilt alone later.
   */
  '/api/telegram/robot': async (body, user) => {
    const channels = String(body['channels'])
      .split(/[\s,]+/)
      .map((channel) => channel.replace(/^@/, '').trim())
      .filter(Boolean);

    if (channels.length === 0) throw new InputError('name at least one channel or group');

    const given = String(body['name'] ?? '').trim();
    const account = body['account'] ? String(body['account']) : undefined;
    const limit = Number(body['limit'] ?? 100);
    const contains = String(body['contains'] ?? '')
      .split(',')
      .map((word) => word.trim())
      .filter(Boolean);

    const robots = channels.map((channel) =>
      parseTelegramRobot({
        // A name is what you look for in a list of thirty, so it says which channel this is. One
        // channel and a name given by hand is the exception: then the person's own word wins.
        name: channels.length === 1 && given ? given : given ? `${given}-${channel}` : channel,
        version: 1,
        source: 'telegram',
        account,
        channels: [channel],
        limit,
        contains,
      }),
    );

    // A channel decides nothing about what a message is: postings, CVs, someone selling accounts and
    // someone saying "up" arrive through the same pipe. If the person said what they are after, the
    // model reads real messages and writes the rule that separates them — and the rule is kept only if
    // it demonstrably does, on those same messages.
    const want = String(body['want'] ?? '').trim();
    let sifting: SiftBuild | undefined;

    if (want) {
      const connection = await activeConnection(settingsFileFor(user.id));
      if (!connection) throw new InputError('no model connection yet — add one in Model, or leave the task empty');

      const session = await sessionForRobot(user.id, account);
      const sample = await runTelegramRobot(
        { ...robots[0]!, channels, limit: Math.min(limit, 120), contains: [] },
        session,
      );
      if (sample.reason) throw new InputError(`could not read those channels: ${sample.reason}`);

      sifting = await buildSift({
        sample: sample.rows,
        want,
        apiKey: connection.key,
        model: connection.model,
        baseUrl: connection.baseUrl,
      });
      if (sifting.sift) for (const robot of robots) robot.sift = { ...sifting.sift };

      log(sifting.sift ? 'info' : 'warn', 'sift built', {
        robots: robots.map((robot) => robot.name).join(', '),
        user: user.id,
        sampled: sample.rows.length,
        kept: sifting.attempts.at(-1)?.kept ?? 0,
        calls: sifting.usage.calls,
        ...(sifting.reason ? { why: sifting.reason } : {}),
      });
    }

    const saved: string[] = [];
    for (const robot of robots) saved.push(await createRobot(robot, robotsDirFor(user.id)));

    return {
      saved,
      robots,
      robot: robots[0],
      ...(sifting
        ? {
            sift: {
              built: Boolean(sifting.sift),
              attempts: sifting.attempts,
              usage: sifting.usage,
              ...(sifting.reason ? { reason: sifting.reason } : {}),
            },
          }
        : {}),
    };
  },

  '/api/draft': async (body, user) => {
    const url = String(body['url']);
    const name = String(body['name'] || new URL(url).hostname.replace(/^www\./, '').split('.')[0]);
    const proxy = body['proxy'] ? String(body['proxy']) : undefined;
    return pool.use(poolKey(user.id, proxy), async (session) => {
      const draft = await draftScenario(session.page, { url, name, rules });
      if (draft.scenario) await createRobot({ ...draft.scenario, ...(proxy ? { proxy } : {}) }, robotsDirFor(user.id));
      return draft;
    });
  },
};

/** One way to put a question to a model, shared by everything here that needs to ask one. */
function askModel(connection: { key: string; model: string; baseUrl: string }): Ask {
  return async (messages) => {
    const response = await fetch(`${connection.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${connection.key}`, 'x-title': 'ratatosk' },
      body: JSON.stringify({ model: connection.model, messages, temperature: 0 }),
    });
    if (!response.ok) throw new Error(`the model answered ${response.status}`);
    const body = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    return { content: body.choices?.[0]?.message?.content ?? '', ...(body.usage ? { usage: body.usage } : {}) };
  };
}

/** A rule as it arrives from a browser: patterns as text, checked before anything is done with them. */
function readRule(input: unknown): Sift {
  const given = (input ?? {}) as Partial<Sift> & { judge?: { want?: string; maxRows?: number } | boolean };
  const lines = (value: unknown): string[] =>
    Array.isArray(value) ? value.map(String).map((line) => line.trim()).filter(Boolean) : [];

  const want = typeof given.want === 'string' ? given.want : undefined;
  return {
    ...(want ? { want } : {}),
    keep: lines(given.keep),
    ...(lines(given.drop).length ? { drop: lines(given.drop) } : {}),
    ...(given.from ? { from: String(given.from) } : {}),
    ...(given.fields && typeof given.fields === 'object' ? { fields: given.fields as Sift['fields'] } : {}),
    ...(given.judge
      ? {
          judge: {
            want: (typeof given.judge === 'object' && given.judge.want) || want || '',
            maxRows: (typeof given.judge === 'object' && Number(given.judge.maxRows)) || 40,
          },
        }
      : {}),
  };
}

/**
 * Material to try a rule on, collected now rather than remembered: a rule is judged against what the
 * source is saying today. A page is walked as the robot walks it; a channel is read as the robot reads
 * it — and in both cases without the rule, because the point is to see what it would do.
 */
async function freshRows(
  robot: Awaited<ReturnType<typeof loadRobot>>,
  userId: string,
): Promise<{ rows: Array<Record<string, string | null>> }> {
  if (isTelegramRobot(robot)) {
    const session = await sessionForRobot(userId, robot.account);
    const read = await runTelegramRobot({ ...robot, contains: [] }, session);
    if (read.reason) throw new InputError(`could not read those channels: ${read.reason}`);
    return { rows: read.rows };
  }

  const bare = { ...robot } as typeof robot & { sift?: unknown };
  delete bare.sift;
  const run = await pool.use(poolKey(userId, robot.proxy), (session) =>
    runRobot(bare, { page: async () => session.page, rules, maxPages: 2 }),
  );
  if (run.status === 'broken') throw new InputError(`the robot itself is broken: ${run.reason ?? ''}`);
  return { rows: run.rows };
}

/** Two addresses on the same site, whatever the path says. */
function sameHost(url: string, host: string): boolean {
  try {
    return new URL(url).hostname === host;
  } catch {
    return false;
  }
}

/** The account a machine's key belongs to, or nothing anyone can use. */
async function byKey(key: string): Promise<Caller> {
  const owner = await whoseKey(key, await userIds());
  if (!owner) throw new AuthError('that key is not one of ours, or it was revoked');
  const user = await findUser(owner);
  if (!user) throw new AuthError('that key belongs to an account that no longer exists');
  return { id: user.id, email: user.email };
}

/** One JSON body, read to the end. The api routes have their own; this is for everything else. */
async function collect(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return chunks.length ? (JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>) : {};
}

/** What this installation's Chromium calls itself, asked once and remembered. */
let userAgentSeen: string | undefined;
async function robotUserAgent(): Promise<string | null> {
  if (userAgentSeen) return userAgentSeen;
  const session = await openBrowser({ headless: true, profileDir: '' }).catch(() => undefined);
  if (!session?.userAgent) return null;
  try {
    userAgentSeen = await session.userAgent();
    return userAgentSeen;
  } finally {
    await session.close().catch(() => undefined);
  }
}

const server = createServer((request: IncomingMessage, response: ServerResponse) => {
  const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);

  // Watching the taken-over tab and touching it. The token in the path is the credential here too.
  if (url.pathname.startsWith('/live/')) {
    const [, , token, what] = url.pathname.split('/');
    const stream = token ? liveStream(token) : undefined;
    liveLog('asked', { what: what ?? 'the viewer', token: (token ?? '').slice(0, 6), known: Boolean(stream) });
    if (!stream) {
      response.writeHead(404, { 'content-type': 'text/plain' }).end('that session is over');
      return;
    }

    if (!what) {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(viewerPage(token!, findTakeover(token!)?.url ?? ''));
      return;
    }

    // One frame, held until the page repaints. A long poll rather than an endless response: the
    // endless one never survived the proxy in front of this server.
    if (what === 'frame') {
      const since = Number(url.searchParams.get('since') ?? 0);
      const asked = Date.now();
      nextFrame(token!, Number.isFinite(since) ? since : 0).then(
        (frame) => {
          liveLog('answering', { since, ms: Date.now() - asked, frame: frame ? frame.seq : 'nothing new' });
          if (!frame) {
            response.writeHead(204, { 'cache-control': 'no-store' }).end();
            return;
          }
          const body = Buffer.from(frame.data, 'base64');
          response.writeHead(200, {
            'content-type': 'image/jpeg',
            'content-length': body.length,
            'cache-control': 'no-store',
            'x-seq': String(frame.seq),
            'x-frame-width': String(frame.width),
            'x-frame-height': String(frame.height),
          });
          response.end(body);
        },
        (error) => {
          liveLog('the frame request failed', { why: String(error).slice(0, 140) });
          response.writeHead(503, { 'content-type': 'text/plain' }).end('no frame');
        },
      );
      return;
    }

    // Done here: close the browser and write the profile, without going back to the other tab. The
    // token is the credential, the same as it is for the frames.
    if (what === 'done') {
      liveLog('done, closing', { token: (token ?? '').slice(0, 6) });
      void stopTakeover(token!).then(
        () => response.writeHead(200, { 'content-type': 'application/json' }).end('{"saved":true}'),
        () => response.writeHead(500, { 'content-type': 'application/json' }).end('{"saved":false}'),
      );
      return;
    }

    if (what === 'input') {
      collect(request).then(
        async (body) => {
          const control = stream.control;
          const at = { x: Number(body['x'] ?? 0), y: Number(body['y'] ?? 0) };
          if (body['type'] === 'press') await control.press(at.x, at.y);
          else if (body['type'] === 'down') await control.down(at.x, at.y);
          else if (body['type'] === 'move') await control.move(at.x, at.y, Boolean(body['held']));
          else if (body['type'] === 'up') await control.up(at.x, at.y);
          else if (body['type'] === 'wheel') await control.wheel(at.x, at.y, Number(body['dy'] ?? 0));
          else if (body['type'] === 'write') await control.write(String(body['text'] ?? ''));
          else if (body['type'] === 'key') await control.key(String(body['name'] ?? ''));
          response.writeHead(200, { 'content-type': 'application/json' }).end('{"done":true}');
        },
        () => response.writeHead(400).end('{"error":"bad input"}'),
      );
      return;
    }

    response.writeHead(404).end('no');
    return;
  }

  // The viewer for a taken-over browser. The token in the path is the credential: a websocket cannot
  // carry an Authorization header, and this one is eighteen random bytes handed to one account only.
  if (url.pathname.startsWith('/vnc/')) {
    const [, , token, ...rest] = url.pathname.split('/');
    const takeover = token ? findTakeover(token) : undefined;
    if (!takeover) {
      response.writeHead(404, { 'content-type': 'text/plain' }).end('that session is over');
      return;
    }
    forward(takeover.webPort, `/${rest.join('/')}${url.search}`, request, response);
    return;
  }

  if (!url.pathname.startsWith('/api/')) {
    void serveStatic(url.pathname, response);
    return;
  }

  const open = publicRoutes[url.pathname];
  const guarded = routes[url.pathname];
  if (!open && !guarded) {
    response.writeHead(404, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: `no such endpoint: ${url.pathname}` }));
    return;
  }

  const chunks: Buffer[] = [];
  request.on('data', (chunk: Buffer) => chunks.push(chunk));
  request.on('end', () => {
    let body: Record<string, unknown> = {};
    try {
      if (chunks.length) body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
    } catch {
      response.writeHead(400, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: 'body is not valid JSON' }));
      return;
    }

    const started = Date.now();
    let who = 'nobody';
    const answer = (async () => {
      if (open) return open(body);
      const header = request.headers.authorization ?? '';
      const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
      if (!token) throw new AuthError('sign in first');

      // Two kinds of caller, one door. A person carries a token that expires; a schedule carries a key
      // that does not, because an automation set up today should not stop working in a month.
      const user = looksLikeKey(token) ? await byKey(token) : await verifyToken(token);
      who = user.id;
      return guarded!(body, user);
    })();

    answer.then(
      (value) => {
        info('api', { path: url.pathname, user: who, ms: Date.now() - started });
        response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
        response.end(JSON.stringify(value));
      },
      (error: unknown) => {
        // The message is the product here: whoever is looking at this needs to know what to do next.
        const status = error instanceof AuthError ? 401 : error instanceof InputError ? 400 : 500;
        // Refused input is the ordinary business of an interface; a 500 is ours to answer for.
        const detail = { path: url.pathname, user: who, status, ms: Date.now() - started };
        if (status === 500) failure('api failed', error, detail);
        else warn('api refused', { ...detail, why: error instanceof Error ? error.message.slice(0, 200) : String(error) });
        response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
        response.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
      },
    );
  });
});

/**
 * Hand one request on to the viewer running beside us, and hand its answer back. Ordinary requests
 * are forwarded as requests; a websocket upgrade is forwarded as bytes, because at that point the
 * two ends are talking a protocol this server has no business understanding.
 */
function forward(port: number, path: string, request: IncomingMessage, response: ServerResponse): void {
  const upstream = httpRequest(
    { host: '127.0.0.1', port, path, method: request.method ?? 'GET', headers: request.headers },
    (answer) => {
      response.writeHead(answer.statusCode ?? 502, answer.headers);
      answer.pipe(response);
    },
  );
  upstream.on('error', () => response.writeHead(502, { 'content-type': 'text/plain' }).end('the viewer is not answering'));
  request.pipe(upstream);
}

server.on('upgrade', (request, socket, head) => {
  const path = request.url ?? '/';
  const [, , token, ...rest] = path.split('?')[0]!.split('/');
  const takeover = token ? findTakeover(token) : undefined;
  if (!path.startsWith('/vnc/') || !takeover) {
    socket.destroy();
    return;
  }

  const upstream = connect({ host: '127.0.0.1', port: takeover.webPort }, () => {
    const query = path.includes('?') ? `?${path.split('?')[1]}` : '';
    const headers = Object.entries(request.headers)
      .map(([name, value]) => `${name}: ${Array.isArray(value) ? value.join(', ') : value}\r\n`)
      .join('');
    upstream.write(`GET /${rest.join('/')}${query} HTTP/1.1\r\n${headers}\r\n`);
    if (head?.length) upstream.write(head);
    upstream.pipe(socket);
    socket.pipe(upstream);
  });
  upstream.on('error', () => socket.destroy());
  socket.on('error', () => upstream.destroy());
});

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

const PUBLIC_DIR = resolve(process.env['RATATOSK_PUBLIC'] ?? 'public');
const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
};

/** The built front-end, handed out as files. Paths are resolved and checked: nothing outside public/. */
async function serveStatic(pathname: string, response: ServerResponse): Promise<void> {
  const wanted = pathname === '/' ? '/index.html' : pathname;
  const file = resolve(joinPath(PUBLIC_DIR, normalize(wanted)));

  if (!file.startsWith(PUBLIC_DIR)) {
    response.writeHead(403).end('no');
    return;
  }

  try {
    const body = await readFile(file);
    response.writeHead(200, {
      'content-type': CONTENT_TYPES[extname(file)] ?? 'application/octet-stream',
      // The front-end is three files with fixed names, so a cached copy outlives every deploy and the
      // page keeps missing whatever was just added. Revalidating costs one round trip and no guessing.
      'cache-control': 'no-cache',
    });
    response.end(body);
  } catch {
    response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    response.end('not found — has the front-end been built? npm run build');
  }
}

async function adoptExistingRobots(into: string): Promise<void> {
  const root = process.env['RATATOSK_ROBOTS'] ?? 'robots';
  try {
    const names = (await readdir(root)).filter((name) => name.endsWith('.json'));
    if (names.length === 0) return;
    await mkdir(into, { recursive: true });
    for (const name of names) await rename(join(root, name), join(into, name)).catch(() => undefined);
    console.log(`moved ${names.length} existing robot(s) into the first account`);
  } catch {
    // No robots to adopt is the normal case for a fresh install.
  }
}

async function loadRules(dir: string): Promise<SiteRule[]> {
  try {
    const names = await readdir(dir);
    const files = names.filter((file) => file.endsWith('.json'));
    return await Promise.all(files.map(async (file) => JSON.parse(await readFile(join(dir, file), 'utf8')) as SiteRule));
  } catch {
    return [];
  }
}

/**
 * A browser can fail in ways that surface as an unhandled rejection, and a web server that dies from
 * one bad page is worse than one that answers "that failed". The browser is dropped so the next
 * request starts a fresh one.
 */
process.on('unhandledRejection', (reason) => {
  console.error('unhandled rejection:', reason instanceof Error ? reason.message : reason);
});
process.on('uncaughtException', (error) => {
  console.error('uncaught exception:', error.message);
});

const shutdown = async () => {
  server.close();
  await pool.closeAll();
  await stopAllTakeovers();
  await closeBridges();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

rules = await loadRules('rules');
server.listen(PORT, HOST, () => console.log(`ratatosk web on http://${HOST}:${PORT}`));
