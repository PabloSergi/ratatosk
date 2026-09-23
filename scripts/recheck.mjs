/**
 * Asking a source whether what it once held is still there.
 *
 * A pass over a list answers "here is what is on it now", and where the pass covers the whole list
 * that is also the answer to "what has gone": whatever it did not meet. On a feed the pass covers the
 * first few hundred of thousands, so the same subtraction describes our patience and not the source —
 * measured on a live catalogue, of the postings unseen for three days every one checked was still up,
 * and reporting them gone would have buried the catalogue in a day.
 *
 * So each row is asked about directly, in the scraper's own browser, and the ones that answer have
 * their sighting refreshed. After a full revision the catalogue's own boundary is honest again: what
 * this did not confirm is what is actually gone.
 *
 * Usage: node scripts/recheck.mjs <scraper> [--user ID] [--batch N] [--only N]
 */
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

import { revise } from '../dist/alive.js';
import { catalogueOf, touchSeen } from '../dist/catalogue.js';
import { openBrowser } from '../dist/drivers/patchright.js';
import { loadRobot } from '../dist/robots.js';
import { findProxy, proxiesFileFor, toRunningBrowser } from '../dist/proxies.js';

const [scraper] = process.argv.slice(2).filter((one) => !one.startsWith('--'));
const batch = Number(argOf('--batch') ?? 500);
const only = Number(argOf('--only') ?? 0);

if (!scraper) {
  console.error('usage: node scripts/recheck.mjs <scraper> [--user ID] [--batch N] [--only N]');
  process.exit(2);
}

function argOf(flag) {
  const at = process.argv.indexOf(flag);
  return at > 0 ? process.argv[at + 1] : undefined;
}

/** One account on most installations; naming it is for the ones with more. */
async function whoseIsIt() {
  const named = argOf('--user');
  if (named) return named;
  const root = join(process.env.RATATOSK_ROBOTS ?? 'robots', 'u');
  const accounts = await readdir(root).catch(() => []);
  if (accounts.length === 1) return accounts[0];
  console.error(`say whose scraper it is with --user (${accounts.length} accounts here)`);
  process.exit(2);
}

const userId = await whoseIsIt();
const robot = await loadRobot(scraper, join(process.env.RATATOSK_ROBOTS ?? 'robots', 'u', userId));
const rule = robot.alive;
const identity = robot.catalogue;

if (!rule || !identity) {
  console.error(`${scraper} says nothing about how to ask whether a row is still there — see "alive" in docs/scenario.md`);
  process.exit(2);
}

const proxy = robot.proxy ? await findProxy(proxiesFileFor(userId), robot.proxy) : undefined;
const session = await openBrowser({
  profileDir: join(process.env.RATATOSK_PROFILES ?? 'profiles', robot.proxy ? `${userId}--${robot.proxy}` : userId),
  ...(proxy ? { proxy: await toRunningBrowser(proxy), proxyUrl: proxy.url } : {}),
});

const began = Date.now();
const tally = { asked: 0, alive: 0, gone: [], unclear: 0 };

try {
  // A page of the same site, because that is what carries the session. Asked from anywhere else every
  // answer comes back as "sign in", which reads as "gone" for the whole catalogue at once.
  await session.page.goto(new URL(rule.url.replace('{id}', '1')).origin);
  await session.page.waitMs(4000);

  let after;
  while (true) {
    const page = await catalogueOf(userId, scraper, { limit: batch, ...(after ? { after } : {}) });
    if (page.length === 0) break;
    after = page.at(-1).id;

    const revision = await revise(session.page, rule, page.map((one) => one.id));
    await touchSeen(userId, scraper, revision.alive);

    tally.asked += page.length;
    tally.alive += revision.alive.length;
    tally.gone.push(...revision.gone);
    tally.unclear += revision.unclear.length;
    console.log(
      `${scraper}: asked ${tally.asked}, still there ${tally.alive}, gone ${tally.gone.length}, no answer ${tally.unclear}`,
    );

    if (only && tally.asked >= only) break;
  }
} finally {
  await session.close();
}

console.log(
  `${scraper}: ${tally.alive} still there, ${tally.gone.length} gone, ${tally.unclear} without an answer, ` +
    `in ${Math.round((Date.now() - began) / 1000)}s`,
);
if (tally.gone.length) console.log(`gone: ${tally.gone.slice(0, 20).join(' ')}${tally.gone.length > 20 ? ' …' : ''}`);
process.exit(0);
