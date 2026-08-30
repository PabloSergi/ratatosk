import type { PageDriver } from './driver.js';
import { asExtractResult, EXTRACTOR_SOURCE } from './extractor.js';
import { look } from './look.js';
import { rowsSignature } from './run.js';
import type { FieldRule, ListRule, PaginationRule, Scenario } from './scenario.js';
import { parseScenario } from './scenario.js';

/**
 * Build-time tools. This is the half a model uses to make a robot, and it is a loop, not one shot:
 * look at the page, try a selector, see what actually came back, fix it, probe how the page continues,
 * then freeze the result. One-shot generation is what everyone else does, and it is why their robots
 * are wrong in ways nobody notices until the table is empty.
 *
 * Every answer here is small on purpose — a build step must be cheap enough to repeat ten times.
 */

export interface TryResult {
  blocksSeen: number;
  rows: number;
  sample: Array<Record<string, string | null>>;
  /** How many blocks lacked each non-optional field. */
  missing: Record<string, number>;
  /** What is suspicious about this attempt, in plain words. */
  warnings: string[];
}

/** Try a row selector and a field map, and see what the page actually gives back. */
export async function tryFields(page: PageDriver, list: ListRule): Promise<TryResult> {
  const raw = await page.evaluate<unknown>(EXTRACTOR_SOURCE, list);
  const extract = asExtractResult(raw, await page.currentUrl());
  const warnings: string[] = [];

  if (extract.error) {
    warnings.push(extract.error);
  } else if (extract.blocksSeen === 0) {
    warnings.push(`"${list.rows}" matched nothing on this page`);
  } else if (extract.rows.length === 0) {
    warnings.push(`${extract.blocksSeen} blocks matched but no field ever filled — the field selectors look wrong`);
  }

  for (const [field, count] of Object.entries(extract.missing)) {
    if (count === extract.blocksSeen) warnings.push(`"${field}" is empty in every block — wrong selector, or the field lives outside the block`);
    else warnings.push(`"${field}" is missing in ${count} of ${extract.blocksSeen} blocks`);
  }

  // A field that says the same thing in every row is almost always a label, not data.
  for (const field of Object.keys(list.fields)) {
    const values = extract.rows.map((row) => row[field]).filter((value) => value !== null);
    if (values.length > 2 && new Set(values).size === 1) {
      warnings.push(`"${field}" is identical in every row (${String(values[0]).slice(0, 30)}…) — probably a static label`);
    }
  }

  // Responsive markup shows the same value twice — once for mobile, once for desktop. Two columns
  // holding exactly the same thing are one column and a mistake.
  const columns = Object.keys(list.fields).map((field) => ({
    field,
    values: extract.rows.map((row) => row[field]).join('\u0000'),
    filled: extract.rows.some((row) => row[field] !== null),
  }));
  for (let i = 0; i < columns.length; i++) {
    for (let j = i + 1; j < columns.length; j++) {
      const left = columns[i]!;
      const right = columns[j]!;
      if (left.filled && extract.rows.length > 1 && left.values === right.values) {
        warnings.push(`"${right.field}" repeats "${left.field}" — the same value in different markup`);
      }
    }
  }

  return {
    blocksSeen: extract.blocksSeen,
    rows: extract.rows.length,
    sample: extract.rows.slice(0, 3),
    missing: extract.missing,
    warnings,
  };
}

export interface ProbeResult {
  pagination: PaginationRule;
  /** Whether the control was actually pressed and the rows actually changed. */
  worked: boolean;
  note: string;
}

/**
 * Find how the page continues — and prove it by using it. A pagination rule that was never exercised
 * is a guess, and guesses are what turn into robots that silently walk the same page twice.
 */
export async function paginateProbe(page: PageDriver, rowsSelector: string, maxPages = 20): Promise<ProbeResult> {
  const hint = (await look(page)).pagination;

  if (hint.kind === 'none') {
    return { pagination: { type: 'none' }, worked: true, note: 'no next control found — treating the list as a single page' };
  }

  if (hint.kind === 'scroll') {
    const before = await page.evaluate<number>(`(selector) => document.querySelectorAll(selector).length`, rowsSelector);
    await page.evaluate(`() => window.scrollTo(0, document.body.scrollHeight)`);
    await page.waitMs(2000);
    const after = await page.evaluate<number>(`(selector) => document.querySelectorAll(selector).length`, rowsSelector);
    // Scrolling that adds nothing is an answer — the list ends here — not a failure to be complained
    // about. A failure is a control that exists and does not work.
    if (after > before) {
      return {
        pagination: { type: 'scroll', maxRounds: maxPages, settleMs: 2000 },
        worked: true,
        note: `scrolling added rows: ${before} → ${after}`,
      };
    }
    return {
      pagination: { type: 'none' },
      worked: true,
      note: `scrolling added nothing (${before} rows) — this is a single page`,
    };
  }

  const selector = hint.selector ?? '';
  const present = await page.evaluate<boolean>(`(selector) => Boolean(document.querySelector(selector))`, selector);
  if (!present) {
    // Nothing to press: the proposal was wrong or there is genuinely no next page. Either way the
    // robot covers one page and knows it, which is a settled state rather than a defect.
    return { pagination: { type: 'none' }, worked: true, note: `no usable next control ("${selector}" is not on the page) — treating the list as a single page` };
  }

  const before = await rowsSignature(page, rowsSelector);
  try {
    await page.click(selector);
  } catch (error) {
    return {
      pagination: { type: 'none' },
      worked: false,
      note: `"${selector}" could not be clicked: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`,
    };
  }

  for (let waited = 0; waited < 10_000; waited += 250) {
    await page.waitMs(250);
    if ((await rowsSignature(page, rowsSelector)) !== before) {
      return {
        pagination: { type: hint.kind === 'link' ? 'link' : 'button', next: selector, maxPages },
        worked: true,
        note: `"${selector}" turned the page and the rows changed`,
      };
    }
  }

  return { pagination: { type: 'none' }, worked: false, note: `"${selector}" was clicked but the rows never changed` };
}

