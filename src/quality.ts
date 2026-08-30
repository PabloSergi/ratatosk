import type { ListRule, Scenario } from './scenario.js';

/**
 * What separates a robot from something that merely returned rows.
 *
 * "More than zero rows" is the floor, and a floor is not a bar: a scenario that finds eight cards,
 * fills one column in one of them and never finds the next page will pass it, and then quietly
 * under-deliver forever. The gate below is what a person would check by eye before trusting a robot,
 * written down so nothing gets waved through.
 */
export interface QualityVerdict {
  good: boolean;
  /** Share of rows in which each column is filled, 0…1. */
  coverage: Record<string, number>;
  /** What is not good enough, phrased as work to be done. */
  complaints: string[];
}

export const COVERAGE_BAR = 0.8;

export function judge(input: {
  rows: Array<Record<string, string | null>>;
  fields: ListRule['fields'];
  blocksSeen: number;
  /** Whether a next-page control was found AND used. Undefined when nothing was probed yet. */
  paginationProven?: boolean;
  /** Columns the person actually asked for. Their absence is a complaint, not a detail. */
  wanted?: string[];
}): QualityVerdict {
  const complaints: string[] = [];
  const coverage: Record<string, number> = {};

  if (input.rows.length === 0) {
    return { good: false, coverage, complaints: ['no rows at all'] };
  }

  for (const [name, rule] of Object.entries(input.fields)) {
    const filled = input.rows.filter((row) => row[name] !== null && row[name] !== undefined && row[name] !== '').length;
    const share = filled / input.rows.length;
    coverage[name] = Math.round(share * 100) / 100;
    if (rule.optional) continue;
    if (share < COVERAGE_BAR) {
      complaints.push(
        `"${name}" is filled in only ${filled} of ${input.rows.length} rows — the selector fits one variant of the card, not the card`,
      );
    }
  }

  for (const name of input.wanted ?? []) {
    if (!(name in input.fields)) complaints.push(`"${name}" was asked for and is not in the result at all`);
  }

  // Half the cards on the page turning into rows usually means the row selector caught a sub-type.
  if (input.blocksSeen > 0 && input.rows.length < input.blocksSeen * 0.6) {
    complaints.push(`only ${input.rows.length} of ${input.blocksSeen} blocks became rows — the rest filled nothing`);
  }

  if (input.paginationProven === false) {
    complaints.push('a next-page control was found but never worked — this scraper would see only the first page');
  }

  return { good: complaints.length === 0, coverage, complaints };
}

/** The same judgement for a scenario that has already run, used before saving and after repairing. */
export function judgeRun(
  scenario: Scenario,
  rows: Array<Record<string, string | null>>,
  blocksSeen: number,
  wanted?: string[],
): QualityVerdict {
  return judge({
    rows,
    fields: scenario.list.fields,
    blocksSeen,
    paginationProven: scenario.pagination.type !== 'none',
    wanted,
  });
}
