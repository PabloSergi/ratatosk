/**
 * What changed on a board since the last look.
 *
 * A board shows one thing: what is up right now. It cannot tell you that this flat has been up for six
 * weeks, or that its rent dropped twice — nobody keeps that, including the board. So it is kept here,
 * from the first run, whether or not anyone is reading it yet: a history that was not written down at
 * the time cannot be reconstructed afterwards at any price.
 *
 * Only `{id: price}` is carried between runs, not the listings themselves. Thirty thousand of those is
 * a few hundred kilobytes against sixty megabytes, and it is all a difference needs.
 *
 * Usage: RATATOSK_KEY=… node scripts/price-log.mjs <scraper> [--dir PATH] [--base URL]
 */
import { mkdir, readFile, rename, writeFile, appendFile } from 'node:fs/promises';
import { join } from 'node:path';

const [scraper] = process.argv.slice(2);
const root = argOf('--dir') ?? 'changes';
const base = argOf('--base') ?? 'http://127.0.0.1:5544';
const key = process.env.RATATOSK_KEY;

if (!scraper || !key) {
  console.error('usage: RATATOSK_KEY=… node scripts/price-log.mjs <scraper> [--dir PATH]');
  process.exit(2);
}

function argOf(flag) {
  const at = process.argv.indexOf(flag);
  return at === -1 ? undefined : process.argv[at + 1];
}

async function ask(path, body) {
  const answer = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!answer.ok) throw new Error(`${path} answered ${answer.status}`);
  return answer.json();
}

const kept = (await ask('/api/results', { name: scraper })).kept;
if (kept.length === 0) {
  console.error(`${scraper} has kept no runs — run it first`);
  process.exit(1);
}

const now = new Map();
for (const run of kept) {
  for (const row of (await ask('/api/results/get', { name: scraper, at: run.at })).rows) {
    if (row.id) now.set(row.id, Number(row.price ?? 0));
  }
}

const snapshotFile = join(root, `${scraper}.json`);
const logFile = join(root, `${scraper}.jsonl`);
await mkdir(root, { recursive: true });

let before = {};
try {
  before = JSON.parse(await readFile(snapshotFile, 'utf8'));
} catch {
  // No snapshot is the first run: everything is new, and saying so thirty thousand times helps nobody.
}
const first = Object.keys(before).length === 0;

const at = new Date().toISOString();
const events = [];
for (const [id, price] of now) {
  const had = before[id];
  if (had === undefined) {
    if (!first) events.push({ t: at, e: 'new', id: Number(id), price, kind: scraper });
  } else if (had !== price) {
    events.push({ t: at, e: 'price', id: Number(id), from: had, price });
  }
}
for (const [id, price] of Object.entries(before)) {
  if (!now.has(id)) events.push({ t: at, e: 'gone', id: Number(id), price });
}

if (events.length) {
  await appendFile(logFile, `${events.map((one) => JSON.stringify(one)).join('\n')}\n`, 'utf8');
}

// Beside, then into place: a snapshot half-written is a difference that never recovers.
const beside = `${snapshotFile}.writing`;
await writeFile(beside, JSON.stringify(Object.fromEntries(now)), 'utf8');
await rename(beside, snapshotFile);

const count = (kind) => events.filter((one) => one.e === kind).length;
console.log(
  first
    ? `${scraper}: first look, ${now.size} listings remembered`
    : `${scraper}: ${now.size} up · new ${count('new')} · price ${count('price')} · gone ${count('gone')}`,
);
