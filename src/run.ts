import type { PageDriver } from './driver.js';
import type { ExtractResult } from './extractor.js';
import { asExtractResult, EXTRACTOR_SOURCE, ExtractionError } from './extractor.js';
import { applyRules, type SiteRule } from './rules.js';
import type { PaginationRule, Scenario, WaitRule } from './scenario.js';

/**
 * A run never reports plain success. It ends in one of three states, and two of them carry a reason:
 *  - ok      rows came back, at least as many as the scenario expects
 *  - empty   the page rendered but produced nothing — the site may genuinely be empty
 *  - broken  the scenario no longer fits the page: nothing rendered, extractor refused, fields rotted
 * Both empty and broken are what later wakes the model up for a rebuild.
 */
export type RunStatus = 'ok' | 'empty' | 'broken';

export interface RunResult {
  status: RunStatus;
  /** The page was a door meant for a person. The interface offers the one thing that opens it. */
  challenge?: boolean;
  rows: Array<Record<string, string | null>>;
  pagesVisited: number;
  reason?: string;
  evidence?: { blocksSeen: number; missingFields: Record<string, number>; url: string; rowsOpened?: number };
  /** Which site rules fired, so a changed page is never a silent change. */
  rulesApplied?: string[];
}

export interface RunOptions {
  rules?: SiteRule[];
}

export async function runScenario(page: PageDriver, scenario: Scenario, options: RunOptions = {}): Promise<RunResult> {
  const rows: Array<Record<string, string | null>> = [];
  let pagesVisited = 0;
  let lastExtract: ExtractResult = { rows: [], blocksSeen: 0, missing: {} };
  let paginationStopped: string | undefined;
  const rulesApplied: string[] = [];

  try {
    await page.goto(scenario.url);
  } catch (error) {
    return {
      status: 'broken',
      rows,
      pagesVisited,
      reason: `could not open ${scenario.url}: ${firstLine(error)}`,
    };
  }

  const maxPages = pageBudget(scenario.pagination);
  // What each page held, so a pager that loops back is noticed. Sites answer a page number past the
  // end with the first page rather than with an error, and collecting it again would inflate the
  // result with duplicates that look like real rows.
  const seenPages = new Set<string>();

  for (let pageIndex = 0; pageIndex < maxPages; pageIndex++) {
    const rendered = await waitForContent(page, scenario.wait);
    if (!rendered && pageIndex === 0) {
      // "Nothing rendered" and "a door meant for a person" look identical from here and mean opposite
      // things: one is a rotted selector, the other is a page nobody's selectors will ever match.
      const door = await challengeSeen(page);
      return {
        status: 'broken',
        rows,
        pagesVisited,
        reason: door
          ? `${door} — this is a door meant for a person, not the list. Open it yourself once, and the profile keeps what the site leaves behind.`
          : `page never rendered: fewer than ${scenario.wait.minCount} of "${scenario.wait.selector}" after ${scenario.wait.timeoutMs}ms`,
        ...(door ? { challenge: true } : {}),
        evidence: { blocksSeen: 0, missingFields: {}, url: await page.currentUrl() },
        rulesApplied,
      };
    }

    if (options.rules?.length) {
      rulesApplied.push(...(await applyRules(page, options.rules)));
    }

    try {
      lastExtract = await scrapeCurrentPage(page, scenario);
    } catch (error) {
      if (error instanceof ExtractionError) {
        return {
          status: 'broken',
          rows,
          pagesVisited,
          reason: error.message,
          evidence: { blocksSeen: 0, missingFields: {}, url: await page.currentUrl() },
          rulesApplied,
        };
      }
      throw error;
    }

    if (scenario.pagination.type === 'scroll') {
      // Infinite scroll keeps growing the same document, so every round re-reads all rows.
      rows.length = 0;
    } else {
      const fingerprint = JSON.stringify(lastExtract.rows.slice(0, 3));
      if (seenPages.has(fingerprint)) {
        paginationStopped = 'the pager came back to a page already read';
        break;
      }
      seenPages.add(fingerprint);
    }
    rows.push(...lastExtract.rows);
    pagesVisited++;

    if (lastExtract.rows.length < scenario.expect.minRowsPerPage) break;
    if (pageIndex === maxPages - 1) break; // budget spent — do not knock on a page we will not read

    // The browser can refuse to turn the page for reasons that have nothing to do with our rows:
    // an overlay swallowing the click, a control that moved. That ends the walk, it does not
    // throw away what we already collected — but it is never silent either.
    try {
      if (!(await goToNextPage(page, scenario, lastExtract.rows))) break;
    } catch (error) {
      paginationStopped = firstLine(error);
      break;
    }
  }

  // The list is done. What it could not carry — pay, contacts, the whole text — is one page deeper.
  let visited = 0;
  if (scenario.detail && rows.length > 0) {
    try {
      visited = await walkIntoRows(page, scenario, rows);
    } catch (error) {
      paginationStopped = paginationStopped ?? `the walk into rows stopped: ${firstLine(error)}`;
    }
  }

  const evidence = {
    blocksSeen: lastExtract.blocksSeen,
    missingFields: lastExtract.missing,
    url: await page.currentUrl(),
    ...(scenario.detail ? { rowsOpened: visited } : {}),
  };

  if (rows.length > 0) {
    // Rows are not the same thing as data. A required column empty in every single row means that
    // column rotted, and the robot is quietly returning less than it promises — which is the exact
    // failure this project exists to stop. Partial rows are still handed back; the verdict is not.
    const rotted = [...Object.entries(scenario.list.fields), ...Object.entries(scenario.detail?.fields ?? {})]
      .filter(([, rule]) => !rule.optional)
      .map(([field]) => field)
      .filter((field) => rows.every((row) => row[field] === null || row[field] === undefined));

    if (rotted.length > 0) {
      return {
        status: 'broken',
        rows,
        pagesVisited,
        reason: `${rotted.map((field) => `"${field}"`).join(', ')} came back empty in all ${rows.length} rows — the field selector no longer matches`,
        evidence,
        rulesApplied,
      };
    }

    const reason = paginationStopped ? `walk stopped early: ${paginationStopped}` : undefined;
    return { status: 'ok', rows, pagesVisited, reason, evidence, rulesApplied };
  }

  if (lastExtract.blocksSeen > 0) {
    return {
      status: 'broken',
      rows,
      pagesVisited,
      reason: `"${scenario.list.rows}" matched ${lastExtract.blocksSeen} blocks but every field came back empty — field selectors have rotted`,
      evidence,
      rulesApplied,
    };
  }

  return {
    status: 'empty',
    rows,
    pagesVisited,
    reason: `page rendered but "${scenario.list.rows}" matched nothing`,
    evidence,
    rulesApplied,
  };
}

