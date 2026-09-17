import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium, type Browser, type BrowserContext, type Page } from 'patchright';
import type { PageDriver } from '../driver.js';
import { warn } from '../log.js';

/**
 * The only file that knows a real browser exists.
 *
 * One masking layer and no more: patchright already gives a consistent fingerprint, so we add no
 * injector of our own and no User-Agent of our own — a hardcoded one is two years out of date within
 * two years, and it fights the browser it rides on.
 */
/**
 * Watching a page and touching it, without a screen in between.
 *
 * A remote desktop sends pixels and expects a mouse to chase them; over a long wire that means missing
 * what you aimed at. This sends frames of the tab itself and takes back coordinates — you press where
 * you saw the thing, and the press lands there whatever the picture is doing.
 */
export interface LiveControl {
  /**
   * One picture of the tab, base64 JPEG, with the size it was taken at.
   *
   * Taken rather than streamed on purpose. Chromium's screencast sends what the page's own process
   * paints, and a frame from another site is painted by another process: a security check inside a
   * login page — the exact thing this view exists for — arrives as a white rectangle. Measured, not
   * assumed: the same page gave a blank box in the screencast and the whole widget in a screenshot.
   */
  still(): Promise<{ data: string; width: number; height: number } | undefined>;
  press(x: number, y: number): Promise<void>;
  /** A press held, moved and let go — a scrollbar thumb, a slider, anything drawn to be dragged. */
  down(x: number, y: number): Promise<void>;
  move(x: number, y: number, held: boolean): Promise<void>;
  up(x: number, y: number): Promise<void>;
  wheel(x: number, y: number, dy: number): Promise<void>;
  write(text: string): Promise<void>;
  key(name: string, text?: string): Promise<void>;
  stop(): Promise<void>;
}

export interface BrowserSession {
  page: PageDriver;
  close(): Promise<void>;
  /** Present when this browser can be watched and touched — see LiveControl. */
  live?(): Promise<LiveControl>;
  /**
   * Put a session someone else already established into this profile. A gate that a person passed in
   * their own browser leaves a cookie; carrying that cookie here is what lets the robot walk through
   * the door that was opened for them, instead of knocking on it again.
   */
  setCookies?(cookies: unknown[]): Promise<void>;
  /** Drop everything this profile remembers about one site. Returns how much was dropped. */
  forgetSite?(host: string): Promise<number>;
  userAgent?(): Promise<string>;
}

/**
 * Headless is the tell. Cloudflare hands a headless Chromium the "Just a moment…" page and a real one
 * the site — measured, not assumed: the same URL answered 403 headless and 200 headed with 61 job
 * links. So in a container the browser runs headed inside Xvfb, and the profile is kept between runs
 * because a returning visitor is challenged less than a stranger.
 */
export interface ProxySettings {
  server: string;
  username?: string;
  password?: string;
}

