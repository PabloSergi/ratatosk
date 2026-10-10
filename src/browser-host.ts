import { spawn } from 'node:child_process';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createServer as createRelay, connect, type Server as TcpServer } from 'node:net';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';

import { chromium, type BrowserContext } from 'patchright';

import { debug, info, warn } from './log.js';
import { toRunningBrowserUrl } from './proxies.js';

/**
 * The browsers, kept where deploys cannot reach them.
 *
 * What a site decides about a visitor is not all in the cookie jar. A managed challenge passed once
 * leaves the rest of its answer in the running browser — its fingerprint, its TLS session, the state
 * of the very process — and closing that process throws it away. Which is fine, until the browser
 * lives inside the container that holds the code: then every deploy, of anything, costs a pass that a
 * person sat down and gave by hand.
 *
 * So the browsers live here, in a container of their own that is built once and left alone. The web
 * service and the worker connect to them over the devtools protocol, do their work in a tab of their
 * own, and disconnect. Restarting either of them is invisible from the site's side of the wire.
 *
 * One browser per profile directory, because that is what a profile is: an identity, and Chromium
 * refuses to run two of itself on one. The profiles are on a shared volume, so the path names the
 * same thing on both sides of this connection.
 */
interface Running {
  context: BrowserContext;
  /** What the callers dial. See relayTo: it is not the browser's own port, and it cannot be. */
  port: number;
  relay: TcpServer;
  since: number;
  proxy?: string;
}

const running = new Map<string, Running>();
const FIRST_PORT = Number(process.env['RATATOSK_BROWSER_PORT_FROM'] ?? 9222);
/** The browser's own ports and the ones handed out, kept apart so neither can wander into the other. */
const RELAY_OFFSET = 100;

function freePort(): number {
  const taken = new Set([...running.values()].map((one) => one.port - RELAY_OFFSET));
  for (let port = FIRST_PORT; port < FIRST_PORT + RELAY_OFFSET; port += 1) if (!taken.has(port)) return port;
  throw new Error('no port left for another browser');
}

/**
 * A door onto the browser's debugging port, because the browser will not open one itself.
 *
 * Chromium binds that port to loopback and keeps it there — `--remote-debugging-address` is ignored,
 * which is a defence against a page on the internet reaching the browser that is showing it. Loopback
 * here is this container, and the callers are in the ones next door, so without this every one of them
 * quietly started a browser of its own and this service sat looking healthy. Measured both ways: the
 * port refused from outside, and answered through the relay.
 *
 * Nothing is published beyond the compose network, so what this opens is a door in an inside wall.
 */
async function relayTo(debugPort: number, on: number): Promise<TcpServer> {
  const relay = createRelay((incoming) => {
    const upstream = connect({ host: '127.0.0.1', port: debugPort }, () => {
      incoming.pipe(upstream).pipe(incoming);
    });
    upstream.on('error', () => incoming.destroy());
    incoming.on('error', () => upstream.destroy());
  });
  // Waited for, not fired off. Answering "here is the port" before the port is listening is a race
  // that the caller loses by thirty milliseconds and reads as "the host has no browser for me" —
  // which sends it off to start one of its own, silently, every single time.
  await new Promise<void>((listening) => relay.listen(on, '0.0.0.0', listening));
  return relay;
}

/**
 * The screen, alive — checked every time, because it is not always.
 *
 * A headed browser needs an X server, and the one here is started by the container's entrypoint and
 * then forgotten about. When it dies the container stays up, the health check stays green, node keeps
 * answering, and every browser launched from then on fails in a second with a message nobody reads.
 * That happened: two days of every scrape failing, because a screen started in the background in a
 * shell script has nobody to notice it is gone.
 *
 * So the screen belongs to whoever needs it. Its socket existing proves nothing — a dead server leaves
 * one behind and the lock file with it, which is also why it never came back on its own.
 */
const SCREEN = process.env['DISPLAY'] ?? ':99';

async function answers(display: string): Promise<boolean> {
  const socket = `/tmp/.X11-unix/X${display.replace(':', '')}`;
  return new Promise((resolve) => {
    const probe = connect(socket);
    probe.on('connect', () => {
      probe.destroy();
      resolve(true);
    });
    probe.on('error', () => resolve(false));
  });
}

