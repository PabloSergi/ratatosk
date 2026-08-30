import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { buildWithModel } from '../agent.js';
import { buildScenario, paginateProbe, tryFields } from '../build.js';
import type { BrowserSession } from '../drivers/patchright.js';
import { openBrowser } from '../drivers/patchright.js';
import { look } from '../look.js';
import { archivePrevious, listRobots, loadRobot, saveRobot } from '../robots.js';
import { applyRules, type SiteRule } from '../rules.js';
import { resolveScope, type Scope } from '../scope.js';
import { activeConnection, settingsFileFor } from '../settings.js';
import { repairScenario } from '../repair.js';
import { runRobot } from '../run-robot.js';
import { runScenario } from '../run.js';
import { isTelegramRobot } from '../telegram.js';
import type { FieldRule, PaginationRule } from '../scenario.js';

/**
 * Two surfaces, deliberately kept apart.
 *
 * Building — open, look, try, paginate_probe, save — is the iterative loop an agent works a site with.
 * Consuming — robots, fetch — is for an agent that just wants data and should never learn what a
 * selector is.
 *
 * Few tools, strict schemas, and errors that say what to do next. A server that exposes its whole API
 * one-to-one makes the model read documentation instead of doing the work.
 */

const FIELD_SCHEMA = z
  .object({
    type: z.enum(['text', 'attr', 'html']).describe('text collapses whitespace; attr reads an attribute; html keeps markup'),
    selector: z.string().optional().describe('CSS selector INSIDE the row block; omit to read the block itself'),
    attr: z.string().optional().describe('attribute name, required when type is attr'),
    absolute: z.boolean().optional().describe('resolve a URL attribute against the page'),
    optional: z.boolean().optional().describe('a missing value here is not damage'),
  })
  .describe('one column of the result');

const PAGINATION_SCHEMA = z
  .discriminatedUnion('type', [
    z.object({ type: z.literal('none') }),
    z.object({ type: z.literal('link'), next: z.string(), maxPages: z.number().int().positive() }),
    z.object({ type: z.literal('button'), next: z.string(), maxPages: z.number().int().positive() }),
    z.object({ type: z.literal('scroll'), maxRounds: z.number().int().positive(), settleMs: z.number().int().nonnegative() }),
  ])
  .describe('how the list continues — take it from paginate_probe rather than guessing');

let session: BrowserSession | undefined;
let rules: SiteRule[] = [];
/** Whose robots this server speaks for — see src/scope.ts. */
let scope: Scope;

async function page() {
  if (!session) throw new Error('no page is open — call open(url) first');
  return session.page;
}

function ok(value: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }] };
}

function fail(message: string) {
  return { isError: true, content: [{ type: 'text' as const, text: message }] };
}

const server = new McpServer({ name: 'ratatosk', version: '0.1.0' });

server.registerTool(
  'open',
  {
    title: 'Open a page',
    description: 'Open a URL in the browser and clear anything in the way. Start every build here.',
    inputSchema: { url: z.string().url(), settleMs: z.number().int().min(0).max(30_000).optional() },
  },
  async ({ url, settleMs }) => {
    if (!session) session = await openBrowser();
    await session.page.goto(url);
    await session.page.waitMs(settleMs ?? 2500);
    const applied = await applyRules(session.page, rules);
    const sketch = await look(session.page);
    return ok({ url: sketch.url, title: sketch.title, rulesApplied: applied, notes: sketch.notes });
  },
);

server.registerTool(
  'look',
  {
    title: 'Look at the page',
    description:
      'The page as structure, not markup: repeating blocks with a proposed selector, what one block holds, ' +
      'field roles, how the page continues, and anything that changes handling. About 400 tokens.',
    inputSchema: {},
  },
  async () => ok(await look(await page())),
);

