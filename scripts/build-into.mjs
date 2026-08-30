/**
 * Build a robot into an account, from the command line.
 *
 * The web view builds with the account's own connection and the account's own proxy; this is the same
 * thing without the browser in front of it — the maintenance path, for filling an account with robots
 * for sources it already had, or retrying the ones that did not come out the first time.
 *
 *   node scripts/build-into.mjs <userId> <url> <name> "<what is wanted>" [--proxy <proxyId>]
 *
 * Nothing is passed in by hand: the key, the model and the proxy are the ones that account chose.
 */
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { buildWithModel } from '../dist/agent.js';
import { openBrowser } from '../dist/drivers/patchright.js';
import { findProxy, proxiesFileFor, toRunningBrowser } from '../dist/proxies.js';
import { saveRobot } from '../dist/robots.js';
import { activeConnection, settingsFileFor } from '../dist/settings.js';

const args = process.argv.slice(2);
const proxyIndex = args.indexOf('--proxy');
const proxyId = proxyIndex >= 0 ? args[proxyIndex + 1] : undefined;
// A missing --proxy is index -1, and -1 + 1 is 0 — which would quietly eat the first argument.
const rest = proxyIndex >= 0 ? args.filter((_, index) => index !== proxyIndex && index !== proxyIndex + 1) : args;
const [userId, url, name, want] = rest;

if (!userId || !url || !name) {
  console.error('usage: build-into.mjs <userId> <url> <name> "<what is wanted>" [--proxy <proxyId>]');
  process.exit(2);
}

const connection = await activeConnection(settingsFileFor(userId));
if (!connection) {
  console.error(`account ${userId} has no model connection — add one in the web view first`);
  process.exit(2);
}

const proxy = proxyId ? await findProxy(proxiesFileFor(userId), proxyId) : undefined;
if (proxyId && !proxy) {
  console.error(`account ${userId} has no proxy ${proxyId}`);
  process.exit(2);
}

const rules = await (async () => {
  try {
    const files = (await readdir('rules')).filter((file) => file.endsWith('.json'));
    return await Promise.all(files.map(async (file) => JSON.parse(await readFile(join('rules', file), 'utf8'))));
  } catch {
    return [];
  }
})();

const profiles = process.env.RATATOSK_PROFILES ?? 'profiles';
const session = await openBrowser({
  profileDir: join(profiles, proxy ? `${userId}--${proxy.id}` : userId),
  ...(proxy ? { proxy: await toRunningBrowser(proxy) } : {}),
});

console.log(`building ${name} with ${connection.model}${proxy ? ` through ${proxy.label}` : ''}`);

try {
  const result = await buildWithModel(session.page, {
    url,
    name,
    want: want ?? 'the list on this page: title, link, location and pay if shown',
    rules,
    apiKey: connection.key,
    model: connection.model,
    baseUrl: connection.baseUrl,
  });

  for (const step of result.steps.slice(-4)) console.log(`  ${step.tool.padEnd(15)} ${String(step.result).slice(0, 110)}`);

  if (result.scenario && result.verdict?.good) {
    const scenario = proxy ? { ...result.scenario, proxy: proxy.id } : result.scenario;
    const path = await saveRobot(scenario, join('robots', 'u', userId));
    console.log(`saved ${path}`);
  } else {
    console.log(`not saved: ${result.verdict?.reasons?.join('; ') ?? 'the bar was not cleared'}`);
    process.exitCode = 1;
  }
} finally {
  await session.close().catch(() => undefined);
}
