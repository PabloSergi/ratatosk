import { buildSift, type Ask } from './sift-agent.js';
import { judgeSift, sift, type Row, type Sift } from './sift.js';

/**
 * Self-repair for a rule, the same idea as self-repair for selectors.
 *
 * Selectors rot when a site changes its markup. A rule rots when people change how they write: a
 * channel that said "we're hiring" for a year starts saying something else, a forum grows a new kind
 * of spam, a word that meant one thing starts meaning another. Nothing errors; the robot simply
 * returns less, or returns rubbish, and nobody notices until somebody looks at the table.
 *
 * So a rule is measured against material collected now — how much it keeps, whether its drops eat its
 * own finds, and whether what it kept is really what was asked for. A rule that still holds is left
 * alone. One that does not is written again and proved on that same material before it replaces
 * anything, and what changed is shown in words.
 */
export interface RuleHealth {
  sampled: number;
  kept: number;
  collisions: number;
  /** Of the kept rows that were checked, how many did not belong. Absent when nothing was checked. */
  wrong?: number;
  checked?: number;
  good: boolean;
  note: string;
}

export interface RuleRepair {
  status: 'not-needed' | 'repaired' | 'unfixable';
  before: RuleHealth;
  after?: RuleHealth;
  sift?: Sift;
  /** What changed, pattern by pattern, in words a person can check. */
  diff: string[];
  reason?: string;
}

/** How wrong the kept rows may be before a rule counts as rotted. */
const WRONG_ENOUGH = 0.2;

export async function repairRule(input: {
  rows: Row[];
  sift: Sift;
  want?: string;
  ask: Ask;
  model?: { apiKey: string; model: string; baseUrl: string };
}): Promise<RuleRepair> {
  const want = input.want ?? input.sift.want ?? input.sift.judge?.want ?? '';
  const before = await measure(input.rows, input.sift, want, input.ask);

  if (before.good) return { status: 'not-needed', before, diff: [] };
  if (!want) {
    return {
      status: 'unfixable',
      before,
      diff: [],
      reason: 'this rule was written by hand and carries no task, so there is nothing to write it again from',
    };
  }

  const written = await buildSift({
    sample: input.rows,
    want,
    apiKey: input.model?.apiKey ?? '',
    model: input.model?.model ?? '',
    baseUrl: input.model?.baseUrl ?? '',
    ask: input.ask,
  });

  if (!written.sift) {
    return { status: 'unfixable', before, diff: [], reason: written.reason ?? 'no rule separated this material' };
  }

  const after = await measure(input.rows, written.sift, want, input.ask);
  if (!after.good) {
    return { status: 'unfixable', before, after, diff: [], reason: `the rewritten rule is no better: ${after.note}` };
  }

  return { status: 'repaired', before, after, sift: written.sift, diff: describe(input.sift, written.sift) };
}

/** What a rule does to this material, and whether that is still what was asked for. */
async function measure(rows: Row[], rule: Sift, want: string, ask: Ask): Promise<RuleHealth> {
  const result = sift(rows, rule);
  const verdict = judgeSift(result, rows.length);

  if (!verdict.good || !want) {
    return {
      sampled: rows.length,
      kept: result.kept,
      collisions: result.collisions.length,
      good: verdict.good,
      note: verdict.note,
    };
  }

  // Coverage is not correctness. A rule can keep a healthy number of rows and keep the wrong ones —
  // this is the only way to see that without a person reading every row.
  const batch = result.rows.slice(0, 15);
  const reply = await ask([
    {
      role: 'user',
      content:
        `Task: ${want}\n\n` +
        `A rule kept these as matching the task. Which do NOT match it?\n` +
        `Answer with JSON and nothing else: {"wrong":[1,3]} — or {"wrong":[]} if they all match.\n\n` +
        batch.map((row, index) => `${index + 1}. ${text(row).replace(/\s+/g, ' ').slice(0, 250)}`).join('\n'),
    },
  ]);

  const wrong = wrongOnes(reply.content, batch.length);
  const share = batch.length ? wrong / batch.length : 0;
  return {
    sampled: rows.length,
    kept: result.kept,
    collisions: result.collisions.length,
    checked: batch.length,
    wrong,
    good: share <= WRONG_ENOUGH,
    note:
      share > WRONG_ENOUGH
        ? `${verdict.note}, but ${wrong} of ${batch.length} checked were not what was asked`
        : `${verdict.note}${wrong ? `, ${wrong} of ${batch.length} checked were off` : ''}`,
  };
}

function wrongOnes(answer: string, count: number): number {
  const start = answer.indexOf('{');
  const end = answer.lastIndexOf('}');
  if (start === -1 || end <= start) return 0; // it did not answer in the form asked for; assume nothing
  try {
    const parsed = JSON.parse(answer.slice(start, end + 1)) as { wrong?: unknown };
    if (!Array.isArray(parsed.wrong)) return 0;
    return new Set(parsed.wrong.map(Number).filter((number) => number >= 1 && number <= count)).size;
  } catch {
    return 0;
  }
}

function text(row: Row): string {
  return Object.values(row)
    .filter((value): value is string => typeof value === 'string')
    .join('  ');
}

/** Pattern by pattern, so a person can see what the model decided to change and disagree with it. */
function describe(was: Sift, now: Sift): string[] {
  const lines: string[] = [];
  const compare = (title: string, before: string[] = [], after: string[] = []): void => {
    for (const pattern of after.filter((one) => !before.includes(one))) lines.push(`+ ${title}: ${pattern}`);
    for (const pattern of before.filter((one) => !after.includes(one))) lines.push(`− ${title}: ${pattern}`);
  };

  compare('keep', was.keep, now.keep);
  compare('drop', was.drop, now.drop);
  if (Boolean(was.judge) !== Boolean(now.judge)) {
    lines.push(now.judge ? '+ a model now looks at the edge cases' : '− the edge is no longer put to a model');
  }
  return lines;
}
