import { buildScenario, fieldsFromRoles, paginateProbe, tryFields } from './build.js';
import type { PageDriver } from './driver.js';
import { look } from './look.js';
import { applyRules, type SiteRule } from './rules.js';
import { runScenario, type RunResult } from './run.js';
import type { FieldRule, Scenario } from './scenario.js';

/**
 * Self-repair. This is the part people pay for.
 *
 * Sites change their markup, selectors rot, and robots die quietly — the owner finds out a month later
 * from an empty table. Here a run that comes back empty or broken is treated as a job: look at the page
 * again, work out what the rows are now, keep every field that still works, replace the ones that do
 * not, and prove the result by running it. What changed is shown, never applied behind someone's back.
 */
export interface RepairResult {
  status: 'not-needed' | 'repaired' | 'unfixable';
  before: RunResult;
  after?: RunResult;
  scenario?: Scenario;
  /** What changed, in words a human can check. Empty when nothing needed changing. */
  diff: string[];
  reason?: string;
}

export async function repairScenario(
  page: PageDriver,
  scenario: Scenario,
  options: { rules?: SiteRule[] } = {},
): Promise<RepairResult> {
  const rules = options.rules ?? [];
  const before = await runScenario(page, scenario, { rules });
  if (before.status === 'ok') {
    return { status: 'not-needed', before, diff: [] };
  }

  await page.goto(scenario.url);
  await page.waitMs(scenario.wait.settleMs + 1500);
  await applyRules(page, rules);

  const sketch = await look(page);
  const diff: string[] = [];

  // The row selector first: everything else is read inside it, so a wrong one makes every field wrong.
  const candidate = await pickRows(page, scenario, sketch.candidates);
  if (!candidate) {
    return {
      status: 'unfixable',
      before,
      diff,
      reason: `nothing on ${scenario.url} looks like the old rows, and no repeating block yields data — the page may be a challenge, or the list may have moved`,
    };
  }
  if (candidate.rows !== scenario.list.rows) {
    diff.push(`rows: "${scenario.list.rows}" → "${candidate.rows}"`);
  }

  // Then the fields: keep everything that still works, replace only what died.
  const fields = await mendFields(page, scenario, candidate.rows, sketch.candidates, diff);
  if (Object.keys(fields).length === 0) {
    return { status: 'unfixable', before, diff, reason: `no field survived on "${candidate.rows}" and nothing on the page replaces them` };
  }

  // Pagination: only touched if the old control is gone.
  let pagination = scenario.pagination;
  if (pagination.type === 'link' || pagination.type === 'button') {
    const present = await page.evaluate<boolean>(`(selector) => Boolean(document.querySelector(selector))`, pagination.next);
    if (!present) {
      const probe = await paginateProbe(page, candidate.rows, pagination.maxPages);
      pagination = probe.worked ? probe.pagination : { type: 'none' };
      diff.push(`pagination: "${scenario.pagination.type === 'none' ? 'none' : (scenario.pagination as { next: string }).next}" is gone → ${describe(pagination)}`);
      await page.goto(scenario.url);
      await page.waitMs(scenario.wait.settleMs + 1000);
      await applyRules(page, rules);
    }
  }

  // Everything this repair did not decide to change comes along untouched. A rebuilt scenario is a
  // new object, and a new object silently loses whatever nobody remembered to copy: the way out this
  // robot goes through, and the walk into each row. Both would fail quietly — one by scraping from the
  // wrong address, the other by dropping a column nobody notices is gone.
  const repaired: Scenario = {
    ...buildScenario({
      name: scenario.name,
      url: scenario.url,
      rows: candidate.rows,
      fields,
      pagination,
      minRowsPerPage: Math.max(1, Math.min(scenario.expect.minRowsPerPage, Math.floor(candidate.rowCount / 2))),
    }),
    ...(scenario.proxy ? { proxy: scenario.proxy } : {}),
    ...(scenario.detail ? { detail: scenario.detail } : {}),
  };

  const after = await runScenario(page, repaired, { rules });
  if (after.status !== 'ok') {
    return { status: 'unfixable', before, after, diff, reason: `the rebuilt scenario also came back ${after.status}: ${after.reason ?? ''}`.trim() };
  }

  return { status: 'repaired', before, after, scenario: repaired, diff };
}