export async function openBrowser(
  options: {
    headless?: boolean;
    profileDir?: string;
    proxy?: ProxySettings;
    /**
     * The way out as it was configured, credentials and all — for a browser started by somebody else.
     * A proxy that needs a bridge needs it raised beside the browser, and that is not this process.
     */
    proxyUrl?: string;
    display?: string;
  } = {},
): Promise<BrowserSession> {
  const headed = process.env['RATATOSK_HEADED'] === '1';
  const headless = options.headless ?? !headed;
  const profileDir = options.profileDir ?? process.env['RATATOSK_PROFILE'] ?? '';

  // A browser that outlives this process, if one is offered. See browser-host.ts: what a site decided
  // about a visitor is partly in the running browser, so the browser must not be restarted every time
  // the code is.
  const host = process.env['RATATOSK_BROWSER_HOST'];
  if (host && profileDir) {
    const connected = await connectThrough(host, profileDir, options.proxyUrl);
    if (connected) return connected;
    // Carrying on with a browser of our own, because a run is worth more than a principle — but said
    // out loud in the journal, because a silent fallback is indistinguishable from the thing working,
    // and what it costs is exactly what this service exists to keep.
    warn('the browser host gave nothing; starting a browser in this container instead', { host, profileDir });
  }
  // Which screen this browser appears on. Everything shares one by default; a browser someone is
  // about to take over gets its own, so no account is ever shown another account's pages.
  const env = options.display ? { env: { ...process.env, DISPLAY: options.display } } : {};

  if (profileDir) {
    // A profile that outlived an ungraceful shutdown keeps its lock files, and Chromium then refuses
    // to start with a message about a closed browser. Clearing the locks is safe — they describe a
    // process that no longer exists — and it beats losing the profile, which is what keeps a returning
    // visitor from being challenged again.
    const launch = () =>
      chromium.launchPersistentContext(profileDir, {
        headless,
        viewport: null,
        args: ['--no-sandbox'],
        ...env,
        ...(options.proxy ? { proxy: options.proxy } : {}),
      });

    let context;
    try {
      context = await launch();
    } catch (error) {
      await Promise.all(
        ['SingletonLock', 'SingletonCookie', 'SingletonSocket'].map((lock) =>
          rm(join(profileDir, lock), { force: true }).catch(() => undefined),
        ),
      );
      try {
        context = await launch();
      } catch {
        // Still no. A run without the profile is better than no run at all — say so in the log.
        console.error(`browser profile ${profileDir} is unusable, falling back to a clean session: ${(error as Error).message.split('\n')[0]}`);
        const browser: Browser = await chromium.launch({
          headless,
          args: ['--no-sandbox'],
          ...env,
          ...(options.proxy ? { proxy: options.proxy } : {}),
        });
        const fresh = await browser.newContext();
        const freshPage = await fresh.newPage();
        return {
          page: new PatchrightPage(freshPage),
          close: () => browser.close(),
          setCookies: async (cookies: unknown[]) => {
            await fresh.addCookies(cookies as Parameters<typeof fresh.addCookies>[0]);
          },
          userAgent: async () => freshPage.evaluate(() => navigator.userAgent),
        };
      }
    }

    const page = context.pages()[0] ?? (await context.newPage());
    return {
      page: new PatchrightPage(page),
      close: () => context.close(),
      live: () => liveControl(context, page),
      setCookies: async (cookies: unknown[]) => {
        await context.addCookies(cookies as Parameters<typeof context.addCookies>[0]);
      },
      // Clearing by hand rather than by filter: every version of this browser can empty the jar and
      // put back what was not meant to go, and not every version can be asked to remove one domain.
      forgetSite: async (host: string) => {
        const all = await context.cookies();
        const bare = host.replace(/^www\./, '');
        const keep = all.filter((cookie) => !cookie.domain.replace(/^\./, '').endsWith(bare));
        await context.clearCookies();
        if (keep.length) await context.addCookies(keep);
        return all.length - keep.length;
      },
      userAgent: async () => page.evaluate(() => navigator.userAgent),
    };
  }

  const browser: Browser = await chromium.launch({
    headless,
    args: ['--no-sandbox'],
    ...env,
    ...(options.proxy ? { proxy: options.proxy } : {}),
  });
  const context = await browser.newContext();
  const page = await context.newPage();
  return {
    page: new PatchrightPage(page),
    close: () => browser.close(),
    setCookies: async (cookies: unknown[]) => {
      await context.addCookies(cookies as Parameters<typeof context.addCookies>[0]);
    },
    userAgent: async () => page.evaluate(() => navigator.userAgent),
  };
}

/**
 * A browser somebody else is keeping alive, joined for the length of one run.
 *
 * Its own tab, closed at the end; the browser itself is left exactly as it was found. That asymmetry
 * is the whole point — `close()` here means "I am done", not "shut it down", and a caller cannot tell
 * the difference except that the next run is not challenged.
 */
async function connectThrough(host: string, profileDir: string, proxyUrl?: string): Promise<BrowserSession | undefined> {
  const asked = await fetch(new URL('/open', host), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ profileDir, ...(proxyUrl ? { proxyUrl } : {}) }),
  }).catch(() => undefined);
  if (!asked?.ok) return undefined;

  const { port } = (await asked.json()) as { port?: number };
  if (!port) return undefined;

  const where = `http://${new URL(host).hostname}:${port}`;
  // Twice, a moment apart: a browser that has only just been started is a browser whose port is only
  // just listening, and giving up on the first refusal means starting a second browser for nothing.
  let browser = await chromium.connectOverCDP(where).catch(() => undefined);
  if (!browser) {
    await new Promise((settle) => setTimeout(settle, 500));
    browser = await chromium.connectOverCDP(where).catch(() => undefined);
  }
  const context = browser?.contexts()[0];
  if (!browser || !context) return undefined;

  const page = await context.newPage();
  return {
    page: new PatchrightPage(page),
    close: async () => {
      await page.close().catch(() => undefined);
      await browser.close().catch(() => undefined); // disconnects; the browser is not ours to end
    },
    live: () => liveControl(context, page),
    setCookies: async (cookies: unknown[]) => {
      await context.addCookies(cookies as Parameters<typeof context.addCookies>[0]);
    },
    forgetSite: async (site: string) => {
      const all = await context.cookies();
      const bare = site.replace(/^www\./, '');
      const keep = all.filter((cookie) => !cookie.domain.replace(/^\./, '').endsWith(bare));
      await context.clearCookies();
      if (keep.length) await context.addCookies(keep);
      return all.length - keep.length;
    },
    userAgent: async () => page.evaluate(() => navigator.userAgent),
  };
}

class PatchrightPage implements PageDriver {
  constructor(private readonly page: Page) {}