/**
 * A selector can be right and still be too narrow: `div.job-listing.adtype-0` fits five cards on a page
 * that shows twenty-seven, because the site marks paid listings with a different modifier class. The
 * rows that fall outside are lost in silence — the worst kind of loss, since everything looks fine.
 *
 * So the specific classes are peeled off one at a time and the wider selector is measured. Wider wins
 * only if it brings materially more rows AND keeps every column as well filled as before. That is
 * arithmetic, so the platform does it rather than asking anyone.
 */
export async function widenRows(
  page: PageDriver,
  list: ListRule,
  minCoverage = 0.8,
): Promise<{ rows: string; count: number; widened: boolean }> {
  const base = await tryFields(page, list);
  const covered = (attempt: TryResult) =>
    Object.entries(list.fields)
      .filter(([, rule]) => !rule.optional)
      .every(([field]) => {
        const filled = attempt.sample.filter((row) => row[field] !== null && row[field] !== '').length;
        return attempt.sample.length === 0 ? false : filled / attempt.sample.length >= minCoverage;
      });

  const match = /^([a-zA-Z][\w-]*)((?:\.[\w-]+)+)$/.exec(list.rows.trim());
  if (!match) return { rows: list.rows, count: base.rows, widened: false };

  const tag = match[1]!;
  const classes = match[2]!.split('.').filter(Boolean);

  let best = { rows: list.rows, count: base.rows, widened: false };
  for (let drop = classes.length - 1; drop >= 0; drop--) {
    const kept = classes.filter((_, index) => index !== drop);
    if (kept.length === 0) continue;
    const candidate = tag + '.' + kept.join('.');
    const attempt = await tryFields(page, { ...list, rows: candidate });
    if (attempt.rows > best.count * 1.2 && covered(attempt)) {
      best = { rows: candidate, count: attempt.rows, widened: true };
    }
  }

  return best;
}

/** Turn chosen pieces into a scenario, and refuse it here rather than at the first run. */
export function buildScenario(input: {
  name: string;
  url: string;
  rows: string;
  fields: Record<string, FieldRule>;
  pagination: PaginationRule;
  minRowsPerPage?: number;
}): Scenario {
  // A link that cannot be opened is not a link. Whoever writes the rule may forget to resolve it
  // against the page; the platform does not.
  const fields = Object.fromEntries(
    Object.entries(input.fields).map(([name, rule]) => [
      name,
      rule.type === 'attr' && (rule.attr === 'href' || rule.attr === 'src') && rule.absolute === undefined
        ? { ...rule, absolute: true }
        : rule,
    ]),
  );

  return parseScenario({
    name: input.name,
    version: 1,
    url: input.url,
    wait: { selector: input.rows, minCount: Math.max(1, Math.min(5, input.minRowsPerPage ?? 3)), timeoutMs: 20_000, settleMs: 1500 },
    list: { rows: input.rows, fields },
    pagination: input.pagination,
    expect: { minRowsPerPage: input.minRowsPerPage ?? 1 },
  });
}

/** Field roles from `look` become field rules. Links and images are attributes; the rest is text. */
export function fieldsFromRoles(hints: Array<{ role: string; selector: string; attr?: string }>): Record<string, FieldRule> {
  const fields: Record<string, FieldRule> = {};
  let extras = 0;

  for (const hint of hints) {
    if (hint.role === 'link') {
      fields['url'] = { type: 'attr', selector: hint.selector, attr: 'href', absolute: true };
    } else if (hint.role === 'image') {
      fields['image'] = { type: 'attr', selector: hint.selector, attr: 'src', absolute: true, optional: true };
    } else if (hint.attr) {
      fields[hint.role === 'text' ? `text${++extras}` : hint.role] = {
        type: 'attr',
        selector: hint.selector,
        attr: hint.attr,
        optional: hint.role !== 'title',
      };
    } else if (hint.role === 'text') {
      extras++;
      if (extras <= 3) fields[`text${extras}`] = { type: 'text', selector: hint.selector, optional: true };
    } else if (!fields[hint.role]) {
      fields[hint.role] = { type: 'text', selector: hint.selector, optional: hint.role !== 'title' };
    }
  }

  return fields;
}
