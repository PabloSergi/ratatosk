import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { openBrowser } from './drivers/patchright.js';
import type { PageDriver } from './driver.js';
import { memoryFileFor, readMemory, writeMemory } from './memory.js';
import { repairScenario } from './repair.js';
import { parseRobot, type Robot } from './robots.js';
import { runRobot } from './run-robot.js';
import { loadRules, type SiteRule } from './rules.js';
import { resolveScope } from './scope.js';
import { isTelegramRobot, sessionForRobot } from './telegram.js';

/**
 * One scraper from the command line: `node dist/cli.js path/to/scraper.json [--headed] [--json]`
 *
 * This is the path cron takes, so it has to run whatever the web view can run — a page walk and a
 * Telegram read alike. It used to open a browser and demand a URL, which meant the documented way to
 * schedule a Telegram scraper answered "url is required" and there was no other way to schedule one.
 *
 * The browser is opened only if the scraper turns out to need one: starting Chromium to read a channel
 * is a gigabyte of nothing.
 */
async function main(): Promise<number> {
  const args = process.argv.slice(2);
  const path = args.find((arg) => !arg.startsWith('--'));
  if (!path) {
    console.error('usage: ratatosk <scraper.json> [--headed] [--json] [--repair]');
    return 2;
  }

  const robot = parseRobot(JSON.parse(await readFile(path, 'utf8')));
  const rules = await loadRules('rules');

  // Opened on demand and closed once, however many times the run asks for it.
  let opened: Awaited<ReturnType<typeof openBrowser>> | undefined;
  const page = async (): Promise<PageDriver> => {
    opened ??= await openBrowser(args.includes('--headed') ? { headless: false } : {});
    return opened.page;
  };

  try {
    const started = Date.now();

    if (args.includes('--repair')) {
      if (isTelegramRobot(robot)) {
        // Nothing here rots the way a selector does: a channel is read through a client, not scraped
        // off a page. What goes wrong is the rule, and that is repaired where the rule lives.
        console.error('a Telegram scraper has no selectors to repair — rebuild its rule in the web view');
        return 2;
      }
      const repair = await repairScenario(await page(), robot, { rules });
      console.log(`${robot.name}: ${repair.status}`);
      if (repair.reason) console.log(`reason: ${repair.reason}`);
      for (const line of repair.diff) console.log(`  ${line}`);
      if (repair.status === 'repaired') {
        await writeFile(path, `${JSON.stringify(repair.scenario, null, 2)}\n`, 'utf8');
        console.log(`rewrote ${path} — ${repair.after?.rows.length} rows where there were ${repair.before.rows.length}`);
      }
      return repair.status === 'unfixable' ? 1 : 0;
    }

    const result = await runRobot(robot, {
      page,
      rules,
      ...(await telegramFor(robot)),
      ...(await memoryFor(robot)),
    });
    const seconds = ((Date.now() - started) / 1000).toFixed(1);

    if (args.includes('--json')) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(`${robot.name}: ${result.status} — ${result.rows.length} rows from ${result.pagesVisited} page(s) in ${seconds}s`);
      if (result.reason) console.log(`reason: ${result.reason}`);
      if (result.evidence) console.log(`evidence: ${JSON.stringify(result.evidence)}`);
      for (const applied of result.rulesApplied ?? []) console.log(`rule: ${applied}`);
      for (const row of result.rows.slice(0, 3)) console.log(`  ${JSON.stringify(row)}`);
      if (result.rows.length > 3) console.log(`  … and ${result.rows.length - 3} more`);
    }
    return result.status === 'ok' ? 0 : 1;
  } finally {
    await opened?.close();
  }
}

/**
 * The session a Telegram scraper reads with. An installation with accounts keeps one per account and
 * needs to be told whose — the same token the MCP server takes. A single-user machine has one session
 * and no accounts to choose between.
 */
async function telegramFor(robot: Robot): Promise<{ telegramSession?: string }> {
  if (!isTelegramRobot(robot)) return {};

  const scope = await resolveScope(process.env['RATATOSK_TOKEN']);
  const session = scope.userId
    ? await sessionForRobot(scope.userId, robot.account)
    : (process.env['RATATOSK_TG_SESSION'] ?? 'secrets/telegram.json');

  if (!session) throw new Error(`no Telegram account is connected for ${scope.who} — connect one in the web view`);
  return { telegramSession: session };
}

/**
 * What this scraper has already handed over, when it is one that remembers. Without this a scheduled
 * run returns the whole channel every half hour and the memory feature exists only in the web view.
 */
async function memoryFor(robot: Robot): Promise<{ memory?: Parameters<typeof runRobot>[1]['memory'] }> {
  if (!robot.remember) return {};

  const scope = await resolveScope(process.env['RATATOSK_TOKEN']);
  const file = memoryFileFor(scope.userId ?? 'local', robot.name);
  return { memory: { seen: await readMemory(file), save: (next) => writeMemory(file, next) } };
}


main().then(
  (code) => process.exit(code),
  (error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(2);
  },
);
