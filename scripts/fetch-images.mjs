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
 *                                                     [--column NAME] [--dir PATH]
 *                                                     [--parallel N] [--base URL]
 */
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { phash } from '../dist/phash.js';

const [scraper] = process.argv.slice(2);
const which = argOf('--set') ?? 'webp';
// One tree per board. They share nothing: a sweep that runs for one board must never be able to see,
// let alone delete, another board's pictures — which it did, twice, before this line existed.
const root = join(argOf('--dir') ?? 'images', scraper);
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

/**
 * The column the links live in. The three sets are what a feed of that shape calls them; every other
 * board names its gallery something of its own, and `--column` says which one without this script
 * having to know about each board.
 */
const COLUMN = { webp: 'img_webp', medium: 'img_medium', full: 'img_full' };
const column = argOf('--column') ?? COLUMN[which];
if (!column) {
  console.error(`--set must be one of ${Object.keys(COLUMN).join(', ')}, or name the column with --column`);
  process.exit(2);
}

/**
 * A column holds one address, a JSON list of them, or several written one per line — which is what a
 * page walk produces when a field is asked for every match rather than the first.
 */
function addressesIn(value) {
  if (!value) return [];
  if (value.startsWith('[')) {
    try {
      const list = JSON.parse(value);
      return Array.isArray(list) ? list.filter((one) => typeof one === 'string') : [];
    } catch {
      return [];
    }
  }
  return value
    .split('\n')
    .map((one) => one.trim())
    .filter((one) => /^https?:\/\//.test(one));
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

// A listing at a time, not a file at a time: its fingerprints are written once, beside its pictures,
// and a listing already complete is skipped without touching the network or the decoder.
const work = [...wanted.entries()];
const tally = { had: 0, got: 0, failed: 0, bytes: 0, listings: 0 };
let cursor = 0;

async function worker() {
  while (cursor < work.length) {
    const [id, addresses] = work[cursor++];
    const into = join(root, id);
    const noteFile = join(into, 'photos.json');

    const note = await readFile(noteFile, 'utf8').then(JSON.parse).catch(() => undefined);
    if (note && note.files?.length === addresses.length) {
      tally.had += addresses.length;
      tally.listings++;
      continue;
    }

    const files = [];
    const hashes = [];
    for (const [index, address] of addresses.entries()) {
      const ending = (address.split('?')[0].match(/\.(webp|jpe?g|png)$/i) ?? ['.jpg'])[0];
      const file = join(into, `${index}${ending}`);

      try {
        let bytes;
        const already = await stat(file).catch(() => undefined);
        if (already && already.size > 0) {
          bytes = await readFile(file);
          tally.had++;
        } else {
          const answer = await fetch(address);
          if (!answer.ok) throw new Error(String(answer.status));
          bytes = Buffer.from(await answer.arrayBuffer());

          await mkdir(into, { recursive: true });
          // Beside, then into place: a run that dies mid-write leaves no half-picture behind.
          const beside = `${file}.writing`;
          await writeFile(beside, bytes);
          await rename(beside, file);

          tally.got++;
          tally.bytes += bytes.length;
        }

        files.push(`${index}${ending}`);
        // The fingerprint is taken here because the bytes are here. Asking for them again later, only
        // to hash them, is the whole download done twice.
        const fingerprint = await phash(bytes);
        if (fingerprint) hashes.push(fingerprint);
      } catch {
        tally.failed++;
      }
    }

    if (files.length) {
      await writeFile(noteFile, `${JSON.stringify({ files, phash: hashes })}\n`, 'utf8');
    }
    tally.listings++;

    if (tally.listings % 500 === 0) {
      console.log(`${tally.listings}/${work.length} listings  new ${tally.got}  had ${tally.had}` +
        `  failed ${tally.failed}  ·  ${(tally.bytes / 1e6).toFixed(0)} MB`);
    }
  }
}

await Promise.all(Array.from({ length: parallel }, worker));
console.log(`\nfetched ${tally.got}, already had ${tally.had}, failed ${tally.failed}, ${(tally.bytes / 1e6).toFixed(0)} MB`);

/**
 * What the board no longer shows, this disk no longer keeps.
 *
 * The board as it answered a minute ago outranks anything remembered about it: a listing we have just
 * been handed is not gone, whatever a memory or a boundary says. Getting that the wrong way round once
 * cost five thousand directories of pictures, all of them live.
 */
let swept = 0;
const onDisk = await readdir(root).catch(() => []);
for (const id of onDisk) {
  if (wanted.has(id)) continue;
  await rm(join(root, id), { recursive: true, force: true });
  swept++;
}
console.log(`swept ${swept} listings that are no longer up`);