  async goto(url: string): Promise<void> {
    await this.page.goto(url, { waitUntil: 'domcontentloaded' });
  }

  async currentUrl(): Promise<string> {
    return this.page.url();
  }

  /**
   * The engine hands us the source of a function. Playwright evaluates a string as an EXPRESSION and
   * never calls it, so a bare function source comes back as undefined — the argument has to be baked
   * into the expression instead. Everything crossing this line is JSON, in both directions.
   */
  async evaluate<T>(fn: string, arg?: unknown): Promise<T> {
    const expression = arg === undefined ? `(${fn})()` : `(${fn})(${JSON.stringify(arg)})`;
    return this.page.evaluate<T>(expression);
  }

  async click(selector: string): Promise<void> {
    await this.page.click(selector);
    await this.page.waitForLoadState('domcontentloaded');
  }

  async waitMs(ms: number): Promise<void> {
    await this.page.waitForTimeout(ms);
  }
}

/**
 * The devtools protocol, used for the two things a person needs: see the tab, and touch it.
 *
 * Coordinates are the whole point. The frame arrives with the size it was captured at; a press comes
 * back in that same space and is dispatched to the page unchanged. Nothing depends on where a cursor
 * happens to be, because there is no cursor — which is why this works over a wire that a remote
 * desktop makes unusable.
 */
async function liveControl(context: BrowserContext, page: Page): Promise<LiveControl> {
  const cdp = await context.newCDPSession(page);

  await cdp.send('Page.enable').catch(() => undefined);

  return {
    still: async () => {
      const shot = (await cdp.send('Page.captureScreenshot', { format: 'jpeg', quality: 42 }).catch(() => undefined)) as
        | { data: string }
        | undefined;
      if (!shot?.data) return undefined;
      const metrics = (await cdp.send('Page.getLayoutMetrics').catch(() => ({}))) as {
        cssVisualViewport?: { clientWidth: number; clientHeight: number };
      };
      return {
        data: shot.data,
        width: Math.round(metrics.cssVisualViewport?.clientWidth ?? 1200),
        height: Math.round(metrics.cssVisualViewport?.clientHeight ?? 760),
      };
    },

    press: async (x, y) => {
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none' });
      await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
    },

    down: async (x, y) => {
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none' });
      await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
    },

    // While a button is held, the page needs to be told so: buttons is the mask of what is down, and
    // without it a drag reads as a mouse merely passing over — which is why a thumb would not follow.
    move: async (x, y, held) => {
      await cdp.send('Input.dispatchMouseEvent', {
        type: 'mouseMoved',
        x,
        y,
        button: held ? 'left' : 'none',
        buttons: held ? 1 : 0,
      });
    },

    up: async (x, y) => {
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
    },

    wheel: async (x, y, dy) => {
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: 0, deltaY: dy });
    },

    write: async (text) => {
      await cdp.send('Input.insertText', { text });
    },

    key: async (name, text) => {
      /**
       * The keys that are not characters. Everything else — a letter, a digit, a punctuation mark —
       * is sent as itself, because a remote screen where only four keys work is not a screen anyone
       * can log in through, and logging in is what this is for.
       */
      const named: Record<string, { code: string; windowsVirtualKeyCode: number; text?: string }> = {
        Enter: { code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' },
        Tab: { code: 'Tab', windowsVirtualKeyCode: 9 },
        Backspace: { code: 'Backspace', windowsVirtualKeyCode: 8 },
        Escape: { code: 'Escape', windowsVirtualKeyCode: 27 },
        Delete: { code: 'Delete', windowsVirtualKeyCode: 46 },
        ArrowLeft: { code: 'ArrowLeft', windowsVirtualKeyCode: 37 },
        ArrowUp: { code: 'ArrowUp', windowsVirtualKeyCode: 38 },
        ArrowRight: { code: 'ArrowRight', windowsVirtualKeyCode: 39 },
        ArrowDown: { code: 'ArrowDown', windowsVirtualKeyCode: 40 },
        Home: { code: 'Home', windowsVirtualKeyCode: 36 },
        End: { code: 'End', windowsVirtualKeyCode: 35 },
        PageUp: { code: 'PageUp', windowsVirtualKeyCode: 33 },
        PageDown: { code: 'PageDown', windowsVirtualKeyCode: 34 },
      };

      const typed = text ?? (name.length === 1 ? name : undefined);
      if (!named[name] && typed) {
        // A character: down with the text on it, then up. Sites that watch keystrokes — every login
        // form worth the name — see a real key, not text appearing out of nowhere.
        await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: name, text: typed, unmodifiedText: typed });
        await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: name });
        return;
      }

      const stroke = named[name];
      if (!stroke) return;
      await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: name, ...stroke });
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...stroke });
    },

    stop: async () => {
      await cdp.detach().catch(() => undefined);
    },
  };
}
