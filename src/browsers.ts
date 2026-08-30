import type { BrowserSession } from './drivers/patchright.js';

/**
 * One browser per account, and not one more than the machine can hold.
 *
 * Sharing a browser between accounts shares its cookies, its storage and whatever a site left behind —
 * fine for one team, not fine for strangers. So every account gets its own profile. But a headed
 * Chromium costs hundreds of megabytes, so the pool keeps only the few most recently used and closes
 * the rest; a closed one simply starts again next time, a little slower.
 *
 * Work for one account is serialised: one browser, one page, one thing at a time. Different accounts
 * proceed in parallel.
 */
export interface PoolOptions {
  /** How many browsers may exist at once. */
  max: number;
  open: (profileDir: string, key: string) => Promise<BrowserSession>;
  profileDir: (key: string) => string;
}

interface Slot {
  session?: BrowserSession;
  queue: Promise<unknown>;
  lastUsed: number;
  busy: number;
}

export class BrowserPool {
  private readonly slots = new Map<string, Slot>();
  private clock = 0;

  constructor(private readonly options: PoolOptions) {}

  /** Run something with this account's page. Calls for the same account never overlap. */
  async use<T>(key: string, work: (session: BrowserSession) => Promise<T>): Promise<T> {
    const slot = this.slots.get(key) ?? { queue: Promise.resolve(), lastUsed: 0, busy: 0 };
    this.slots.set(key, slot);

    const run = slot.queue.then(
      () => this.runOne(key, slot, work),
      () => this.runOne(key, slot, work),
    );
    slot.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /** Drop this account's browser — after a crash, or when the account signs out. */
  async close(key: string): Promise<void> {
    const slot = this.slots.get(key);
    if (!slot?.session) return;
    const session = slot.session;
    slot.session = undefined;
    await session.close().catch(() => undefined);
  }

  async closeAll(): Promise<void> {
    await Promise.all([...this.slots.keys()].map((key) => this.close(key)));
  }

  get openCount(): number {
    return [...this.slots.values()].filter((slot) => slot.session).length;
  }

  private async runOne<T>(key: string, slot: Slot, work: (session: BrowserSession) => Promise<T>): Promise<T> {
    slot.busy++;
    try {
      if (!slot.session) {
        await this.evictIfNeeded();
        slot.session = await this.options.open(this.options.profileDir(key), key);
      }
      slot.lastUsed = ++this.clock;
      return await work(slot.session);
    } catch (error) {
      // A browser that threw may be broken beyond this call; the next use starts a fresh one.
      await this.close(key);
      throw error;
    } finally {
      slot.busy--;
      slot.lastUsed = ++this.clock;
    }
  }

  private async evictIfNeeded(): Promise<void> {
    const idle = [...this.slots.entries()]
      .filter(([, slot]) => slot.session && slot.busy === 0)
      .sort((a, b) => a[1].lastUsed - b[1].lastUsed);

    while (this.openCount >= this.options.max && idle.length > 0) {
      const [key] = idle.shift()!;
      await this.close(key);
    }
  }
}
