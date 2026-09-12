/**
 * The number to ring about a listing.
 *
 * Boards show it to anyone who asks, and only to someone who asks: the page arrives with the number
 * masked, and a click fetches the real one. That is a deliberate cost on collecting them in bulk, and
 * it is not worth defeating — a run that reveals thirty thousand numbers an hour is not the same act
 * as a person opening a listing they mean to call, whatever the law in each country says about it.
 *
 * So this is one listing at a time, on demand, and the answer is kept for a while: the person who
 * opened a card and is dialling will open it again, and the board should not be asked twice for that.
 */
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { db, usingDatabase } from './db.js';
import type { PageDriver } from './driver.js';
import { challengeSeen } from './run.js';

export interface Contact {
  phone: string | null;
  at: string;
  /** Said when the number did not come, so a blank is never mistaken for "they left no number". */
  reason?: string;
  /**
   * What is standing in the way, when what came back was a check rather than the listing. A door is
   * not a missing number: somebody has to walk through it once, and then this works.
   */
  door?: string;
}

/**
 * A number, once found, is kept for good.
 *
 * The listing's number does not change — what changes is whether the listing is still up, and that is
 * answered by the feed, for free, without opening anything. So there is no point in ever pressing for
 * the same listing twice, and a full pass over a board is resumable for nothing: whatever is already
 * in here is skipped.
 *
 * A failure is the opposite: it is kept in this process only, briefly, so a run does not hammer the
 * same broken listing — and it is gone on restart, because the reason may have been the weather.
 */
const failures = new Map<string, Contact>();
const FORGET_FAILURE_MS = 30 * 60 * 1000;

/** The file store, for a laptop and the tests: one line per listing, appended, read once. */
const fileFor = (userId: string): string =>
  join(process.env['RATATOSK_CONTACTS'] ?? 'contacts', `${userId.replace(/[^a-zA-Z0-9._-]/g, '-')}.jsonl`);

const loaded = new Map<string, Map<string, Contact>>();

async function fileIndex(userId: string): Promise<Map<string, Contact>> {
  const had = loaded.get(userId);
  if (had) return had;

  const index = new Map<string, Contact>();
  try {
    for (const line of (await readFile(fileFor(userId), 'utf8')).split('\n')) {
      if (!line.trim()) continue;
      const one = JSON.parse(line) as Contact & { url: string };
      index.set(one.url, { phone: one.phone, at: one.at });
    }
  } catch {
    // No file yet is not a problem — it is a board nobody has asked about.
  }
  loaded.set(userId, index);
  return index;
}

/** What is already known about this listing, if anything. */
export async function knownContact(userId: string, url: string): Promise<Contact | undefined> {
  if (usingDatabase()) {
    const pool = await db();
    const { rows } = await pool.query<{ phone: string | null; at: Date }>(
      'SELECT phone, at FROM contacts WHERE user_id = $1 AND url = $2 AND phone IS NOT NULL',
      [userId, url],
    );
    const one = rows[0];
    return one ? { phone: one.phone, at: one.at.toISOString() } : undefined;
  }
  return (await fileIndex(userId)).get(url);
}

async function keepContact(userId: string, url: string, contact: Contact): Promise<void> {
  if (usingDatabase()) {
    const pool = await db();
    await pool.query(
      `INSERT INTO contacts (user_id, url, phone, at, reason) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (user_id, url) DO UPDATE SET phone = EXCLUDED.phone, at = EXCLUDED.at, reason = EXCLUDED.reason`,
      [userId, url, contact.phone, contact.at, contact.reason ?? null],
    );
    return;
  }
  const file = fileFor(userId);
  await mkdir(dirname(file), { recursive: true });
  await appendFile(file, `${JSON.stringify({ url, ...contact })}\n`, 'utf8');
  (await fileIndex(userId)).set(url, contact);
}

/** For the tests: start again with nothing remembered in this process. */
export function forgetContacts(): void {
  failures.clear();
  loaded.clear();
}

/**
 * The digits in what the control says once it has said them.
 *
 * Deliberately narrow: a page is full of numbers — prices, areas, dates — and a loose pattern turns
 * a failed reveal into a confident wrong number, which is worse than no number at all.
 */
export function phoneIn(said: string | null | undefined): string | null {
  const match = /(?:^|[^\d])(0\d{8,10})(?:[^\d]|$)/.exec(String(said ?? '').replace(/[\s.\-()]/g, ''));
  return match ? match[1]! : null;
}

/**
 * Open the listing, press the control that shows the number, and read it off that same control.
 *
 * The control is found by what it says rather than by a selector: these pages are built with hashed
 * class names that change with every deploy of theirs, so a selector written today is a scraper that
 * breaks silently next week, while the words on a button are part of the product.
 */
export async function revealPhone(
  page: PageDriver,
  url: string,
  options: { userId: string; clickText: string; settleMs?: number; revealMs?: number; now?: number },
): Promise<Contact> {
  const now = options.now ?? Date.now();

  const already = await knownContact(options.userId, url);
  if (already) return already;

  const failed = failures.get(url);
  if (failed && now - Date.parse(failed.at) < FORGET_FAILURE_MS) return failed;

  const at = new Date(now).toISOString();
  await page.goto(url);
  await page.waitMs(options.settleMs ?? 1200);

  const pressed = await page.evaluate<boolean>(PRESS_SOURCE, options.clickText);
  if (!pressed) {
    // "No such control" and "we never reached the listing" look identical from here and are not the
    // same problem at all. One is a scraper to fix; the other is a door for a person to walk through.
    const door = await challengeSeen(page);
    const missing: Contact = door
      ? { phone: null, at, door, reason: `the board asked us to prove we are human: ${door}` }
      : { phone: null, at, reason: `nothing on the page says "${options.clickText}"` };
    // A door is not an answer, and must not be remembered as one.
    if (!door) failures.set(url, missing);
    return missing;
  }

  await page.waitMs(options.revealMs ?? 2000);
  const said = await page.evaluate<string>(READ_SOURCE, options.clickText);
  const phone = phoneIn(said);
  if (!phone) {
    const empty: Contact = { phone: null, at, reason: 'the control was pressed and still shows no number' };
    failures.set(url, empty);
    return empty;
  }

  const found: Contact = { phone, at };
  await keepContact(options.userId, url, found);
  return found;
}

/**
 * Pressed rather than clicked at: the control is often laid out off-screen on one of the two layouts
 * a responsive page carries, and a mouse cannot reach what has no place on the screen.
 */
const PRESS_SOURCE = `(marker) => {
  const wanted = String(marker);
  const buttons = [...document.querySelectorAll('button, a, [role="button"]')];
  const target = buttons.find((one) => (one.innerText || one.textContent || '').trim().startsWith(wanted));
  if (!target) return false;
  target.click();
  return true;
}`;

/**
 * Read back from the same control. Once pressed it holds the number itself, so nothing has to guess
 * which of the page's many numbers this one is.
 */
const READ_SOURCE = `(marker) => {
  const wanted = String(marker);
  const buttons = [...document.querySelectorAll('button, a, [role="button"]')];
  const target = buttons.find((one) => /0\\d{8,10}/.test((one.innerText || one.textContent || '').replace(/[\\s.\\-()]/g, '')))
    || buttons.find((one) => (one.innerText || one.textContent || '').trim().startsWith(wanted));
  return target ? (target.innerText || target.textContent || '') : '';
}`;