async function ensureScreen(): Promise<void> {
  // Only where a browser needs one. A Mac or a Windows machine draws headed windows by itself, and
  // going looking for an X server there fails for a reason that has nothing to do with anything.
  if (process.platform !== 'linux') return;
  if (await answers(SCREEN)) return;

  // What a dead server left behind. Xvfb refuses to start while the lock is there, which turns one
  // crash into a permanent one.
  const number = SCREEN.replace(':', '');
  await Promise.all([
    rm(`/tmp/.X${number}-lock`, { force: true }).catch(() => undefined),
    rm(`/tmp/.X11-unix/X${number}`, { force: true }).catch(() => undefined),
  ]);

  warn('browser host: the screen was gone; starting one', { display: SCREEN });
  spawn('Xvfb', [SCREEN, '-screen', '0', '1920x1080x24', '-nolisten', 'tcp'], { stdio: 'ignore', detached: true }).unref();

  for (let wait = 0; wait < 50; wait += 1) {
    if (await answers(SCREEN)) return;
    await new Promise((settled) => setTimeout(settled, 200));
  }
  throw new Error('the screen would not start');
}

/**
 * The browser for a profile, started if it is not already up.
 *
 * Headed under Xvfb, like everywhere else in this product: headless is the tell that turns a page
 * into a challenge. The remote debugging port is what the rest of the system connects to.
 */
async function browserFor(profileDir: string, proxyUrl?: string): Promise<Running> {
  // The way out, made dialable HERE. A SOCKS5 proxy with a password needs a bridge, and a bridge is a
  // listener on loopback — which is this container's loopback, not the caller's. So what arrives is
  // the proxy as configured, and it is turned into settings on this side of the wire.
  await ensureScreen();
  const proxy = proxyUrl ? await toRunningBrowserUrl(proxyUrl) : undefined;
  const already = running.get(profileDir);
  if (already) {
    // A browser that died on its own — a crash, an out-of-memory — must not be handed out as if it
    // were alive; the caller would connect to a closed port and read it as their own fault.
    if (already.context.browser()?.isConnected() !== false) {
      await reapAbandonedPages(already);
      return already;
    }
    running.delete(profileDir);
  }

  const debugPort = freePort();
  const port = debugPort + RELAY_OFFSET;
  const launch = (): Promise<BrowserContext> =>
    chromium.launchPersistentContext(profileDir, {
      headless: false,
      viewport: null,
      args: [
        '--no-sandbox',
        `--remote-debugging-port=${debugPort}`,
        '--remote-allow-origins=*',
      ],
          env: { ...process.env, DISPLAY: SCREEN },
      ...(proxy ? { proxy } : {}),
    });

  let context: BrowserContext;
  try {
    context = await launch();
  } catch (error) {
    // The locks of a browser killed rather than closed. They describe a process that no longer
    // exists, and keeping them means losing the profile — which is the one thing worth keeping here.
    await Promise.all(
      ['SingletonLock', 'SingletonCookie', 'SingletonSocket'].map((lock) =>
        rm(join(profileDir, lock), { force: true }).catch(() => undefined),
      ),
    );
    context = await launch();
    debug('browser host: cleared the locks of a profile', { profileDir, why: (error as Error).message.split('\n')[0] });
  }

  const started: Running = {
    context,
    port,
    relay: await relayTo(debugPort, port),
    since: Date.now(),
    ...(proxyUrl ? { proxy: hostOf(proxyUrl) } : {}),
  };
  running.set(profileDir, started);
  info('browser host: a browser is up', { profileDir, port, debugPort, proxy: proxyUrl ? hostOf(proxyUrl) : 'direct' });
  return started;
}

