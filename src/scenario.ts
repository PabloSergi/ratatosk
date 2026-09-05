/**
 * The scenario is the artifact the model produces once, at build time.
 * Everything after that runs from this file alone, with no model involved.
 * It is plain JSON on purpose: a human must be able to read it and fix a selector by hand.
 */

export interface Scenario {
  name: string;
  version: 1;
  url: string;
  /** How to know the page is actually rendered. Never analyse a challenge page. */
  wait: WaitRule;
  list: ListRule;
  pagination: PaginationRule;
  /**
   * A list rarely carries everything. Pay, contacts, the full text — those live one page deeper, and a
   * robot that stops at the list quietly returns half the answer. This is the walk into each row.
   */
  detail?: DetailRule;
  /** Which rows count, and what to read out of their text. See sift.ts. */
  sift?: SiftRule;
  /** Whether to hand back only what has not been seen before. See memory.ts. */
  remember?: { by?: string; days?: number; mode?: 'new' | 'all' };
  /**
   * Whether rows collected twice in the same walk are handed over once. On unless it is turned off:
   * a pager that shifts under you returns the same posting on two pages, and nobody wants it twice.
   * Off is for a source where identical rows are genuinely different things — a price tick, a reading
   * from a sensor, the same line meaning something new every time it appears.
   */
  dedupe?: boolean;
  /** What a healthy run looks like. Falling below this is a broken run, not an empty site. */
  expect: { minRowsPerPage: number };
  /** Which of the account's proxies to go through, if any. Sites block by address, not by selector. */
  proxy?: string;
}

export interface WaitRule {
  /** Selector whose presence means the real content arrived. */
  selector: string;
  /** How many of them count as "rendered", not "one stray placeholder". */
  minCount: number;
  timeoutMs: number;
  /** Extra quiet time after the threshold is hit, for lazy rendering to settle. */
  settleMs: number;
}

export interface ListRule {
  /** Selector for the repeating block — one row of the result table. */
  rows: string;
  fields: Record<string, FieldRule>;
}

export type FieldRule =
  | { type: 'text'; selector?: string; optional?: boolean }
  | { type: 'attr'; selector?: string; attr: string; absolute?: boolean; optional?: boolean }
  | { type: 'html'; selector?: string; optional?: boolean };

export interface SiftRule {
  keep: string[];
  drop?: string[];
  from?: string;
  fields?: Record<string, { pattern: string; from?: string }>;
}

export interface DetailRule {
  /** Which column of the row holds the address to open. Usually "link". */
  follow: string;
  fields: Record<string, FieldRule>;
  /**
   * How many rows to walk into. Every one is a page load, so this is the difference between a robot
   * that takes a minute and one that takes an hour — the cap is part of the scenario, not a guess.
   */
  maxRows: number;
}

export type PaginationRule =
  | { type: 'none' }
  /**
   * Paging by a URL parameter whose value comes from the last row on the page — a cursor.
   * This is how message archives and many APIs-behind-HTML work: ?before=<id of the oldest item>.
   */
  | {
      type: 'param';
      param: string;
      from: string;
      pattern?: string;
      /** Which row's cursor to take: the last one, or the smallest/largest id on the page. */
      pick?: 'last' | 'min' | 'max';
      maxPages: number;
    }
  /**
   * A numbered pager: ?page=2, ?page=3, and so on. No cursor, no next link — most job boards mark the
   * page they are on with a class that is generated at build time and changes with the next deploy,
   * so the only durable thing about such a pager is the number itself.
   */
  | { type: 'number'; param: string; start?: number; step?: number; maxPages: number }
  | { type: 'link'; next: string; maxPages: number }
  | { type: 'button'; next: string; maxPages: number }
  | { type: 'scroll'; maxRounds: number; settleMs: number };

export class ScenarioError extends Error {}

/** Parse and validate in one step — a scenario is only ever used after this. Callers get one error type. */
export function parseScenario(raw: string | unknown): Scenario {
  const data = typeof raw === 'string' ? parseJson(raw) : raw;
  if (!isRecord(data)) throw new ScenarioError('scenario must be an object');

  const name = req(data, 'name', 'string');
  const url = req(data, 'url', 'string');
  if (data['version'] !== 1) throw new ScenarioError(`${name}: unsupported version, expected 1`);
  if (!/^https?:\/\//.test(url)) throw new ScenarioError(`${name}: url must be http(s)`);

  const wait = data['wait'];
  if (!isRecord(wait)) throw new ScenarioError(`${name}: wait rule is required`);
  req(wait, 'selector', 'string');

  const list = data['list'];
  if (!isRecord(list)) throw new ScenarioError(`${name}: list rule is required`);
  req(list, 'rows', 'string');
  const fields = list['fields'];
  if (!isRecord(fields) || Object.keys(fields).length === 0) {
    throw new ScenarioError(`${name}: list.fields must name at least one field`);
  }
  for (const [field, rule] of Object.entries(fields)) {
    if (!isRecord(rule)) throw new ScenarioError(`${name}: field ${field} must be an object`);
    const type = rule['type'];
    if (type !== 'text' && type !== 'attr' && type !== 'html') {
      throw new ScenarioError(`${name}: field ${field} has unknown type ${String(type)}`);
    }
    if (type === 'attr' && typeof rule['attr'] !== 'string') {
      throw new ScenarioError(`${name}: field ${field} is an attr field but names no attribute`);
    }
  }

  const detail = data['detail'];
  if (detail !== undefined) {
    if (!isRecord(detail)) throw new ScenarioError(`${name}: detail must be an object`);
    if (typeof detail['follow'] !== 'string') throw new ScenarioError(`${name}: detail.follow must name a column`);
    const detailFields = detail['fields'];
    if (!isRecord(detailFields) || Object.keys(detailFields).length === 0) {
      throw new ScenarioError(`${name}: detail.fields must name at least one field`);
    }
    if (fields[detail['follow'] as string] === undefined) {
      throw new ScenarioError(`${name}: detail.follow names "${String(detail['follow'])}", which the list does not collect`);
    }
  }

  const pagination = data['pagination'];
  if (!isRecord(pagination)) throw new ScenarioError(`${name}: pagination is required, use {"type":"none"}`);

  const expect = isRecord(data['expect']) ? data['expect'] : {};
  return {
    ...(data as unknown as Scenario),
    wait: {
      selector: wait['selector'] as string,
      minCount: numberOr(wait['minCount'], 1),
      timeoutMs: numberOr(wait['timeoutMs'], 15_000),
      settleMs: numberOr(wait['settleMs'], 2_000),
    },
    expect: { minRowsPerPage: numberOr(expect['minRowsPerPage'], 1) },
    ...(isRecord(detail)
      ? {
          detail: {
            follow: detail['follow'] as string,
            fields: detail['fields'] as Record<string, FieldRule>,
            maxRows: numberOr(detail['maxRows'], 40),
          },
        }
      : {}),
  };
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new ScenarioError(`scenario is not valid JSON: ${(error as Error).message}`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function req(data: Record<string, unknown>, key: string, type: 'string'): string {
  const value = data[key];
  if (typeof value !== type) throw new ScenarioError(`${key} is required and must be a ${type}`);
  return value as string;
}
