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

/** Long enough that a person keeps their answer, short enough that a re-let is not called about. */
const KEEP_MS = 6 * 60 * 60 * 1000;

const known = new Map<string, Contact>();

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

/** Whether this listing's number is already in hand, and still fresh. */
export function remembered(url: string, now = Date.now()): Contact | undefined {
  const had = known.get(url);
  if (!had) return undefined;
  if (now - Date.parse(had.at) > KEEP_MS) {
    known.delete(url);
    return undefined;
  }
  return had;
}

export function forgetContacts(): void {
  known.clear();
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
  options: { clickText: string; settleMs?: number; revealMs?: number; now?: number } ,
): Promise<Contact> {
  const already = remembered(url, options.now ?? Date.now());
  if (already) return already;

  const at = new Date(options.now ?? Date.now()).toISOString();
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
    if (!door) known.set(url, missing);
    return missing;
  }

  await page.waitMs(options.revealMs ?? 2000);
  const said = await page.evaluate<string>(READ_SOURCE, options.clickText);
  const phone = phoneIn(said);
  const found: Contact = phone
    ? { phone, at }
    : { phone: null, at, reason: 'the control was pressed and still shows no number' };
  known.set(url, found);
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
