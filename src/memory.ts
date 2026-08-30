import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

/**
 * What a robot has already seen.
 *
 * The same posting is written once and then reposted for weeks: a bot pushes it every ten minutes, a
 * job board keeps it at the top of page one, a channel bumps it every night. A robot without a memory
 * returns it every single time, and by the end of a week the table is a thousand copies of the same
 * eleven vacancies with nothing to tell them apart.
 *
 * So a robot may remember. Each row gets an identity — its link, or a fingerprint of its text when
 * there is no link — and a row already known is not returned again: its last-seen time is moved
 * forward and how many times it has appeared goes up. What comes back from a run is what is new,
 * which is what anybody downstream actually wanted.
 *
 * The memory is a file per robot, and it forgets: a key nobody has seen for a long time is dropped,
 * because a posting that vanished for two months and came back is news again.
 */
export interface Remember {
  /** Which column identifies a row. Absent means "fingerprint the whole of it". */
  by?: string;
  /** How long a key is kept after it was last seen, in days. */
  days?: number;
  /**
   * What a run returns. "new" is the point of remembering at all; "all" keeps every row and only
   * counts the repeats, for somebody who wants the whole picture every time.
   */
  mode?: 'new' | 'all';
}

export interface Seen {
  firstSeen: string;
  lastSeen: string;
  times: number;
}

export type Row = Record<string, string | null>;

const DEFAULT_DAYS = 30;

/**
 * How much of a message its identity is taken from. Long enough that two different postings rarely
 * share it, short enough that a bump appended to the end changes nothing.
 */
const HEAD = Number(process.env['RATATOSK_IDENTITY_HEAD'] ?? 200);

export function memoryFileFor(userId: string, robot: string): string {
  const safe = robot.replace(/[^a-z0-9._-]+/gi, '-').toLowerCase();
  return join(process.env['RATATOSK_MEMORY'] ?? 'memory', userId, `${safe}.json`);
}

/**
 * The identity of a row.
 *
 * A link is the honest key when there is one: the same posting keeps its address. Without one, the
 * text is fingerprinted — but normalised first, because a reposted advertisement is never quite
 * identical: emoji get swapped, spacing changes, someone appends "UP" or "актуально" to bump it.
 *
 * So the fingerprint is taken from the BEGINNING of the normalised text, not the whole of it. A bump
 * is appended, an edit is usually appended, and what somebody wrote first is what identifies their
 * posting. The cost of this is honest and worth saying: two different postings that open with the same
 * long template — the same agency's boilerplate, say — are read as one. A source like that wants an
 * explicit column as its identity instead.
 */
export function identity(row: Row, by?: string): string | undefined {
  if (by) {
    const value = row[by];
    return value ? `k:${value.trim().toLowerCase()}` : undefined;
  }

  const link = row['link'] ?? row['url'] ?? row['ссылка'];
  if (typeof link === 'string' && /^https?:\/\//.test(link)) return `k:${link.trim().toLowerCase()}`;

  const text = Object.entries(row)
    .filter(([name]) => !/date|time|seen|дата|время/i.test(name))
    .map(([, value]) => (typeof value === 'string' ? value : ''))
    .join(' ')
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();

  // A bump is a scrap on the end — "up", "ап", a repeated emoji already stripped above. One or two
  // characters trailing the text carry no meaning and must not make a repost look like news.
  const body = text.replace(/(?:\s+\S{1,2})+$/u, '').trim() || text;

  if (body.length < 12) return undefined; // too little to be an identity; treat it as always new
  return `h:${createHash('sha256').update(body.slice(0, HEAD)).digest('hex').slice(0, 24)}`;
}

export async function readMemory(file: string): Promise<Record<string, Seen>> {
  try {
    return JSON.parse(await readFile(file, 'utf8')) as Record<string, Seen>;
  } catch {
    return {};
  }
}

export async function writeMemory(file: string, memory: Record<string, Seen>): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  const temporary = `${file}.writing`;
  await writeFile(temporary, `${JSON.stringify(memory)}\n`, 'utf8');
  await rename(temporary, file);
}

export interface Sighting {
  /** Rows that were not in the memory. What a run should hand on. */
  fresh: Row[];
  /** Rows that were, with how long ago each was first met. */
  repeated: Array<{ row: Row; firstSeen: string; times: number }>;
  memory: Record<string, Seen>;
  forgotten: number;
}

/**
 * Meet a run's rows against what the robot remembers, and move the memory forward.
 *
 * Nothing here decides what a run returns — that is the caller's business, because "only what is new"
 * and "everything, with the repeats marked" are both legitimate and different jobs.
 */
export function meet(rows: Row[], memory: Record<string, Seen>, rule: Remember = {}, now = new Date()): Sighting {
  const stamp = now.toISOString();
  const fresh: Row[] = [];
  const repeated: Array<{ row: Row; firstSeen: string; times: number }> = [];
  const next: Record<string, Seen> = { ...memory };

  for (const row of rows) {
    const key = identity(row, rule.by);
    if (!key) {
      fresh.push(row); // nothing to remember it by, so it can only ever be new
      continue;
    }

    const known = next[key];
    if (known) {
      next[key] = { firstSeen: known.firstSeen, lastSeen: stamp, times: known.times + 1 };
      repeated.push({ row, firstSeen: known.firstSeen, times: known.times + 1 });
      continue;
    }

    next[key] = { firstSeen: stamp, lastSeen: stamp, times: 1 };
    fresh.push(row);
  }

  // Forgetting matters as much as remembering: a posting that disappeared for two months and came
  // back is news, and a memory that only grows eventually costs more than the scraping.
  const keepAfter = now.getTime() - (rule.days ?? DEFAULT_DAYS) * 24 * 60 * 60 * 1000;
  let forgotten = 0;
  for (const [key, seen] of Object.entries(next)) {
    if (new Date(seen.lastSeen).getTime() < keepAfter) {
      delete next[key];
      forgotten++;
    }
  }

  return { fresh, repeated, memory: next, forgotten };
}