server.registerTool(
  'try',
  {
    title: 'Try a row selector and fields',
    description:
      'Run a candidate selector and field map against the open page and see what really comes back, ' +
      'including what looks wrong: empty columns, columns that never vary, columns that repeat each other.',
    inputSchema: {
      rows: z.string().describe('CSS selector for the repeating block'),
      fields: z.record(z.string(), FIELD_SCHEMA).describe('column name → how to read it'),
    },
  },
  async ({ rows, fields }) => ok(await tryFields(await page(), { rows, fields: fields as Record<string, FieldRule> })),
);

server.registerTool(
  'paginate_probe',
  {
    title: 'Prove how the page continues',
    description:
      'Find the next control and press it, then check the rows actually changed. Returns a pagination ' +
      'rule that has been used, not one that was guessed. Leaves the browser on the next page.',
    inputSchema: { rows: z.string(), maxPages: z.number().int().positive().max(500).optional() },
  },
  async ({ rows, maxPages }) => ok(await paginateProbe(await page(), rows, maxPages ?? 20)),
);

server.registerTool(
  'save',
  {
    title: 'Save a robot',
    description:
      'Freeze the scenario as a robot — but only after running it and getting rows. A scenario that ' +
      'does not run is refused here rather than returning nothing next Tuesday.',
    inputSchema: {
      name: z.string().min(1),
      url: z.string().url(),
      rows: z.string(),
      fields: z.record(z.string(), FIELD_SCHEMA),
      pagination: PAGINATION_SCHEMA.optional(),
      minRowsPerPage: z.number().int().positive().optional(),
    },
  },
  async ({ name, url, rows, fields, pagination, minRowsPerPage }) => {
    const scenario = buildScenario({
      name,
      url,
      rows,
      fields: fields as Record<string, FieldRule>,
      pagination: (pagination as PaginationRule) ?? { type: 'none' },
      minRowsPerPage,
    });

    if (!session) session = await openBrowser();
    const proof = await runScenario(session.page, { ...scenario, pagination: { type: 'none' } }, { rules });
    if (proof.status !== 'ok') {
      return fail(
        `not saved: the scenario ran and came back ${proof.status} — ${proof.reason ?? 'no reason recorded'}. ` +
          `Evidence: ${JSON.stringify(proof.evidence)}. Fix the selectors with try, then save again.`,
      );
    }

    const path = await saveRobot(scenario, scope.robotsDir);
    return ok({ saved: path, provenRows: proof.rows.length, sample: proof.rows[0] });
  },
);

server.registerTool(
  'build',
  {
    title: 'Build a robot from a description',
    description:
      'Hand the whole build to the model: a URL and a sentence about what is wanted, and it works the ' +
      'page through the same tools until every column asked for is filled — or comes back saying why ' +
      'not. Use it when you want data from a site that has no robot yet and do not care about selectors.',
    inputSchema: {
      url: z.string().url(),
      want: z.string().describe('what to pull out, in plain words: "vacancies: title, link, city, pay"'),
      name: z.string().min(1),
    },
  },
  async ({ url, want, name }) => {
    const connection = scope.userId ? await activeConnection(settingsFileFor(scope.userId)) : undefined;
    if (!connection) return fail('this account has no model connection — add one in the web view, Model section');

    if (!session) session = await openBrowser();
    const result = await buildWithModel(session.page, {
      url,
      want,
      name,
      rules,
      apiKey: connection.key,
      model: connection.model,
      baseUrl: connection.baseUrl,
    });

    if (!result.scenario || !result.verdict?.good) {
      return fail(
        `not saved: ${result.reason ?? 'the quality gate was not passed'}. ` +
          `Steps taken: ${result.steps.map((step) => step.tool).join(' → ')}.`,
      );
    }

    const path = await saveRobot(result.scenario, scope.robotsDir);
    return ok({
      saved: path,
      rows: result.rows.length,
      coverage: result.verdict.coverage,
      pagination: result.scenario.pagination,
      modelCalls: result.usage.calls,
      sample: result.rows[0],
    });
  },
);