/**
 * How many pages one browser may be carrying before some of them are nobody's.
 *
 * A page here outlives the process that opened it. A worker holds one per hand, the web service takes
 * one for a check, a takeover takes another — and when any of those restarts, its page stays open in
 * this browser with nobody on the other end. Nothing cleans it up: the side that could close it is
 * the side that went away.
 *
 * Measured, after a day of deploys: twenty-eight pages across two browsers, none of them being
 * driven, one Chromium wedged badly enough that every run against it failed. So the count is bounded
 * here. Closing the oldest is safe because by the time there are more than this, the oldest are
 * leftovers — nothing on this side is holding that many at once.
 *
 * The number is what a page COSTS, not what a caller might want. A loaded page is about half a
 * gigabyte, so twelve of them is six — the whole of this container's allowance, and the browser then
 * sits pinned at its limit while everything else on the host swaps. That is not a Ratatosk problem
 * on its own and it is a bad neighbour: a translation service on the same machine, with its own
 * memory and its own limit, took ten minutes over a batch of twenty-four and timed out.
 *
 * This bounds the leak; it does not cure it. The cure is for a page to be closed by whoever opened it,
 * including when that side dies, and that belongs on the other end of the wire.
 */
const PAGES_KEPT = 4;

async function reapAbandonedPages(one: Running): Promise<void> {
  const pages = one.context.pages();
  if (pages.length <= PAGES_KEPT) return;

  // Creation order, so the front of the list is the oldest.
  const stale = pages.slice(0, pages.length - PAGES_KEPT);
  await Promise.all(stale.map((page) => page.close().catch(() => undefined)));
  warn('browser host: closed pages nobody was driving', { left: one.context.pages().length, closed: stale.length });
}

async function stop(profileDir: string): Promise<boolean> {
  const one = running.get(profileDir);
  if (!one) return false;
  running.delete(profileDir);
  one.relay.close();
  await one.context.close().catch(() => undefined);
  info('browser host: a browser was closed', { profileDir });
  return true;
}

/** The proxy in the log and in the listing: which one it is, never how to use it. */
function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return 'a proxy';
  }
}

function collect(request: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let body = '';
    request.on('data', (chunk) => {
      body += chunk;
      if (body.length > 64_000) reject(new Error('too much'));
    });
    request.on('end', () => {
      try {
        resolve(body ? (JSON.parse(body) as Record<string, unknown>) : {});
      } catch {
        reject(new Error('not json'));
      }
    });
    request.on('error', reject);
  });
}

const server = createServer((request: IncomingMessage, response: ServerResponse) => {
  const answer = (code: number, body: unknown): void => {
    response.writeHead(code, { 'content-type': 'application/json' }).end(JSON.stringify(body));
  };
  const url = new URL(request.url ?? '/', 'http://host');

  if (url.pathname === '/browsers') {
    answer(200, {
      browsers: [...running.entries()].map(([profileDir, one]) => ({
        profileDir,
        port: one.port,
        since: new Date(one.since).toISOString(),
        proxy: one.proxy ?? 'direct',
        pages: one.context.pages().length,
      })),
    });
    return;
  }

  if (url.pathname === '/open') {
    void collect(request).then(
      async (body) => {
        const profileDir = String(body['profileDir'] ?? '');
        if (!profileDir) return answer(400, { error: 'a browser is asked for by its profile' });
        try {
          const one = await browserFor(profileDir, body['proxyUrl'] ? String(body['proxyUrl']) : undefined);
          answer(200, { port: one.port, since: new Date(one.since).toISOString() });
        } catch (error) {
          // Said out loud as well as answered. The caller writes "the host gave nothing" and carries
          // on; the reason it gave nothing has to be somewhere, or the next person asks it by hand.
          const why = (error as Error).message.split('\n')[0]!;
          warn('browser host: could not start a browser', { profileDir, why });
          answer(500, { error: why });
        }
      },
      () => answer(400, { error: 'bad input' }),
    );
    return;
  }

  if (url.pathname === '/close') {
    void collect(request).then(
      async (body) => answer(200, { closed: await stop(String(body['profileDir'] ?? '')) }),
      () => answer(400, { error: 'bad input' }),
    );
    return;
  }

  answer(404, { error: 'no such thing here' });
});

const port = Number(process.env['RATATOSK_BROWSER_HOST_PORT'] ?? 5546);
server.listen(port, process.env['HOST'] ?? '0.0.0.0', () => {
  info('browser host listening', { port, display: process.env['DISPLAY'] ?? ':99' });
});

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    // Closing them properly writes the profiles. This is the one shutdown where that matters, because
    // it is the only one that ever happens to these browsers.
    void Promise.all([...running.keys()].map(stop)).then(() => process.exit(0));
  });
}
