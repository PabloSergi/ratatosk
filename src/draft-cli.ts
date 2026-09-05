import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { draftScenario } from './draft.js';
import { openBrowser } from './drivers/patchright.js';
import { loadRules, type SiteRule } from './rules.js';

/**
 * The build loop from the command line: `node dist/draft-cli.js <url> [--name jobs] [--out path.json]`
 * Same steps a model would drive, driven by heuristics instead — see src/draft.ts.
 */
async function main(): Promise<number> {
  const args = process.argv.slice(2);
  const url = args.find((arg) => !arg.startsWith('--'));
  if (!url) {
    console.error('usage: draft <url> [--name NAME] [--out PATH]');
    return 2;
  }
  const option = (flag: string): string | undefined => {
    const index = args.indexOf(flag);
    return index >= 0 ? args[index + 1] : undefined;
  };
  const name = option('--name') ?? new URL(url).hostname.replace(/^www\./, '').split('.')[0]!;
  const out = option('--out') ?? `examples/${name}.json`;

  const rules = await loadRules('rules');
  const session = await openBrowser();
  try {
    const draft = await draftScenario(session.page, { url, name, rules });
    for (const line of draft.log) console.log(line);
    if (!draft.scenario) {
      console.error(draft.reason ?? 'no draft');
      return 1;
    }
    await writeFile(out, `${JSON.stringify(draft.scenario, null, 2)}\n`, 'utf8');
    console.log(`saved ${out}`);
    console.log(JSON.stringify(draft.sample, null, 2));
    return 0;
  } finally {
    await session.close();
  }
}


main().then(
  (code) => process.exit(code),
  (error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(2);
  },
);
