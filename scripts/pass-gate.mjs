/**
 * Pass a gate on your own machine, and let the robot walk through the open door.
 *
 * Some sites put a door in front of the list that is meant for a person — a check that asks whether
 * you are one, a login, an age gate. Watching a screen on a server through a wire is a miserable way
 * to answer that, so this does it the other way round: the browser opens here, on your machine, at
 * the speed of your machine, and what the site hands you afterwards is carried to the profile the
 * robot uses.
 *
 *   node scripts/pass-gate.mjs --server https://ratatosk.example --url https://site/list [--proxy <id>] [--match-agent]
 *
 * The proxy matters more than it looks. These gates tie what they give you to the address you came
 * from, so the browser here goes out through the same proxy the robot does — otherwise the cookie is
 * worth nothing by the time it arrives.
 */
import { createInterface } from 'node:readline/promises';
import { chromium } from 'patchright';
import { startBridge } from '../dist/socks-bridge.js';

const args = process.argv.slice(2);
const take = (name) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : undefined;
};

const server = (take('server') ?? process.env.RATATOSK_SERVER ?? '').replace(/\/+$/, '');
const url = take('url');
const proxyId = take('proxy');

if (!server || !url) {
  console.error('usage: pass-gate.mjs --server <https://…> --url <https://…> [--proxy <id>]');
  process.exit(2);
}

const ask = createInterface({ input: process.stdin, output: process.stdout });

const email = process.env.RATATOSK_EMAIL ?? (await ask.question('email: '));
const password = process.env.RATATOSK_PASSWORD ?? (await ask.question('password: '));

const call = async (path, body, token) => {
  const response = await fetch(`${server}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body ?? {}),
  });
  const answer = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(answer.error ?? `${path} answered ${response.status}`);
  return answer;
};

const { token } = await call('/api/auth/login', { email, password });
const session = await call('/api/browser/session', { proxy: proxyId }, token);

// The same way out as the robot, password and all — Chromium refuses a SOCKS5 proxy that has one, so
// the same bridge the server uses runs here for as long as this browser is open.
let proxy;
let bridge;
if (session.proxyUrl) {
  const parsed = new URL(session.proxyUrl);
  if (parsed.protocol === 'socks5:' && parsed.username) {
    bridge = await startBridge({
      host: parsed.hostname,
      port: Number(parsed.port),
      username: decodeURIComponent(parsed.username),
      password: decodeURIComponent(parsed.password),
    });
    proxy = { server: bridge.url };
  } else {
    proxy = {
      server: `${parsed.protocol}//${parsed.host}`,
      ...(parsed.username ? { username: decodeURIComponent(parsed.username) } : {}),
      ...(parsed.password ? { password: decodeURIComponent(parsed.password) } : {}),
    };
  }
  console.log(`going out through ${parsed.protocol}//${parsed.host}${bridge ? ' (bridged)' : ''}`);
}

// Your machine and the server are not the same kind of computer, and a browser says so out loud. A
// gate that ties its answer to that will not accept the session afterwards, so --match-agent lets this
// browser introduce itself the way the robot's does. It changes nothing about who passes the gate.
const matchAgent = args.includes('--match-agent');

const context = await chromium.launchPersistentContext('', {
  headless: false,
  viewport: null,
  ...(matchAgent && session.userAgent ? { userAgent: session.userAgent } : {}),
  ...(proxy ? { proxy } : {}),
});

const page = context.pages()[0] ?? (await context.newPage());
await page.goto(url).catch(() => undefined);

const here = await page.evaluate(() => navigator.userAgent);
if (session.userAgent && session.userAgent !== here) {
  console.log('\nnote: this browser and the robot\'s do not call themselves the same thing —');
  console.log(`  here:  ${here}`);
  console.log(`  robot: ${session.userAgent}`);
  console.log('  a gate that checks this will not accept the session — run again with --match-agent.');
}

console.log('\nThe browser is yours. Do what the site asks, then come back here.');
await ask.question('press Enter once you are through: ');

const cookies = await context.cookies();
const host = new URL(url).hostname.replace(/^www\./, '');
const relevant = cookies.filter((cookie) => cookie.domain.replace(/^\./, '').endsWith(host));

if (relevant.length === 0) {
  console.log(`nothing was left for ${host} — the gate may not be passed yet`);
} else {
  const taken = await call('/api/browser/cookies', { proxy: proxyId, cookies: relevant }, token);
  console.log(`carried ${taken.taken} cookies for ${taken.hosts.join(', ')} into ${taken.into}`);
  if (taken.note) console.log(`  ${taken.note}`);
}

await context.close();
await bridge?.close();
ask.close();
process.exit(0);
