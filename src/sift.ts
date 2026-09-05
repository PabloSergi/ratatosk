/**
 * Telling a posting from the noise around it, and pulling fields out of free text.
 *
 * A list on a page is already structured: the site decided what a row is. A stream of messages decided
 * nothing — a channel carries job postings, chatter, memes and "up" from the same people, and a robot
 * that returns all of it returns nothing anybody can use.
 *
 * So a robot may carry a sift: which messages count, which never do, and how to read a field out of a
 * sentence. The model writes it once, by looking at real messages; the platform then measures it on
 * those same messages and keeps it only if it actually separates them. At run time it is regular
 * expressions over text — no model, no network, no per-message cost.
 */
export interface Sift {
  /**
   * The task this rule was written for, in the person's own words. Kept with the rule because a rule
   * outlives the moment it was made: rebuilding it later, or checking whether it still does what was
   * asked, needs the question as much as the answer.
   */
  want?: string;
  /** A row is kept when it matches any of these. Empty means "keep everything". */
  keep: string[];
  /** …unless it matches one of these. Checked after keep, so a drop always wins. */
  drop?: string[];
  /** Which column the patterns read. Defaults to every column joined together. */
  from?: string;
  /**
   * Fields read out of the text itself: pay, a contact, a city. The first capturing group is the
   * value, or the whole match when the pattern has no group.
   */
  fields?: Record<string, { pattern: string; from?: string }>;
  /**
   * What to do with the rows the patterns did not claim.
   *
   * Patterns are lexical: they separate "we are looking for" from "I am looking for" and nothing
   * subtler. Real tasks are not
   * always lexical, and the wording people use drifts. So the leftovers — the rows no pattern kept —
   * can be put to a model, in one batched call per run, up to a limit. The cheap rule handles the bulk;
   * the expensive judgement handles the edge, and only the edge.
   */
  judge?: { want: string; maxRows: number };
}

export type Row = Record<string, string | null>;

export interface SiftResult {
  rows: Row[];
  kept: number;
  dropped: number;
  /** Rows no pattern claimed and no pattern refused — the ones worth a second opinion. */
  unclaimed: Row[];
  /**
   * Everything this rule did not hand over, as it came in.
   *
   * Said outright rather than left to the caller to work out by subtraction: a kept row is a copy with
   * the fields read out of its text added to it, so "the ones that are not in the kept list" quietly
   * includes rows that were kept. Half of judging a rule is looking at what it threw away, and that
   * half was being done against the wrong pile.
   */
  discarded: Row[];
  /**
   * Rows a keep pattern claimed and a drop pattern then took away.
   *
   * This is where a rule loses data without anybody noticing: "send your CV to @x" is a posting, and a
   * drop written against CVs eats it. A collision is not automatically wrong — a posting really can be
   * quoted inside a CV — but a rule with many of them is refusing the very thing it was built to find.
   */
  collisions: Row[];
  /** Why each dropped row went: the first words of it, so a person can judge the rule. */
  examples: { kept: string[]; dropped: string[]; collisions: string[] };
}

export class SiftError extends Error {}

/** Compiled once per run, not once per row: a channel is thousands of messages. */
function compile(patterns: string[]): RegExp[] {
  return patterns.map((pattern) => {
    try {
      return new RegExp(pattern, 'iu');
    } catch (error) {
      throw new SiftError(`"${pattern}" is not a usable pattern: ${(error as Error).message}`);
    }
  });
}

function textOf(row: Row, from?: string): string {
  if (from) return String(row[from] ?? '');
  return Object.values(row)
    .filter((value): value is string => typeof value === 'string')
    .join('  ');
}

export function sift(rows: Row[], rule: Sift): SiftResult {
  const keep = compile(rule.keep ?? []);
  const drop = compile(rule.drop ?? []);
  const fields = Object.entries(rule.fields ?? {}).map(([name, field]) => ({
    name,
    from: field.from,
    pattern: compile([field.pattern])[0]!,
  }));

  const out: Row[] = [];
  const unclaimed: Row[] = [];
  const discarded: Row[] = [];
  const collisions: Row[] = [];
  const examples = { kept: [] as string[], dropped: [] as string[], collisions: [] as string[] };

  for (const row of rows) {
    const text = textOf(row, rule.from);
    const wanted = keep.length === 0 || keep.some((pattern) => pattern.test(text));
    const refused = drop.some((pattern) => pattern.test(text));

    if (!wanted || refused) {
      discarded.push(row);
      if (examples.dropped.length < 3) examples.dropped.push(text.replace(/\s+/g, ' ').slice(0, 90));
      // Refused outright is a decision; merely unclaimed is a question, and a question can be asked.
      if (!refused) unclaimed.push(row);
      // A collision is a keep and a drop disagreeing about one row. With no keeps at all there is
      // nothing to disagree with: "keep everything except this" is a legitimate shape of rule, and
      // counting each of its drops as a collision refuses it for doing exactly what it says.
      if (keep.length > 0 && wanted && refused) {
        collisions.push(row);
        if (examples.collisions.length < 3) examples.collisions.push(text.replace(/\s+/g, ' ').slice(0, 110));
      }
      continue;
    }

    // Only now, on a row that is staying: reading fields out of text nobody keeps is wasted work.
    const found: Row = { ...row };
    for (const field of fields) {
      const match = field.pattern.exec(textOf(row, field.from ?? rule.from));
      found[field.name] = match ? (match[1] ?? match[0]).trim() : null;
    }

    out.push(found);
    if (examples.kept.length < 3) examples.kept.push(text.replace(/\s+/g, ' ').slice(0, 90));
  }

  return { rows: out, unclaimed, discarded, collisions, kept: out.length, dropped: discarded.length, examples };
}

