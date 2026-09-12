/**
 * What the source has now, as opposed to what a run brought back.
 *
 * These are two different questions and the difference is easy to miss until it breaks something. A
 * run is an event: it happened at a time, it returned rows, and the history of runs is a journal. A
 * source is a state: three thousand things are listed on it this minute, and tomorrow some of them
 * will not be.
 *
 * A scraper that remembers hands over only what is new, which is exactly right for delivery and
 * exactly wrong as a picture of the source — the journal then holds increments, and anyone wanting
 * the whole of it has to add up runs that are still kept. That sum is wrong the moment the oldest run
 * ages out, and its wrongness is silent: a source of thirty thousand quietly reads as a source of
 * fifteen, and whatever cleans up after it deletes the rest.
 *
 * So a scraper may keep a catalogue as well: every row it SAW on the last pass, not every row it
 * handed on. From that, two things fall out for free and exactly — what the source holds, and what it
 * has stopped holding.
 *
 * Off unless a scraper asks for it, because it only means something where rows have a stable identity:
 * a source whose rows are identified by a fingerprint of their own text cannot be catalogued, and
 * pretending otherwise would fill a table with rows that are new every time they are read.
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { db, usingDatabase } from './db.js';

export type Row = Record<string, string | null>;

export interface Listed {
  id: string;
  row: Row;
  firstSeen: string;
  lastSeen: string;
}

export function catalogueFileFor(userId: string, scraper: string): string {
  return join(process.env['RATATOSK_CATALOGUE'] ?? 'catalogue', safe(userId), `${safe(scraper)}.json`);
}

/**
 * Write down everything this pass saw.
 *
 * `at` is the pass, and it is what makes "gone" answerable: a row not touched by the newest pass has
 * a `lastSeen` older than it, and nothing has to be opened to discover that.
 */
export async function keepSeen(
  userId: string,
  scraper: string,
  rows: Row[],
  identity: string,
  at = new Date().toISOString(),
): Promise<number> {
  const seen = rows
    .map((row) => ({ id: row[identity], row }))
    .filter((one): one is { id: string; row: Row } => Boolean(one.id));
  if (seen.length === 0) return 0;

  if (usingDatabase()) {
    const pool = await db();
    // One statement for the whole pass: thirty thousand round trips is a minute of nothing happening.
    await pool.query(
      `INSERT INTO catalogue (user_id, scraper, id, row, first_seen, last_seen)
       SELECT $1, $2, one->>'id', (one->'row')::jsonb, $4::timestamptz, $4::timestamptz
       FROM jsonb_array_elements($3::jsonb) AS one
       ON CONFLICT (user_id, scraper, id) DO UPDATE
         SET row = EXCLUDED.row, last_seen = EXCLUDED.last_seen`,
      [userId, scraper, JSON.stringify(seen), at],
    );
    return seen.length;
  }

  const file = catalogueFileFor(userId, scraper);
  const had = await readCatalogue(file);
  for (const one of seen) {
    const before = had[one.id];
    had[one.id] = { id: one.id, row: one.row, firstSeen: before?.firstSeen ?? at, lastSeen: at };
  }
  await writeCatalogue(file, had);
  return seen.length;
}

/** Everything the source holds, as of the last pass that saw it. */
export async function catalogueOf(
  userId: string,
  scraper: string,
  options: { limit?: number; after?: string } = {},
): Promise<Listed[]> {
  const limit = Math.min(options.limit ?? 1000, 5000);

  if (usingDatabase()) {
    const pool = await db();
    const { rows } = await pool.query<{ id: string; row: Row; first_seen: Date; last_seen: Date }>(
      `SELECT id, row, first_seen, last_seen FROM catalogue
       WHERE user_id = $1 AND scraper = $2 AND ($3::text IS NULL OR id > $3)
       ORDER BY id LIMIT $4`,
      [userId, scraper, options.after ?? null, limit],
    );
    return rows.map((one) => ({
      id: one.id,
      row: one.row,
      firstSeen: one.first_seen.toISOString(),
      lastSeen: one.last_seen.toISOString(),
    }));
  }

  const had = Object.values(await readCatalogue(catalogueFileFor(userId, scraper)));
  return had
    .filter((one) => !options.after || one.id > options.after)
    .sort((one, other) => one.id.localeCompare(other.id))
    .slice(0, limit);
}

/** What the source has stopped holding: listed once, and not seen since the given moment. */
export async function goneFrom(userId: string, scraper: string, since: string): Promise<Listed[]> {
  if (usingDatabase()) {
    const pool = await db();
    const { rows } = await pool.query<{ id: string; row: Row; first_seen: Date; last_seen: Date }>(
      `SELECT id, row, first_seen, last_seen FROM catalogue
       WHERE user_id = $1 AND scraper = $2 AND last_seen < $3::timestamptz ORDER BY last_seen`,
      [userId, scraper, since],
    );
    return rows.map((one) => ({
      id: one.id,
      row: one.row,
      firstSeen: one.first_seen.toISOString(),
      lastSeen: one.last_seen.toISOString(),
    }));
  }

  const had = Object.values(await readCatalogue(catalogueFileFor(userId, scraper)));
  return had.filter((one) => one.lastSeen < since).sort((one, other) => one.lastSeen.localeCompare(other.lastSeen));
}

/** When a scraper goes, so does what it had listed. */
export async function forgetCatalogue(userId: string, scraper: string): Promise<void> {
  if (usingDatabase()) {
    const pool = await db();
    await pool.query('DELETE FROM catalogue WHERE user_id = $1 AND scraper = $2', [userId, scraper]);
    return;
  }
  await writeCatalogue(catalogueFileFor(userId, scraper), {});
}

/** A rename takes the catalogue with it, like everything else a name is the key to. */
export async function moveCatalogue(userId: string, from: string, to: string): Promise<void> {
  if (usingDatabase()) {
    const pool = await db();
    await pool.query('UPDATE catalogue SET scraper = $3 WHERE user_id = $1 AND scraper = $2', [userId, from, to]);
    return;
  }
  await rename(catalogueFileFor(userId, from), catalogueFileFor(userId, to)).catch(() => undefined);
}

async function readCatalogue(file: string): Promise<Record<string, Listed>> {
  try {
    return JSON.parse(await readFile(file, 'utf8')) as Record<string, Listed>;
  } catch {
    return {};
  }
}

async function writeCatalogue(file: string, had: Record<string, Listed>): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  const temporary = `${file}.writing`;
  await writeFile(temporary, `${JSON.stringify(had)}\n`, 'utf8');
  await rename(temporary, file);
}

function safe(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, '-');
}
