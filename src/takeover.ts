import { randomBytes } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { connect } from 'node:net';
import { openBrowser, type BrowserSession } from './drivers/patchright.js';
import { forgetLive, rememberLive } from './live-view.js';
import { InputError } from './errors.js';

/**
 * Handing the browser to a person for a minute.
 *
 * Some doors are meant for a human and stay that way: a check that asks whether you are one, a login,
 * a consent screen, an age gate. A robot has no business getting past those on its own, and this is
 * not an attempt to — it is the opposite. The browser the robot uses is put on a screen the account's
 * owner can reach, they do the thing themselves, and what the site leaves behind stays in that
 * profile, so the robot's next run is simply a returning visitor.
 *
 * A screen per session, not one shared one: several accounts run browsers in this container at the
 * same time, and a shared display would show each of them the others' pages. Everything listens on
 * loopback — the way in is the web server, which knows who is asking.
 */
export interface Takeover {
  /** Random, unguessable, and part of the URL: the websocket cannot carry an Authorization header. */
  token: string;
  userId: string;
  display: number;
  vncPort: number;
  webPort: number;
  url: string;
  /** Whose door this is, when it was opened from a scraper's card. Runs when the session is saved. */
  scraper?: string;
  startedAt: number;
  expiresAt: number;
  session: BrowserSession;
  processes: ChildProcess[];
}

const sessions = new Map<string, Takeover>();

/** How long a session may stand idle before it is taken down. Long enough to read a page, no longer. */
const LIFETIME_MS = Number(process.env['RATATOSK_TAKEOVER_MS'] ?? 15 * 60_000);

export function findTakeover(token: string): Takeover | undefined {
  return sessions.get(token);
}

export function takeoversOf(userId: string): Takeover[] {
  return [...sessions.values()].filter((session) => session.userId === userId);
}

export async function startTakeover(input: {
  userId: string;
  url: string;
  scraper?: string;
  profileDir: string;
  proxy?: { server: string; username?: string; password?: string };
}): Promise<Takeover> {
  if (!/^https?:\/\//.test(input.url)) throw new InputError('a takeover needs an http(s) address');

  // One person, one screen: a second one for the same account would fight the first over the profile.
  for (const existing of takeoversOf(input.userId)) await stopTakeover(existing.token);

  const display = 100 + Math.floor(Math.random() * 400);
  const vncPort = 5900 + (display - 100);
  const webPort = 6900 + (display - 100);
  const token = randomBytes(18).toString('base64url');
  const processes: ChildProcess[] = [];

  // A smaller screen at sixteen bits is a third of the pixels to push, and nobody is watching a film.
  const screen = spawn('Xvfb', [`:${display}`, '-screen', '0', '1280x800x16', '-nolisten', 'tcp'], {
    stdio: 'ignore',
  });
  processes.push(screen);
  await waitFor(() => reachable(`/tmp/.X11-unix/X${display}`), 5000, 'the screen never came up');

  let session: BrowserSession;
  try {
    session = await openBrowser({
      profileDir: input.profileDir,
      display: `:${display}`,
      ...(input.proxy ? { proxy: input.proxy } : {}),
    });
  } catch (error) {
    for (const process_ of processes) process_.kill();
    throw error;
  }

  try {
    await session.page.goto(input.url);
  } catch {
    // A page that will not load is exactly what someone may be taking over to deal with.
  }

  // -localhost and -nopw together are only safe because nothing but the web server can reach this
  // port, and the web server checks who is asking before it forwards a single byte.
  //
  // The rest is what makes it usable rather than a slideshow. X DAMAGE is how the server learns which
  // part of the screen changed; without it x11vnc compares whole frames and burns a core to send five
  // of them a second. -threads keeps reading the screen from blocking on the network, and a short
  // defer sends small changes immediately, which is what a moving cursor is made of.
  processes.push(
    spawn(
      'x11vnc',
      [
        '-display', `:${display}`,
        '-rfbport', String(vncPort),
        '-localhost', '-nopw', '-forever', '-shared', '-quiet',
        '-threads',
        '-defer', '5',
        '-wait', '5',
        '-speeds', 'dsl',
      ],
      { stdio: 'ignore' },
    ),
  );
  await waitFor(() => listening(vncPort), 8000, 'the screen sharing never started');

  processes.push(
    spawn('websockify', ['--web', '/usr/share/novnc', `127.0.0.1:${webPort}`, `127.0.0.1:${vncPort}`], {
      stdio: 'ignore',
    }),
  );
  await waitFor(() => listening(webPort), 8000, 'the viewer never started');

  const takeover: Takeover = {
    token,
    userId: input.userId,
    display,
    vncPort,
    webPort,
    url: input.url,
    ...(input.scraper ? { scraper: input.scraper } : {}),
    startedAt: Date.now(),
    expiresAt: Date.now() + LIFETIME_MS,
    session,
    processes,
  };
  // Watching the tab itself, rather than the screen it happens to be drawn on. This is the way in that
  // survives a long wire; the VNC above stays for the rare case of needing the whole desktop.
  if (session.live) rememberLive(token, await session.live());

  sessions.set(token, takeover);
  setTimeout(() => void stopTakeover(token), LIFETIME_MS).unref();
  return takeover;
}

export async function stopTakeover(token: string): Promise<void> {
  const takeover = sessions.get(token);
  if (!takeover) return;
  sessions.delete(token);
  await forgetLive(token);

  // The browser first: closing it writes the profile, which is the whole point of the exercise.
  await takeover.session.close().catch(() => undefined);
  for (const process_ of takeover.processes.reverse()) process_.kill();
}

export async function stopAllTakeovers(): Promise<void> {
  await Promise.all([...sessions.keys()].map((token) => stopTakeover(token)));
}

async function waitFor(check: () => Promise<boolean>, timeoutMs: number, complaint: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(complaint);
}

async function listening(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host: '127.0.0.1', port });
    socket.on('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.on('error', () => resolve(false));
  });
}

async function reachable(path: string): Promise<boolean> {
  const { access } = await import('node:fs/promises');
  return access(path).then(
    () => true,
    () => false,
  );
}