/** Wait for the real DOM, not for a challenge page. Returns false on timeout; the caller decides what that means. */
export async function waitForContent(page: PageDriver, wait: WaitRule): Promise<boolean> {
  const deadline = Date.now() + wait.timeoutMs;
  while (Date.now() < deadline) {
    const count = await page.evaluate<number>(
      `(selector) => document.querySelectorAll(selector).length`,
      wait.selector,
    );
    if (count >= wait.minCount) {
      await page.waitMs(wait.settleMs);
      return true;
    }
    await page.waitMs(250);
  }
  return false;
}

/** Every page goes through here, and the extractor travels with the call. There is no second path. */
/**
 * Open each row and take what the list could not hold.
 *
 * Bounded on purpose: every row is a page load, and forty of them is a minute where the list alone was
 * a second. Rows that share an address are opened once — a list often repeats the same posting — and a
 * row whose page will not open keeps what it already had rather than losing the run for everyone.
 */
async function walkIntoRows(
  page: PageDriver,
  scenario: Scenario,
  rows: Array<Record<string, string | null>>,
): Promise<number> {
  const detail = scenario.detail!;
  const seen = new Map<string, Record<string, string | null>>();
  let opened = 0;

  for (const row of rows) {
    const where = row[detail.follow];
    if (!where || !/^https?:\/\//.test(where)) continue;

    const already = seen.get(where);
    if (already) {
      Object.assign(row, already);
      continue;
    }
    if (opened >= detail.maxRows) break;

    try {
      await page.goto(where);
      await page.waitMs(400);
      // One block — the page itself — read with the same extractor the list uses.
      const raw = await page.evaluate<unknown>(EXTRACTOR_SOURCE, { rows: 'html', fields: detail.fields });
      const found = asExtractResult(raw, where).rows[0] ?? {};
      seen.set(where, found);
      Object.assign(row, found);
    } catch {
      // A page that will not open leaves the row as the list had it, which is still an honest row.
      seen.set(where, {});
    }
    opened++;
  }

  return opened;
}

export async function scrapeCurrentPage(page: PageDriver, scenario: Scenario): Promise<ExtractResult> {
  const raw = await page.evaluate<unknown>(EXTRACTOR_SOURCE, scenario.list);
  return asExtractResult(raw, await page.currentUrl());
}

/**
 * Turning the page is not the same as the page having turned. On a client-rendered site the click
 * changes nothing the browser calls a navigation, so we watch the rows themselves: same rows after
 * the click means we never moved, and collecting them twice would be worse than stopping.
 */
async function goToNextPage(
  page: PageDriver,
  scenario: Scenario,
  lastRows: Array<Record<string, string | null>>,
): Promise<boolean> {
  const pagination = scenario.pagination;
  if (pagination.type === 'none') return false;

  if (pagination.type === 'param') {
    const cursor = cursorFrom(lastRows, pagination.from, pagination.pattern, pagination.pick);
    if (!cursor) return false;
    const next = new URL(await page.currentUrl());
    if (next.searchParams.get(pagination.param) === cursor) return false; // the cursor stopped moving
    next.searchParams.set(pagination.param, cursor);

    const before = await rowsSignature(page, scenario.list.rows);
    await page.goto(next.href);
    await page.waitMs(1000);
    return (await rowsSignature(page, scenario.list.rows)) !== before;
  }

  if (pagination.type === 'number') {
    const next = new URL(await page.currentUrl());
    const start = pagination.start ?? 2;
    const step = pagination.step ?? 1;
    const current = Number(next.searchParams.get(pagination.param) ?? start - step);
    next.searchParams.set(pagination.param, String(current + step));

    // A page number past the end is usually answered with the first page again rather than with an
    // error, so the rows themselves decide whether we actually moved.
    const before = await rowsSignature(page, scenario.list.rows);
    await page.goto(next.href);
    await page.waitMs(1000);
    return (await rowsSignature(page, scenario.list.rows)) !== before;
  }

  if (pagination.type === 'scroll') {
    const before = await page.evaluate<number>(`() => document.body.scrollHeight`);
    await page.evaluate(`() => window.scrollTo(0, document.body.scrollHeight)`);
    await page.waitMs(pagination.settleMs);
    const after = await page.evaluate<number>(`() => document.body.scrollHeight`);
    return after > before;
  }

  const present = await page.evaluate<boolean>(
    `(selector) => Boolean(document.querySelector(selector))`,
    pagination.next,
  );
  if (!present) return false;

  const before = await rowsSignature(page, scenario.list.rows);
  await page.click(pagination.next);

  const deadline = Date.now() + PAGE_TURN_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await page.waitMs(250);
    if ((await rowsSignature(page, scenario.list.rows)) !== before) return true;
  }
  throw new Error(`the page did not change within ${PAGE_TURN_TIMEOUT_MS}ms after clicking "${pagination.next}"`);
}

