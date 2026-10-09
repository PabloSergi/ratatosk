import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { db, usingDatabase } from './db.js';

/**
 * What a group of scrapers has already passed on, shared between them.
 *
 * A scraper's memory is its own, and that is right nearly everywhere: two job boards that both carry
 * the same advert are two sightings of it, and whoever reads them wants to know it is on both. It
 * stops being right when several scrapers are deliberately pointed at ONE pool of postings from
 * different angles — a subreddit read directly, and the same subreddit caught again by a search
 * across all of Reddit. There the same post is not two sightings; it is one post arriving twice,
 * and handing it over twice is a duplicate in whatever reads us.
 *
 * So a scraper may name a group it hands over WITH. The first of them to meet a posting passes it on;
 * the rest see that it is spoken for and stay quiet. Each keeps its own memory as well — this is a
 * second gate, not a replacement: "have I seen this" and "has anybody handed this on" are different
 * questions, and a scraper still has to answer the first one about itself.
 *
 * Claiming is a single statement, not read-then-write. Several runs are in flight at once, and the
 * two-step version loses rows exactly when the group is doing its job: both runs read "nobody has
 * it", both hand it over.
 */
export interface Claim {
  userId: string;
  group: string;
  keys: string[];
}

export function togetherFileFor(userId: string, group: string): string {
  return join('memory', userId, `_together-${group.replace(/[^a-zA-Z0-9._-]/g, '-')}.json`);
}

/** The keys this caller may hand over: the ones nobody in the group had claimed. */
export async function claim({ userId, group, keys }: Claim): Promise<Set<string>> {
  if (keys.length === 0) return new Set();

  if (usingDatabase()) {
    const pool = await db();
    const { rows } = await pool.query<{ key: string }>(
      `INSERT INTO handed (user_id, grp, key, at)
       SELECT $1, $2, k, now() FROM unnest($3::text[]) AS k
       ON CONFLICT (user_id, grp, key) DO NOTHING
       RETURNING key`,
      [userId, group, keys],
    );
    return new Set(rows.map((one) => one.key));
  }

  // The laptop and the tests: one process, so read-then-write is honest here and nowhere else.
  const file = togetherFileFor(userId, group);
  let held: Record<string, string> = {};
  try {
    held = JSON.parse(await readFile(file, 'utf8')) as Record<string, string>;
  } catch {
    held = {};
  }
  const mine = new Set(keys.filter((key) => !(key in held)));
  if (mine.size === 0) return mine;
  const now = new Date().toISOString();
  for (const key of mine) held[key] = now;
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(held, null, 2)}\n`, 'utf8');
  return mine;
}

/** Let a group forget, so a scraper rebuilt from scratch can hand its postings over again. */
export async function forgetTogether(userId: string, group: string): Promise<void> {
  if (usingDatabase()) {
    const pool = await db();
    await pool.query('DELETE FROM handed WHERE user_id = $1 AND grp = $2', [userId, group]);
    return;
  }
  await writeFile(togetherFileFor(userId, group), '{}\n', 'utf8').catch(() => undefined);
}
