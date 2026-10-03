import type { PageDriver } from './driver.js';
import type { Robot } from './robots.js';
import type { SiteRule } from './rules.js';
import { runScenario, type RunResult } from './run.js';
import { identity, identityOfMessage, meet, type Remember, type Row, type Seen } from './memory.js';
import { fieldsOf, judgeSift, sift, type Sift } from './sift.js';
import { isTelegramRobot, runTelegramRobot } from './telegram.js';
import { asker, deepen, isApiRobot, runApiRobot, type AskJson } from './api.js';
import { maskRow } from './mask.js';

/**
 * One way to run a robot, whatever it reads. Callers — the web view, the MCP server, cron — ask for
 * rows and get the same verdicts back, so a Telegram robot that comes back empty is as visible as a
 * page robot that does.
 *
 * The browser is passed as a function so that a Telegram robot never starts one.
 */
/**
 * Take the phone numbers out, when this scraper is one that must not carry them.
 *
 * A choice per source rather than a rule for all: a board of flats has no business keeping somebody's
 * mobile, and a board of vacancies is scraped precisely so an employer can be written to. Both are
 * legitimate, and the difference is not something the engine can guess.
 */
function withoutNumbers(robot: Robot, rows: Array<Record<string, string | null>>): Array<Record<string, string | null>> {
  return (robot as { mask?: boolean }).mask ? rows.map(maskRow) : rows;
}

export async function runRobot(
  robot: Robot,
  options: {
    page: () => Promise<PageDriver>;
    rules?: SiteRule[];
    maxPages?: number;
    telegramSession?: string;
    /** How to put a question to a JSON feed. Injected so a test never reaches the network. */
    askJson?: AskJson;
    /**
     * Somewhere to write down everything this pass saw, before the memory decides what is new.
     * That is what a catalogue is made of, and it cannot be reconstructed from what was handed on.
     */
    saw?: (rows: Array<Record<string, string | null>>) => Promise<void>;
    /** What this robot has seen before, and somewhere to put what it sees now. */
    memory?: { seen: Record<string, Seen>; save: (memory: Record<string, Seen>) => Promise<void> };
  },
): Promise<RunResult> {
  if (isTelegramRobot(robot)) {
    const { rows, reason } = await runTelegramRobot(robot, options.telegramSession);
    if (reason) return { status: 'broken', rows: [], pagesVisited: 0, reason };

    const sifted = applySift(rows, robot.sift);
    if (sifted.rows.length === 0) {
      return {
        status: 'empty',
        rows: [],
        pagesVisited: robot.channels.length,
        // "Nothing came" and "everything that came was noise" are different problems with different
        // answers: one is a dead channel, the other is a rule that no longer fits what people write.
        reason: rows.length
          ? `${rows.length} messages came from ${robot.channels.join(', ')} and the sift kept none of them`
          : `no messages matched in ${robot.channels.join(', ')}`,
        ...(sifted.note ? { evidence: { blocksSeen: rows.length, missingFields: {}, url: robot.channels.join(', ') } } : {}),
      };
    }
    await options.saw?.(sifted.rows);
    const seen = await remember(sifted.rows, robot.remember, options.memory, identityOfMessage);
    if (seen.rows.length === 0 && seen.note) {
      // Everything that came was something we already had. That is not an empty channel and not a
      // broken robot — it is a quiet day, and it must not read like either.
      return {
        status: 'empty',
        quiet: true,
        rows: [],
        pagesVisited: robot.channels.length,
        reason: [sifted.note, seen.note].filter(Boolean).join('; '),
      };
    }

    return {
      status: 'ok',
      rows: withoutNumbers(robot, seen.rows),
      pagesVisited: robot.channels.length,
      ...(sifted.note || seen.note ? { reason: [sifted.note, seen.note].filter(Boolean).join('; ') } : {}),
    };
  }

  if (isApiRobot(robot)) {
    const feed = await runApiRobot(robot, options.askJson ?? asker());
    if (feed.rows.length === 0) {
      return {
        status: 'empty',
        rows: [],
        pagesVisited: feed.calls,
        reason: feed.reason ?? 'the feed answered, and had nothing in it',
      };
    }

    const sifted = applySift(feed.rows, (robot as { sift?: Sift }).sift);
    await options.saw?.(sifted.rows);
    const seen = await remember(sifted.rows, robot.remember, options.memory);
    const why = [feed.reason, sifted.note, seen.note].filter(Boolean).join('; ');
    if (seen.rows.length === 0 && seen.note) {
      // Everything the feed held had already been handed over. A quiet hour, not a dead source.
      return { status: 'empty', quiet: true, rows: [], pagesVisited: feed.calls, reason: why };
    }

    // Only what is being handed on goes one level deeper: a call per row is affordable for an hour's
    // new listings and not for the whole board, and the whole board was already deepened once.
    const deeper = robot.detail
      ? await deepen(seen.rows, robot.detail, options.askJson ?? asker())
      : { rows: seen.rows, calls: 0 };

    return {
      status: 'ok',
      rows: withoutNumbers(robot, deeper.rows),
      pagesVisited: feed.calls + deeper.calls,
      ...(why ? { reason: why } : {}),
    };
  }

  const scenario =
    options.maxPages && (robot.pagination.type === 'link' ||
      robot.pagination.type === 'button' ||
      robot.pagination.type === 'param' ||
      robot.pagination.type === 'number')
      ? { ...robot, pagination: { ...robot.pagination, maxPages: options.maxPages } }
      : robot;

  /**
   * Which rows are worth a page of their own.
   *
   * The walk into rows costs one page load each, and a source read every couple of hours is mostly
   * rows that were read last time. The feed reader above already works this way — deepen what is being
   * handed on, not the whole board — and there is no reason a page walk should be the exception.
   *
   * The identity has to be read exactly as the memory will read it later, sift-made columns included:
   * an id cut out of a link does not exist until the sift has run, and two different answers to "what
   * is this row" would mean opening everything or nothing.
   */
  const known = options.memory?.seen;
  const worthOpening =
    robot.detail && robot.remember && robot.remember.mode !== 'all' && known
      ? (row: Record<string, string | null>): boolean => {
          const whole = robot.sift ? { ...row, ...fieldsOf(row, robot.sift) } : row;
          const key = identity(whole, robot.remember?.by);
          return !key || !known[key];
        }
      : undefined;

  /**
   * The catalogue, filled as the walk goes rather than at the end of it.
   *
   * What a page holds is known the moment the page is read, and a walk that is stopped — a deploy, a
   * restart, a site that gives up — should leave that knowledge behind rather than throw away hours
   * of it. Only the patterns are applied here, never a model: this runs per page, and a question per
   * page is a different bill entirely. The handover below still sifts the whole harvest.
   */
  const onPage = options.saw
    ? async (rows: Array<Record<string, string | null>>): Promise<void> => {
        const kept = robot.sift ? sift(rows, robot.sift).rows : rows;
        if (kept.length) await options.saw!(kept);
      }
    : undefined;

  const run = await runScenario(await options.page(), scenario, {
    rules: options.rules,
    ...(worthOpening ? { worthOpening } : {}),
    ...(onPage ? { onPage } : {}),
  });
  // A run that did not come back with rows has nothing to sift and nothing to remember. Sifting and
  // remembering are separate things, though: a robot may do either, both, or neither.
  if (run.status !== 'ok' || (!robot.sift && !robot.remember)) return run;

  const sifted = applySift(run.rows, robot.sift);
  if (sifted.rows.length === 0 && robot.sift) {
    return { ...run, status: 'empty', rows: [], reason: `the sift kept none of the ${run.rows.length} rows` };
  }

  const seen = await remember(sifted.rows, robot.remember, options.memory);
  const spared = run.evidence?.rowsKnownAlready;
  const reason = [sifted.note, seen.note, spared ? `${spared} already read were not opened again` : undefined]
    .filter(Boolean)
    .join('; ');
  if (seen.rows.length === 0 && seen.note) {
    // The same quiet day on a page walk: rows were found, and every one of them had been handed over.
    return { ...run, status: 'empty', quiet: true, rows: [], reason };
  }
  return { ...run, rows: withoutNumbers(robot, seen.rows), ...(reason ? { reason } : {}) };
}