server.registerTool(
  'robots',
  {
    title: 'List robots',
    description: 'The robots that exist, with the columns each one returns. No selectors — you do not need them.',
    inputSchema: {},
  },
  async () => ok(await listRobots(scope.robotsDir)),
);

server.registerTool(
  'fetch',
  {
    title: 'Fetch data from a robot',
    description:
      'Run a saved robot and return its rows. This is the whole consuming surface: name in, data out. ' +
      'A run that comes back empty or broken says so, with the reason — it never pretends to be success.',
    inputSchema: { name: z.string(), maxPages: z.number().int().positive().max(200).optional() },
  },
  async ({ name, maxPages }) => {
    const robot = await loadRobot(name, scope.robotsDir);
    const result = await runRobot(robot, {
      page: async () => {
        if (!session) session = await openBrowser();
        return session.page;
      },
      rules,
      maxPages,
      telegramSession: scope.telegramSession,
    });

    if (result.status !== 'ok') {
      return fail(
        `${name}: ${result.status} — ${result.reason ?? 'no reason recorded'}. Evidence: ${JSON.stringify(result.evidence)}. ` +
          `If the site changed, call repair("${name}") — it rebuilds the robot and shows what changed.`,
      );
    }
    return ok({ status: result.status, pages: result.pagesVisited, count: result.rows.length, rows: result.rows });
  },
);

server.registerTool(
  'repair',
  {
    title: 'Repair a broken robot',
    description:
      'Run a robot, and if it comes back empty or broken, work out what the page looks like now: keep ' +
      'every field that still works, replace the ones that died, re-probe pagination if the control is ' +
      'gone, and prove the result by running it. Returns what changed. The previous version is kept.',
    inputSchema: {
      name: z.string(),
      apply: z.boolean().optional().describe('write the repaired robot (default true); false to review the diff first'),
    },
  },
  async ({ name, apply }) => {
    const robot = await loadRobot(name, scope.robotsDir);
    if (isTelegramRobot(robot)) {
      return fail(`${name} reads Telegram, and there are no selectors to repair — edit its channels instead.`);
    }
    if (!session) session = await openBrowser();
    const repair = await repairScenario(session.page, robot, { rules });

    if (repair.status === 'not-needed') {
      return ok({ status: repair.status, rows: repair.before.rows.length, note: 'the robot still works — nothing changed' });
    }
    if (repair.status === 'unfixable') {
      return fail(
        `${name} could not be repaired: ${repair.reason ?? 'no reason recorded'}. ` +
          `The run came back ${repair.before.status} — ${repair.before.reason ?? ''}. ` +
          `Look at the page yourself with open + look, then save a new version.`,
      );
    }

    const written =
      apply === false
        ? undefined
        : (await archivePrevious(name, scope.robotsDir), await saveRobot(repair.scenario!, scope.robotsDir));
    return ok({
      status: repair.status,
      changed: repair.diff,
      rowsBefore: repair.before.rows.length,
      rowsAfter: repair.after?.rows.length,
      saved: written ?? 'not written — apply was false',
      scenario: apply === false ? repair.scenario : undefined,
    });
  },
);

async function loadRules(dir: string): Promise<SiteRule[]> {
  try {
    const names = await readdir(dir);
    const files = names.filter((file) => file.endsWith('.json'));
    return await Promise.all(files.map(async (file) => JSON.parse(await readFile(join(dir, file), 'utf8')) as SiteRule));
  } catch {
    return [];
  }
}

const shutdown = async () => {
  await session?.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

rules = await loadRules('rules');
// A token from the web view names the account; without accounts, this is somebody's own machine.
scope = await resolveScope(process.env['RATATOSK_TOKEN']);
console.error(`ratatosk mcp — robots of ${scope.who}`);
await server.connect(new StdioServerTransport());