const PAGE_TURN_TIMEOUT_MS = 10_000;

/** The same words look.ts watches for, asked of a page that gave us nothing. */
async function challengeSeen(page: PageDriver): Promise<string | undefined> {
  const seen = await page
    .evaluate<string | null>(
      `() => {
        const text = (document.title + ' ' + (document.body ? document.body.innerText : '')).slice(0, 400);
        const wall = /just a moment|checking your browser|verify you are human|confirm that you are human|if you are human|i'm not a robot|antibot|turnstile|cf-challenge|attention required|подтвердите, что вы человек|я не робот|проверка браузера/i;
        if (!wall.test(text) && !document.querySelector('iframe[src*="challenges.cloudflare.com"], iframe[src*="hcaptcha.com"], iframe[src*="recaptcha"], #challenge-form')) return null;
        return (document.title || text).trim().slice(0, 90) || 'an anti-bot check';
      }`,
    )
    .catch(() => null);
  return seen ?? undefined;
}

/** Cheap fingerprint of what is on screen: how many rows, and what the first few say. */
export async function rowsSignature(page: PageDriver, rowsSelector: string): Promise<string> {
  return page.evaluate<string>(
    `(selector) => {
       const blocks = Array.from(document.querySelectorAll(selector));
       const head = blocks.slice(0, 3).map((b) => (b.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 60));
       return blocks.length + '|' + head.join('|');
     }`,
    rowsSelector,
  );
}

/** Browser errors arrive as multi-line call logs. A status line wants the first line of it. */
function firstLine(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.split('\n')[0]!.trim();
}

/**
 * The cursor is whatever the last row carries — usually the id at the end of its own link. The column
 * it lives in is named by whoever built the robot, and they may well have named it "ссылка", so a rule
 * written for a whole site cannot depend on that name: "*" means "find it".
 */
export function cursorFrom(
  rows: Array<Record<string, string | null>>,
  field: string,
  pattern?: string,
  pick: 'last' | 'min' | 'max' = 'last',
): string | undefined {
  if (rows.length === 0) return undefined;
  const expression = new RegExp(pattern ?? '(\\d+)\\s*$');
  const take = (value: string | null | undefined) => (value ? expression.exec(value)?.[1] : undefined);

  const fromRow = (row: Record<string, string | null>): string | undefined => {
    if (field !== '*') {
      const named = take(row[field]);
      if (named) return named;
    }
    // Links first: an id at the end of a URL is a cursor, an id at the end of a price is not.
    const values = Object.values(row).filter((value): value is string => typeof value === 'string');
    for (const value of values.filter((v) => v.includes('/'))) {
      const found = take(value);
      if (found) return found;
    }
    return undefined;
  };

  if (pick === 'last') return fromRow(rows[rows.length - 1]!);

  // Walking backwards through an archive, the next page starts before the OLDEST item on this one —
  // and the oldest is not always the last row in document order.
  const numbers = rows.map(fromRow).filter((value): value is string => Boolean(value)).map(Number).filter(Number.isFinite);
  if (numbers.length === 0) return undefined;
  return String(pick === 'min' ? Math.min(...numbers) : Math.max(...numbers));
}

function pageBudget(pagination: PaginationRule): number {
  if (pagination.type === 'none') return 1;
  if (pagination.type === 'param' || pagination.type === 'number') return pagination.maxPages;
  if (pagination.type === 'scroll') return pagination.maxRounds;
  return pagination.maxPages;
}
