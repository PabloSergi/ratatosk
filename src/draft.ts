import { buildScenario, fieldsFromRoles, paginateProbe, tryFields, widenRows } from './build.js';
import type { PageDriver } from './driver.js';
import { look } from './look.js';
import { judge, type QualityVerdict } from './quality.js';
import { applyRules, type SiteRule } from './rules.js';
import { runScenario } from './run.js';
import type { FieldRule, Scenario } from './scenario.js';

/**
 * The whole build loop driven by heuristics instead of a model: look → try → paginate_probe → save.
 * Everything that can be settled by arithmetic — which blocks repeat, which column is a label, whether
 * the control actually works — is settled before a token is spent. What reaches a model is the rest.
 */
export interface DraftResult {
  scenario?: Scenario;
  /** Every step, in the order it happened, so a human can see why the draft looks the way it does. */
  log: string[];
  provenRows: number;
  sample?: Record<string, string | null>;
  reason?: string;
  /** Heuristics take the first thing that works; this says how good "works" actually was. */
  verdict?: QualityVerdict;
}

export async function draftScenario(
  page: PageDriver,
  input: { url: string; name: string; rules?: SiteRule[]; settleMs?: number },
): Promise<DraftResult> {
  const rules = input.rules ?? [];
  const log: string[] = [];

  await page.goto(input.url);
  await page.waitMs(input.settleMs ?? 3000);
  for (const applied of await applyRules(page, rules)) log.push(`rule: ${applied}`);

  const sketch = await look(page);
  for (const note of sketch.notes) log.push(`note: ${note}`);
  if (sketch.candidates.length === 0) {
    return { log, provenRows: 0, reason: 'no repeating blocks on this page — nothing to build a scenario from' };
  }

  let chosen: { rows: string; fields: Record<string, FieldRule>; count: number } | undefined;
  for (const candidate of sketch.candidates.slice(0, 3)) {
    const fields = fieldsFromRoles(candidate.fields);
    if (Object.keys(fields).length === 0) continue;

    const attempt = await tryFields(page, { rows: candidate.selector, fields });
    log.push(`try: ${candidate.selector} → ${attempt.rows} rows of ${attempt.blocksSeen} blocks`);
    for (const warning of attempt.warnings) log.push(`  warning: ${warning}`);

    const kept = withoutUselessFields(fields, attempt.warnings);
    const dropped = Object.keys(fields).filter((field) => !(field in kept));
    if (dropped.length) log.push(`  dropped as empty of meaning: ${dropped.join(', ')}`);

    if (!chosen && attempt.rows >= 3 && Object.keys(kept).length > 0) {
      chosen = { rows: candidate.selector, fields: kept, count: attempt.rows };
    }
  }
  if (!chosen) return { log, provenRows: 0, reason: 'none of the candidates produced usable rows' };

  const wider = await widenRows(page, { rows: chosen.rows, fields: chosen.fields });
  if (wider.widened) {
    log.push(`widen: ${chosen.rows} → ${wider.rows} (${wider.count} rows, same quality)`);
    chosen = { ...chosen, rows: wider.rows, count: wider.count };
  }

  const probe = await paginateProbe(page, chosen.rows);
  log.push(`probe: ${probe.note}`);

  const scenario = buildScenario({
    name: input.name,
    url: input.url,
    rows: chosen.rows,
    fields: chosen.fields,
    pagination: probe.worked ? probe.pagination : { type: 'none' },
    minRowsPerPage: Math.max(1, Math.floor(chosen.count / 2)),
  });

  // Nothing is called a draft until it has run and produced rows.
  const proof = await runScenario(page, { ...scenario, pagination: { type: 'none' } }, { rules });
  if (proof.status !== 'ok') {
    return { log, provenRows: 0, reason: `the draft does not run — ${proof.status}: ${proof.reason ?? ''}`.trim() };
  }

  const verdict = judge({
    rows: proof.rows,
    fields: scenario.list.fields,
    blocksSeen: proof.evidence?.blocksSeen ?? proof.rows.length,
    paginationProven: scenario.pagination.type !== 'none',
  });

  log.push(`proven on one page: ${proof.rows.length} rows`);
  for (const complaint of verdict.complaints) log.push(`  weak: ${complaint}`);

  return { scenario, log, provenRows: proof.rows.length, sample: proof.rows[0], verdict };
}

/**
 * A column that says the same thing in every row, or repeats another column, carries no information.
 * Dropping it is arithmetic, not taste, so the draft does it instead of leaving the mess for a model.
 */
function withoutUselessFields(fields: Record<string, FieldRule>, warnings: string[]): Record<string, FieldRule> {
  const useless = new Set(
    warnings
      .filter((warning) => warning.includes('identical in every row') || warning.includes('repeats "'))
      .map((warning) => warning.slice(1, warning.indexOf('"', 1))),
  );
  return Object.fromEntries(Object.entries(fields).filter(([field]) => !useless.has(field)));
}
