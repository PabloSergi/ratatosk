/**
 * A source that answers in JSON.
 *
 * Until now a robot was a browser: open a page, wait for it to render, read selectors. That is the
 * only way to read a site that only exists as a page, and it is the wrong way to read one that has an
 * open API behind it — a browser walk over a board with thirty thousand listings takes hours and
 * breaks on the next redesign, while the same thirty thousand come out of its own endpoint in minutes
 * and survive it.
 *
 * Two things about such an endpoint are traps, and both are here rather than in whoever uses it:
 *
 * - **The count lies.** A board that refuses to page past ten thousand also clamps the total it
 *   reports to ten thousand, so "10000" means "ten thousand or more, and I will not say". Taking it
 *   at face value loses the remainder and looks exactly like success. The answer is to cut the
 *   window — a numeric filter the source already supports — in half until each half fits under the
 *   cap, and walk the halves.
 * - **The halves overlap.** Such a filter is almost always inclusive at both ends, so the two halves
 *   share their boundary. Rows are therefore kept in a map keyed by the source's own id: a duplicate
 *   overwrites itself, and nothing is ever missed between the halves.
 */
import { InputError } from './errors.js';

export interface ApiRobot {
  name: string;
  version: 1;
  source: 'api';
  /** The endpoint, without query. */
  url: string;
  /** Parameters that never change for this robot — the region, the category, the kind of deal. */
  query?: Record<string, string | number>;
  /** Where the rows and the count live in the answer, as dotted paths. */
  rowsAt: string;
  totalAt: string;
  /** How the source pages: the offset parameter, and how many rows it will give at once. */
  page: { param: string; sizeParam: string; size: number };
  /**
   * The window to cut when the count hits the cap. `param` is sent as "from-to", which is how these
   * boards spell a range; `cap` is the number the source refuses to page past AND clamps its total to.
   */
  window?: { param: string; from: number; to: number; cap: number };
  /** Which value identifies a row, so the overlap between two halves collapses instead of doubling. */
  identity: string;
  /** Output column ← dotted path into the row. `a[].b` maps over an array and takes b from each. */
  fields: Record<string, string>;
  /** Courtesy between calls. */
  pauseMs?: number;
  /** A ceiling on calls, so a source that changes its mind cannot spin here forever. */
  maxCalls?: number;
  /** What the list does not carry. See `deepen`. */
  detail?: ApiDetail;
  remember?: { by?: string; days?: number; mode?: 'new' | 'all' };
}

/**
 * The second answer, for what a list will not say.
 *
 * A listing feed is built to be cheap and wide, so it leaves things out — the deposit, how many
 * bathrooms, when the advert was FIRST put up rather than last pushed back to the top. Those live
 * behind one more address, one listing at a time, and that is a call per row: fine for the handful a
 * run hands over, ruinous for a whole board every hour. So it runs after the memory, on what is
 * actually being passed on, and never on what was already known.
 */
export interface ApiDetail {
  /** The address of one row, with {column} standing in for that row's own value. */
  url: string;
  /** Extra columns ← dotted paths into the deeper answer. */
  fields: Record<string, string>;
  /** A cap, because every row here is a request. */
  maxRows?: number;
  pauseMs?: number;
}

export async function deepen(rows: Row[], detail: ApiDetail, ask: AskJson): Promise<{ rows: Row[]; calls: number }> {
  let calls = 0;
  const cap = detail.maxRows ?? 500;

  for (const row of rows.slice(0, cap)) {
    const where = detail.url.replace(/\{(\w+)\}/g, (_, column: string) => encodeURIComponent(row[column] ?? ''));
    if (where.includes('//') && /\{\w+\}/.test(where)) continue;

    try {
      calls++;
      // Only what the deeper answer actually says. A field missing there is not a correction of what
      // the list already gave — merging its emptiness over a good value loses data to a second look,
      // which is the opposite of what a second look is for.
      for (const [column, value] of Object.entries(readRow(await ask(where), detail.fields))) {
        if (value !== null) row[column] = value;
      }
    } catch {
      // A row that will not deepen is still an honest row: it keeps what the list gave.
    }
    if (detail.pauseMs) await rest(detail.pauseMs);
  }
  return { rows, calls };
}

export function isApiRobot(value: unknown): value is ApiRobot {
  return typeof value === 'object' && value !== null && (value as { source?: string }).source === 'api';
}