/** The old row selector is tried first — a robot that still fits should not be rewritten for tidiness. */
async function pickRows(
  page: PageDriver,
  scenario: Scenario,
  candidates: Array<{ selector: string; count: number }>,
): Promise<{ rows: string; rowCount: number } | undefined> {
  const attempt = await tryFields(page, scenario.list);
  if (attempt.rows > 0) return { rows: scenario.list.rows, rowCount: attempt.rows };

  for (const candidate of candidates.slice(0, 3)) {
    const withOldFields = await tryFields(page, { rows: candidate.selector, fields: scenario.list.fields });
    if (withOldFields.rows > 0) return { rows: candidate.selector, rowCount: withOldFields.rows };
  }

  // Nothing keeps the old fields alive: fall back to whatever the page offers on its own terms.
  for (const candidate of candidates.slice(0, 3)) {
    const fresh = fieldsFromRoles((candidate as { fields?: Array<{ role: string; selector: string; attr?: string }> }).fields ?? []);
    if (Object.keys(fresh).length === 0) continue;
    const withNewFields = await tryFields(page, { rows: candidate.selector, fields: fresh });
    if (withNewFields.rows > 0) return { rows: candidate.selector, rowCount: withNewFields.rows };
  }

  return undefined;
}

/** Field names are the contract with whoever consumes the data, so they are preserved wherever possible. */
async function mendFields(
  page: PageDriver,
  scenario: Scenario,
  rows: string,
  candidates: Array<{ selector: string; fields?: Array<{ role: string; selector: string; attr?: string }> }>,
  diff: string[],
): Promise<Record<string, FieldRule>> {
  const attempt = await tryFields(page, { rows, fields: scenario.list.fields });
  const dead = new Set(
    attempt.warnings
      .filter((warning) => warning.includes('is empty in every block'))
      .map((warning) => warning.slice(1, warning.indexOf('"', 1))),
  );

  const fields: Record<string, FieldRule> = {};
  for (const [name, rule] of Object.entries(scenario.list.fields)) {
    if (!dead.has(name)) fields[name] = rule;
  }

  if (dead.size === 0) return fields;

  // Replacements come from what `look` found in the block, matched by role: a title takes a title's
  // place. A field with no candidate is dropped and said out loud — a silently missing column is
  // exactly the kind of loss this project exists to stop.
  const hints = candidates.find((candidate) => candidate.selector === rows)?.fields ?? [];
  const byRole = fieldsFromRoles(hints);

  for (const name of dead) {
    const replacement = byRole[name] ?? (name === 'url' ? byRole['url'] : undefined);
    if (replacement) {
      fields[name] = replacement;
      diff.push(`field "${name}": ${describeRule(scenario.list.fields[name]!)} → ${describeRule(replacement)}`);
    } else {
      diff.push(`field "${name}": ${describeRule(scenario.list.fields[name]!)} is gone and nothing on the page replaces it — dropped`);
    }
  }

  return fields;
}

function describeRule(rule: FieldRule): string {
  const target = rule.selector ?? '(the block itself)';
  return rule.type === 'attr' ? `${target}[${rule.attr}]` : target;
}

function describe(pagination: Scenario['pagination']): string {
  if (pagination.type === 'none') return 'single page';
  if (pagination.type === 'scroll') return 'infinite scroll';
  if (pagination.type === 'param') return `cursor "?${pagination.param}=" taken from "${pagination.from}"`;
  if (pagination.type === 'number') return `numbered pages, "?${pagination.param}=" counting up`;
  return `${pagination.type} "${pagination.next}"`;
}