/**
 * Is this sift worth keeping?
 *
 * A rule that keeps everything has decided nothing, and a rule that keeps almost nothing has usually
 * matched a peculiarity of the sample rather than the thing itself. Both are worse than no rule at all,
 * because both look like a working robot.
 */
export function judgeSift(result: SiftResult, total: number): { good: boolean; note: string } {
  if (total === 0) return { good: false, note: 'there was nothing to sift' };

  const share = result.kept / total;
  if (result.kept === 0) return { good: false, note: 'it kept nothing at all — the patterns match none of these messages' };
  if (share > 0.95 && result.dropped === 0) {
    return { good: false, note: 'it kept everything, which is the same as having no rule' };
  }
  if (share < 0.02) {
    return { good: false, note: `it kept ${result.kept} of ${total} — too few to be a rule rather than a coincidence` };
  }

  // The quiet failure: a drop that eats what a keep found. A posting that says "send your CV" is still
  // a posting, and a rule losing a third of its own finds is not a rule, it is a leak.
  const claimed = result.kept + result.collisions.length;
  if (result.collisions.length > 0 && result.collisions.length / claimed > 0.25) {
    return {
      good: false,
      note:
        `the drops took away ${result.collisions.length} of the ${claimed} messages the keeps found — ` +
        `they are eating the very thing they were written to find`,
    };
  }

  const note = `keeps ${result.kept} of ${total} messages, drops ${result.dropped}`;
  return {
    good: true,
    note: result.collisions.length
      ? `${note}; ${result.collisions.length} of them matched both a keep and a drop`
      : note,
  };
}


/**
 * The second opinion, for the rows the patterns did not claim.
 *
 * One call per run, not one per row: the whole leftover batch goes in a numbered list and comes back as
 * the numbers worth keeping. Bounded, because this is the only part of a run that costs money, and a
 * channel that suddenly posts a thousand messages must not quietly spend a thousand times more.
 */
export async function judgeLeftovers(
  rows: Row[],
  want: string,
  ask: (prompt: string) => Promise<string>,
  limit: number,
): Promise<{ rows: Row[]; asked: number }> {
  const batch = rows.slice(0, Math.max(0, limit));
  if (batch.length === 0) return { rows: [], asked: 0 };

  const listed = batch
    .map((row, index) => `${index + 1}. ${textOf(row).replace(/\s+/g, ' ').slice(0, 300)}`)
    .join('\n');

  const answer = await ask(
    `Task: ${want}\n\n` +
      `Which of these messages fit the task?\n` +
      `Answer with JSON and nothing else: {"keep":[1,3]} — or {"keep":[]} if none of them do.\n\n${listed}`,
  );

  return { rows: batch.filter((_row, index) => chosen(answer, batch.length).has(index + 1)), asked: batch.length };
}

/**
 * Which numbers the answer actually chose.
 *
 * Reading every digit in the reply is how a model that explains itself gets misread: "message 1 does
 * not fit" then keeps message 1. So the JSON is read as JSON, and a bare list of numbers is accepted
 * only when the whole answer is one — anything wordier is treated as a refusal to answer in the form
 * asked for, which is safer than guessing what it meant.
 */
function chosen(answer: string, count: number): Set<number> {
  const inRange = (numbers: number[]): Set<number> =>
    new Set(numbers.filter((number) => Number.isInteger(number) && number >= 1 && number <= count));

  const start = answer.indexOf('{');
  const end = answer.lastIndexOf('}');
  if (start !== -1 && end > start) {
    try {
      const parsed = JSON.parse(answer.slice(start, end + 1)) as { keep?: unknown };
      if (Array.isArray(parsed.keep)) return inRange(parsed.keep.map(Number));
    } catch {
      // Not JSON after all; fall through to the plain-list form.
    }
  }

  const bare = answer.trim();
  if (/^none$/i.test(bare)) return new Set();
  if (/^[\d\s,]+$/.test(bare)) return inRange(bare.split(/[\s,]+/).filter(Boolean).map(Number));

  // Wordy and without JSON: it did not answer in the form asked for, and a guess here silently keeps
  // the wrong messages. Nothing is kept, and the run says how many were asked.
  return new Set();
}