export function parseApiRobot(data: unknown): ApiRobot {
  const robot = data as ApiRobot;
  const name = robot?.name ?? 'robot';
  if (!/^https?:\/\//.test(robot?.url ?? '')) throw new InputError(`${name}: url must be http(s)`);
  if (!robot.rowsAt || !robot.totalAt) throw new InputError(`${name}: rowsAt and totalAt are required`);
  if (!robot.page?.param || !robot.page?.sizeParam) throw new InputError(`${name}: page needs param and sizeParam`);
  if (!robot.identity) throw new InputError(`${name}: identity is required — without it halves double`);
  if (!robot.fields || Object.keys(robot.fields).length === 0) throw new InputError(`${name}: no fields to read`);
  if (robot.window && robot.window.to <= robot.window.from) throw new InputError(`${name}: window is empty`);
  return { ...robot, version: 1, source: 'api', page: { ...robot.page, size: robot.page.size ?? 50 } };
}

export type Row = Record<string, string | null>;
export type AskJson = (url: string) => Promise<unknown>;

/** One value out of a row. `a.b` walks objects; `a[].b` takes b from every entry of an array. */
export function pluck(row: unknown, path: string): unknown {
  let here: unknown = row;
  for (const step of path.split('.')) {
    if (here === null || here === undefined) return undefined;
    if (step.endsWith('[]')) {
      const list = (here as Record<string, unknown>)[step.slice(0, -2)];
      return Array.isArray(list) ? list : undefined;
    }
    if (step.startsWith('[].')) return undefined;
    here = (here as Record<string, unknown>)[step];
  }
  return here;
}

/** A row as a scraper hands rows over: flat, and every value a string or nothing. */
export function readRow(raw: unknown, fields: Record<string, string>): Row {
  const row: Row = {};
  for (const [column, path] of Object.entries(fields)) {
    const arrow = path.indexOf('[].');
    let value: unknown;
    if (arrow === -1) {
      value = pluck(raw, path);
    } else {
      const list = pluck(raw, `${path.slice(0, arrow)}[]`);
      const tail = path.slice(arrow + 3);
      value = Array.isArray(list) ? list.map((one) => pluck(one, tail)).filter((one) => one !== undefined) : undefined;
    }
    row[column] = say(value);
  }
  return row;
}

function say(value: unknown): string | null {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

export interface ApiRun {
  rows: Row[];
  calls: number;
  /** Said when the walk stopped for a reason worth reading, not when it simply finished. */
  reason?: string;
}

/**
 * Walk the source until it has been read whole.
 *
 * The recursion is on the window, never on the offset: paging is a flat loop inside a window that is
 * known to fit. A window that still will not fit at a width of one is taken as far as the source will
 * go and said out loud — that is a source whose cap is smaller than its own granularity, and silently
 * returning a tenth of it would be the failure this whole file exists to prevent.
 */
export async function runApiRobot(robot: ApiRobot, ask: AskJson): Promise<ApiRun> {
  const found = new Map<string, Row>();
  const state = { calls: 0, notes: [] as string[] };
  const ceiling = robot.maxCalls ?? 4000;

  const at = (extra: Record<string, string | number>): string => {
    const url = new URL(robot.url);
    for (const [key, value] of Object.entries({ ...robot.query, ...extra })) url.searchParams.set(key, String(value));
    return url.toString();
  };

  const countOf = async (window?: Record<string, string>): Promise<number> => {
    state.calls++;
    const answer = await ask(at({ ...window, [robot.page.sizeParam]: 1, [robot.page.param]: 0 }));
    return Number(pluck(answer, robot.totalAt) ?? 0);
  };

  const take = async (window: Record<string, string> | undefined, total: number): Promise<void> => {
    let offset = 0;
    while (offset < total && state.calls < ceiling) {
      state.calls++;
      const answer = await ask(at({ ...window, [robot.page.sizeParam]: robot.page.size, [robot.page.param]: offset }));
      const batch = pluck(answer, robot.rowsAt);
      if (!Array.isArray(batch) || batch.length === 0) return;
      for (const one of batch) {
        const key = say(pluck(one, robot.identity));
        if (key) found.set(key, readRow(one, robot.fields));
      }
      offset += batch.length;
      if (robot.pauseMs) await rest(robot.pauseMs);
    }
  };

  const walk = async (from: number, to: number): Promise<void> => {
    if (state.calls >= ceiling) return;
    const window = robot.window ? { [robot.window.param]: `${Math.round(from)}-${Math.round(to)}` } : undefined;
    const total = await countOf(window);
    if (total === 0) return;

    // At the cap the total is not a total, so the window is cut rather than believed.
    if (robot.window && total >= robot.window.cap && to - from > 1) {
      const middle = from + Math.floor((to - from) / 2);
      await walk(from, middle);
      await walk(middle, to);
      return;
    }
    if (robot.window && total >= robot.window.cap) {
      state.notes.push(`${total}+ rows sit in a window one wide (${Math.round(from)}) — the rest of it is unreachable`);
    }
    await take(window, total);
  };

  if (robot.window) await walk(robot.window.from, robot.window.to);
  else await take(undefined, await countOf());

  if (state.calls >= ceiling) state.notes.push(`stopped at ${ceiling} calls`);
  return {
    rows: [...found.values()],
    calls: state.calls,
    ...(state.notes.length ? { reason: state.notes.join('; ') } : {}),
  };
}

const rest = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

/**
 * Ask, and keep asking. A board answering a few hundred times a run will time out once or twice, and
 * one timeout is not a broken source — it is a timeout.
 */
export function asker(headers: Record<string, string> = {}): AskJson {
  return async (url: string): Promise<unknown> => {
    let waited = 400;
    let last: unknown;
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        const answer = await fetch(url, {
          headers: { accept: 'application/json', 'accept-encoding': 'gzip', ...headers },
        });
        if (answer.ok) return await answer.json();
        last = new Error(`${answer.status} ${answer.statusText}`);
        // A refusal is a verdict, not a hiccup; only the source being busy is worth asking again.
        if (answer.status < 500 && answer.status !== 429) throw last;
      } catch (error) {
        last = error;
      }
      await rest(waited);
      waited *= 2;
    }
    throw last instanceof Error ? last : new Error(String(last));
  };
}
