/**
 * Bring a board's photographs here, instead of pointing at theirs.
 *
 * Linking straight at their CDN looks free and is not: at real traffic it is thousands of requests a
 * day from one address at a service that has every reason to stop serving it. So the files come here
 * once, and the site serves its own.
 *
 * Three things this has to survive, because a job of this size never finishes in one go:
 *
 * - **Being run again.** Anything already on disk is skipped without a request, so a second run over
 *   thirty thousand listings costs a directory listing rather than thirty gigabytes.
 * - **Being killed.** Every file is written beside its name and renamed into place, so a half-file
 *   never exists — a truncated JPEG that looks downloaded is worse than a missing one.
 * - **The board moving on.** A listing taken down has its pictures deleted, or a disk fills with
 *   flats nobody can rent any more.
 *
 * Usage: RATATOSK_KEY=… node scripts/fetch-images.mjs <scraper> [--set webp|medium|full]
 *                                                     [--dir PATH] [--parallel N] [--base URL]
 */
import { mkdir, rename, rm, readdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const [scraper] = process.argv.slice(2);
const which = argOf('--set') ?? 'webp';
const root = argOf('--dir') ?? 'images';
const parallel = Number(argOf('--parallel') ?? 24);
const base = argOf('--base') ?? 'http://127.0.0.1:5544';
const key = process.env.RATATOSK_KEY;

if (!scraper || !key) {
  console.error('usage: RATATOSK_KEY=… node scripts/fetch-images.mjs <scraper> [--set webp|medium|full]');
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

/** The column each set of links lives in, as the scraper named them. */
const COLUMN = { webp: 'img_webp', medium: 'img_medium', full: 'img_full' };
const column = COLUMN[which];
if (!column) {
  console.error(`--set must be one of ${Object.keys(COLUMN).join(', ')}`);
  process.exit(2);
}

/** A column holds either one address or a list of them, written as JSON by the feed reader. */
function addressesIn(value) {
  if (!value) return [];
  if (!value.startsWith('[')) return [value];
  try {
    const list = JSON.parse(value);
    return Array.isArray(list) ? list.filter((one) => typeof one === 'string') : [];
  } catch {
    return [];
  }
}

const kept = (await ask('/api/results', { name: scraper })).kept;
if (kept.length === 0) {
  console.error(`${scraper} has kept no runs — run it first`);
  process.exit(1);
}

// Every kept run: a scraper that remembers hands over only what is new each time, so the board itself
// is spread across all of them.
const wanted = new Map();
for (const run of kept) {
  for (const row of (await ask('/api/results/get', { name: scraper, at: run.at })).rows) {
    if (row.id) wanted.set(row.id, addressesIn(row[column]));
  }
}
console.log(`${scraper}: ${wanted.size} listings, set "${which}"`);

const work = [];
for (const [id, addresses] of wanted) {
  addresses.forEach((address, index) => work.push({ id, address, index }));
}

const tally = { had: 0, got: 0, failed: 0, bytes: 0 };
let cursor = 0;

async function worker() {
  while (cursor < work.length) {
    const one = work[cursor++];
    const ending = (one.address.split('?')[0].match(/\.(webp|jpe?g|png)$/i) ?? ['.jpg'])[0];
    const into = join(root, one.id);
    const file = join(into, `${one.index}${ending}`);

    try {
      const already = await stat(file).catch(() => undefined);
      if (already && already.size > 0) {
        tally.had++;
        continue;
      }
      const answer = await fetch(one.address);
      if (!answer.ok) throw new Error(String(answer.status));
      const bytes = Buffer.from(await answer.arrayBuffer());

      await mkdir(into, { recursive: true });
      // Beside, then into place: a run that dies mid-write leaves no half-picture behind.
      const beside = `${file}.writing`;
      await writeFile(beside, bytes);
      await rename(beside, file);

      tally.got++;
      tally.bytes += bytes.length;
    } catch {
      tally.failed++;
    }

    const done = tally.had + tally.got + tally.failed;
    if (done % 500 === 0) {
      console.log(`${done}/${work.length}  new ${tally.got}  had ${tally.had}  failed ${tally.failed}` +
        `  ·  ${(tally.bytes / 1e6).toFixed(0)} MB fetched`);
    }
  }
}

await Promise.all(Array.from({ length: parallel }, worker));
console.log(`\nfetched ${tally.got}, already had ${tally.had}, failed ${tally.failed}, ${(tally.bytes / 1e6).toFixed(0)} MB`);

// What the board no longer shows, this disk no longer keeps.
const gone = (await ask('/api/vanished', { name: scraper }).catch(() => ({ ids: [] }))).ids ?? [];
let swept = 0;
for (const one of gone) {
  const there = join(root, one.id);
  if (await stat(there).catch(() => undefined)) {
    await rm(there, { recursive: true, force: true });
    swept++;
  }
}

// …and anything on disk the board has simply stopped listing, which the memory may not have met.
const onDisk = await readdir(root).catch(() => []);
for (const id of onDisk) {
  if (wanted.has(id) || gone.some((one) => one.id === id)) continue;
  await rm(join(root, id), { recursive: true, force: true });
  swept++;
}
console.log(`swept ${swept} listings that are no longer up`);
