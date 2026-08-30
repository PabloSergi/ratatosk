import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { openBrowser } from './drivers/patchright.js';
import { look } from './look.js';
import { applyRules, type SiteRule } from './rules.js';

/** See what a model would see: `node dist/look-cli.js <url> [--wait ms]` */
async function main(): Promise<number> {
  const args = process.argv.slice(2);
  const url = args.find((arg) => !arg.startsWith('--'));
  if (!url) {
    console.error('usage: look <url> [--wait 3000]');
    return 2;
  }
  const waitIndex = args.indexOf('--wait');
  const settle = waitIndex >= 0 ? Number(args[waitIndex + 1]) : 3000;

  const rules = await loadRules('rules');
  const session = await openBrowser();
  try {
    await session.page.goto(url);
    await session.page.waitMs(settle);
    const applied = await applyRules(session.page, rules);
    const sketch = await look(session.page);
    const json = JSON.stringify({ ...sketch, rulesApplied: applied }, null, 2);
    console.log(json);
    console.error(`\n— ${json.length} characters, about ${Math.round(json.length / 4)} tokens`);
    return 0;
  } finally {
    await session.close();
  }
}

async function loadRules(dir: string): Promise<SiteRule[]> {
  try {
    const names = await readdir(dir);
    const files = names.filter((name) => name.endsWith('.json'));
    return await Promise.all(files.map(async (name) => JSON.parse(await readFile(join(dir, name), 'utf8')) as SiteRule));
  } catch {
    return [];
  }
}

main().then(
  (code) => process.exit(code),
  (error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(2);
  },
);
