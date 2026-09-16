import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';

import { chromium, type BrowserContext } from 'patchright';

import { debug, info } from './log.js';
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
  port: number;
  since: number;
  proxy?: string;
}

const running = new Map<string, Running>();
const FIRST_PORT = Number(process.env['RATATOSK_BROWSER_PORT_FROM'] ?? 9222);

function freePort(): number {
  const taken = new Set([...running.values()].map((one) => one.port));
  for (let port = FIRST_PORT; port < FIRST_PORT + 200; port += 1) if (!taken.has(port)) return port;
  throw new Error('no port left for another browser');
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
  const proxy = proxyUrl ? await toRunningBrowserUrl(proxyUrl) : undefined;
  const already = running.get(profileDir);
  if (already) {
    // A browser that died on its own — a crash, an out-of-memory — must not be handed out as if it
    // were alive; the caller would connect to a closed port and read it as their own fault.
    if (already.context.browser()?.isConnected() !== false) return already;
    running.delete(profileDir);
  }

  const port = freePort();
  const launch = (): Promise<BrowserContext> =>
    chromium.launchPersistentContext(profileDir, {
      headless: false,
      viewport: null,
      args: ['--no-sandbox', `--remote-debugging-port=${port}`, '--remote-allow-origins=*'],
      env: { ...process.env, DISPLAY: process.env['DISPLAY'] ?? ':99' },
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

  const started: Running = { context, port, since: Date.now(), ...(proxyUrl ? { proxy: hostOf(proxyUrl) } : {}) };
  running.set(profileDir, started);
  info('browser host: a browser is up', { profileDir, port, proxy: proxyUrl ? hostOf(proxyUrl) : 'direct' });
  return started;
}

async function stop(profileDir: string): Promise<boolean> {
  const one = running.get(profileDir);
  if (!one) return false;
  running.delete(profileDir);
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
          answer(500, { error: (error as Error).message.split('\n')[0] });
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