/**
 * Hand back what has not been seen before, and move the memory forward.
 *
 * A robot without this returns the same posting every hour for a month. A robot with it returns it
 * once and then says, honestly, that nothing new came — which is a different thing from an empty
 * source and has to read differently.
 */
async function remember(
  rows: Array<Record<string, string | null>>,
  rule: Remember | undefined,
  memory: { seen: Record<string, Seen>; save: (memory: Record<string, Seen>) => Promise<void> } | undefined,
  /** What identifies a row from this source. See `identityOfMessage` for why a channel differs. */
  identify?: (row: Row, by?: string) => string | undefined,
): Promise<{ rows: Array<Record<string, string | null>>; note?: string }> {
  if (!rule || !memory) return { rows };

  const sighting = meet(rows, memory.seen, rule, new Date(), identify);
  await memory.save(sighting.memory);

  const note =
    sighting.repeated.length > 0
      ? `${sighting.repeated.length} of ${rows.length} had been seen before` +
        (sighting.forgotten ? `; ${sighting.forgotten} old ones forgotten` : '')
      : undefined;

  if (rule.mode === 'all') {
    // Everything, with the repeats marked: a different job, and a legitimate one.
    const marked = rows.map((row) => {
      const known = sighting.repeated.find((one) => one.row === row);
      return known ? { ...row, seenBefore: known.firstSeen, timesSeen: String(known.times) } : row;
    });
    return { rows: marked, ...(note ? { note } : {}) };
  }

  return { rows: sighting.fresh, ...(note ? { note } : {}) };
}

/**
 * The sift, with its verdict in words — a rule that keeps everything has decided nothing.
 *
 * Patterns, and nothing else. A run used to be able to put what the patterns could not decide to a
 * model — "is this a vacancy or somebody's CV?" — and that was the engine holding an opinion about
 * somebody else's subject. Every user's edge is their own: what counts as a vacancy here is a flat
 * there and a lead somewhere else, and none of it belongs in the thing that fetches pages. The rows
 * are handed over; whoever asked for them decides what they mean.
 *
 * A model still writes and mends the rule itself — see sift-agent.ts and rule-repair.ts. Writing the
 * rule is the platform's business; applying somebody's meaning to a row is not.
 */
function applySift(
  rows: Array<Record<string, string | null>>,
  rule: Sift | undefined,
): { rows: Array<Record<string, string | null>>; note?: string } {
  if (!rule) return { rows };

  const result = sift(rows, rule);
  return { rows: result.rows, note: `sift: ${judgeSift(result, rows.length).note}` };
}

function firstLine(error: unknown): string {
  return error instanceof Error ? (error.message.split('\n')[0] ?? error.message).slice(0, 120) : String(error);
}
