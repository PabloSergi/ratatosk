import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { PageDriver } from './driver.js';

/**
 * Site rules are a first-class mechanism, not a patch on top: real sites put things between you and
 * the content — consent overlays, sticky headers, "app is better" interstitials — and a scraper that
 * cannot say "on this host, first get that out of the way" ends up as a pile of special cases.
 *
 * `remove` takes the obstacle out of the DOM. It agrees to nothing and stores no consent: the page
 * simply stops being covered. That is the default and it is deliberate — a platform must never accept
 * someone's terms on their behalf.
 *
 * `click` exists because sometimes a control genuinely has to be pressed (a "show all" toggle, a
 * "reject non-essential" button the site owner wants used). It is never implicit: whoever writes the
 * rule chooses it, name by name.
 */
export interface SiteRule {
  name: string;
  /** Substring of the URL, or /regex/ if wrapped in slashes. */
  match: string;
  remove?: string[];
  /**
   * A control to press. Either a selector, or — for the controls that have no selector worth the name
   * — the thing that is written on it: `{"selector": "div[role=button]", "text": "See more"}`. Every
   * site has a few of these, and on the sites built from generated class names they are the only ones
   * a person could describe out loud.
   */
  click?: Array<string | { selector: string; text: string }>;
  /**
   * How this site continues, when no control on the page says so — a message archive walks backwards
   * by cursor, not by a "next" button. It is a hint, not a fact: the probe still has to use it and
   * see the rows change.
   */
  pagination?: unknown;
}

export function matchRules(url: string, rules: SiteRule[]): SiteRule[] {
  return rules.filter((rule) => {
    if (rule.match.startsWith('/') && rule.match.lastIndexOf('/') > 0) {
      const end = rule.match.lastIndexOf('/');
      return new RegExp(rule.match.slice(1, end), rule.match.slice(end + 1)).test(url);
    }
    return url.includes(rule.match);
  });
}

/** Returns what actually fired, so a run can report it instead of quietly changing the page. */
export async function applyRules(page: PageDriver, rules: SiteRule[]): Promise<string[]> {
  const applied: string[] = [];

  for (const rule of matchRules(await page.currentUrl(), rules)) {
    if (rule.remove?.length) {
      const removed = await page.evaluate<number>(REMOVE_SOURCE, rule.remove);
      if (removed > 0) applied.push(`${rule.name}: removed ${removed} element(s)`);
    }

    for (const control of rule.click ?? []) {
      if (typeof control !== 'string') {
        const pressed = await page.evaluate<boolean>(CLICK_WHAT_IT_SAYS, control);
        if (pressed) applied.push(`${rule.name}: pressed "${control.text}"`);
        continue;
      }
      const present = await page.evaluate<boolean>(
        `(selector) => Boolean(document.querySelector(selector))`,
        control,
      );
      if (!present) continue;
      await page.click(control);
      applied.push(`${rule.name}: clicked ${control}`);
    }
  }

  return applied;
}

/**
 * The control that says a particular thing, pressed in the page.
 *
 * Pressed from inside rather than through the driver because what is being looked for is text, and a
 * selector language that can match text belongs to one driver. A click dispatched on the element is a
 * real one either way — the frameworks these pages are built with listen for it at the document.
 */
const CLICK_WHAT_IT_SAYS = `
(control) => {
  const wanted = String(control.text).trim().toLowerCase();
  for (const node of Array.from(document.querySelectorAll(control.selector))) {
    const said = (node.innerText || node.textContent || '').trim().toLowerCase();
    if (said === wanted || said.includes(wanted)) {
      node.click();
      return true;
    }
  }
  return false;
}`;

/**
 * Removing an overlay is not enough on its own: these things lock the page behind them, so the
 * scroll lock and backdrop go with it. Nothing here submits, accepts or stores anything.
 */
const REMOVE_SOURCE = `
(selectors) => {
  let removed = 0;
  for (const selector of selectors) {
    for (const node of Array.from(document.querySelectorAll(selector))) {
      node.remove();
      removed++;
    }
  }
  if (removed > 0) {
    document.documentElement.style.removeProperty('overflow');
    document.body.style.removeProperty('overflow');
    document.body.style.removeProperty('padding-right');
    document.body.classList.remove('modal-open', 'no-scroll', 'overflow-hidden');
  }
  return removed;
}
`;

/**
 * Site rules as one JSON file per site in a directory. A missing directory simply means no rules —
 * every entry point needs this and each used to carry its own copy, which is three places for one
 * decision about what a rules directory is.
 */
export async function loadRules(dir = 'rules'): Promise<SiteRule[]> {
  try {
    const names = await readdir(dir);
    const files = names.filter((file) => file.endsWith('.json'));
    return await Promise.all(files.map(async (file) => JSON.parse(await readFile(join(dir, file), 'utf8')) as SiteRule));
  } catch {
    return [];
  }
}
