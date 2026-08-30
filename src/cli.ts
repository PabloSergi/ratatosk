import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { openBrowser } from './drivers/patchright.js';
import { repairScenario } from './repair.js';
import { runScenario } from './run.js';
import type { SiteRule } from './rules.js';
import { parseScenario } from './scenario.js';

/** Run one scenario against a real browser: `node dist/cli.js path/to/scenario.json [--headed] [--json]` */
async function main(): Promise<number> {
  const args = process.argv.slice(2);
  const path = args.find((arg) => !arg.startsWith('--'));
  if (!path) {
    console.error('usage: ratatosk <scenario.json> [--headed] [--json] [--repair]');
    return 2;
  }

  const scenario = parseScenario(await readFile(path, 'utf8'));
  const rules = await loadRules('rules');
  const session = await openBrowser(args.includes('--headed') ? { headless: false } : {});
  try {
    const started = Date.now();

    if (args.includes('--repair')) {
      const repair = await repairScenario(session.page, scenario, { rules });
      console.log(`${scenario.name}: ${repair.status}`);
      if (repair.reason) console.log(`reason: ${repair.reason}`);
      for (const line of repair.diff) console.log(`  ${line}`);
      if (repair.status === 'repaired') {
        await writeFile(path, `${JSON.stringify(repair.scenario, null, 2)}\n`, 'utf8');
        console.log(`rewrote ${path} — ${repair.after?.rows.length} rows where there were ${repair.before.rows.length}`);
      }
      return repair.status === 'unfixable' ? 1 : 0;
    }

    const result = await runScenario(session.page, scenario, { rules });
    const seconds = ((Date.now() - started) / 1000).toFixed(1);

    if (args.includes('--json')) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(`${scenario.name}: ${result.status} — ${result.rows.length} rows from ${result.pagesVisited} page(s) in ${seconds}s`);
      if (result.reason) console.log(`reason: ${result.reason}`);
      if (result.evidence) console.log(`evidence: ${JSON.stringify(result.evidence)}`);
      for (const applied of result.rulesApplied ?? []) console.log(`rule: ${applied}`);
      for (const row of result.rows.slice(0, 3)) console.log(`  ${JSON.stringify(row)}`);
      if (result.rows.length > 3) console.log(`  … and ${result.rows.length - 3} more`);
    }
    return result.status === 'ok' ? 0 : 1;
  } finally {
    await session.close();
  }
}

/** Rules live as one JSON file per site in rules/. A missing directory simply means no rules. */
async function loadRules(dir: string): Promise<SiteRule[]> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  const files = names.filter((name) => name.endsWith('.json'));
  return Promise.all(files.map(async (name) => JSON.parse(await readFile(join(dir, name), 'utf8')) as SiteRule));
}

main().then(
  (code) => process.exit(code),
  (error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(2);
  },
);
