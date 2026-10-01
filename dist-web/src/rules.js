import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
export function matchRules(url, rules) {
    return rules.filter((rule) => {
        if (rule.match.startsWith('/') && rule.match.lastIndexOf('/') > 0) {
            const end = rule.match.lastIndexOf('/');
            return new RegExp(rule.match.slice(1, end), rule.match.slice(end + 1)).test(url);
        }
        return url.includes(rule.match);
    });
}
/** Returns what actually fired, so a run can report it instead of quietly changing the page. */
export async function applyRules(page, rules) {
    const applied = [];
    for (const rule of matchRules(await page.currentUrl(), rules)) {
        if (rule.remove?.length) {
            const removed = await page.evaluate(REMOVE_SOURCE, rule.remove);
            if (removed > 0)
                applied.push(`${rule.name}: removed ${removed} element(s)`);
        }
        for (const control of rule.click ?? []) {
            if (typeof control !== 'string') {
                const pressed = await page.evaluate(CLICK_WHAT_IT_SAYS, control);
                if (pressed)
                    applied.push(`${rule.name}: pressed "${control.text}"`);
                continue;
            }
            const present = await page.evaluate(`(selector) => Boolean(document.querySelector(selector))`, control);
            if (!present)
                continue;
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
export async function loadRules(dir = 'rules') {
    try {
        const names = await readdir(dir);
        const files = names.filter((file) => file.endsWith('.json'));
        return await Promise.all(files.map(async (file) => JSON.parse(await readFile(join(dir, file), 'utf8'))));
    }
    catch {
        return [];
    }
}
