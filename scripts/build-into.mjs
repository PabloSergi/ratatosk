/**
 * Build a robot into an account, from the command line.
 *
 * The web view builds with the account's own connection and the account's own proxy; this is the same
 * thing without the browser in front of it — the maintenance path, for filling an account with robots
 * for sources it already had, or retrying the ones that did not come out the first time.
 *
 *   node scripts/build-into.mjs <userId> <url> <name> "<what is wanted>" [--proxy <id>] [--model <model>]
 *
 * Nothing is passed in by hand: the key, the model and the proxy are the ones that account chose.
 */
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { buildWithModel } from '../dist/agent.js';
import { openBrowser } from '../dist/drivers/patchright.js';
import { findProxy, proxiesFileFor, toRunningBrowser } from '../dist/proxies.js';
import { saveRobot } from '../dist/robots.js';
import { park, waitingFileFor } from '../dist/waiting.js';
import { activeConnection, settingsFileFor } from '../dist/settings.js';

const args = process.argv.slice(2);
const proxyIndex = args.indexOf('--proxy');
const proxyId = proxyIndex >= 0 ? args[proxyIndex + 1] : undefined;
// The account's own model builds by default. A cheap one is the right choice for most lists and the
// wrong one for an awkward page, and switching the account's setting to rebuild one scraper is a
// heavier act than saying so here.
const modelIndex = args.indexOf('--model');
const model = modelIndex >= 0 ? args[modelIndex + 1] : undefined;
// A missing --proxy is index -1, and -1 + 1 is 0 — which would quietly eat the first argument.
const flagged = new Set([proxyIndex, proxyIndex + 1, modelIndex, modelIndex + 1].filter((index) => index >= 1));
const rest = args.filter((_, index) => !flagged.has(index));
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

console.log(`building ${name} with ${model ?? connection.model}${proxy ? ` through ${proxy.label}` : ''}`);

try {
  const result = await buildWithModel(session.page, {
    url,
    name,
    want: want ?? 'the list on this page: title, link, location and pay if shown',
    rules,
    apiKey: connection.key,
    model: model ?? connection.model,
    baseUrl: connection.baseUrl,
  });

  for (const step of result.steps.slice(-4)) console.log(`  ${step.tool.padEnd(15)} ${String(step.result).slice(0, 110)}`);

  if (result.scenario && result.verdict?.good) {
    const scenario = proxy ? { ...result.scenario, proxy: proxy.id } : result.scenario;
    const path = await saveRobot(scenario, join('robots', 'u', userId));
    console.log(`saved ${path}`);
  } else {
    // The verdict calls them complaints. Asking it for `reasons` printed the fallback every time,
    // which turned every refusal into the same four words and hid the one thing worth reading.
    console.log(`not saved: ${result.verdict?.complaints?.join('; ') ?? 'the bar was not cleared'}`);
    if (result.verdict?.coverage) console.log(`  coverage: ${JSON.stringify(result.verdict.coverage)}`);

    /**
     * A door is not a failure. The site is readable and the robot is buildable; what is missing is a
     * person passing the check once, in the profile the scraper will use. Written down where the
     * interface can show it — otherwise the source is lost in the output of whoever ran this.
     */
    const door = result.steps.find((step) => /CHALLENGE PAGE|anti-bot/i.test(String(step.result)));
    if (door) {
      await park(waitingFileFor(userId), {
        name,
        url,
        why: String(door.result).split('—').slice(-1)[0]?.trim().slice(0, 140) || 'a door meant for a person',
        ...(want ? { want } : {}),
        ...(proxy ? { proxy: proxy.id } : {}),
      });
      console.log(`parked: ${name} is waiting for a person to pass the check`);
    }
    process.exitCode = 1;
  }
} finally {
  await session.close().catch(() => undefined);
}
