import type { PageDriver } from './driver.js';
import type { Robot } from './robots.js';
import type { SiteRule } from './rules.js';
import { runScenario, type RunResult } from './run.js';
import { meet, type Remember, type Seen } from './memory.js';
import { judgeLeftovers, judgeSift, sift, type Sift } from './sift.js';
import { isTelegramRobot, runTelegramRobot } from './telegram.js';

/**
 * One way to run a robot, whatever it reads. Callers — the web view, the MCP server, cron — ask for
 * rows and get the same verdicts back, so a Telegram robot that comes back empty is as visible as a
 * page robot that does.
 *
 * The browser is passed as a function so that a Telegram robot never starts one.
 */
export async function runRobot(
  robot: Robot,
  options: {
    page: () => Promise<PageDriver>;
    rules?: SiteRule[];
    maxPages?: number;
    telegramSession?: string;
    /** How to put a question to a model, when a robot's rule leaves the edge cases to one. */
    ask?: (prompt: string) => Promise<string>;
    /** What this robot has seen before, and somewhere to put what it sees now. */
    memory?: { seen: Record<string, Seen>; save: (memory: Record<string, Seen>) => Promise<void> };
  },
): Promise<RunResult> {
  if (isTelegramRobot(robot)) {
    const { rows, reason } = await runTelegramRobot(robot, options.telegramSession);
    if (reason) return { status: 'broken', rows: [], pagesVisited: 0, reason };

    const sifted = await applySift(rows, robot.sift, options.ask);
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
    const seen = await remember(sifted.rows, robot.remember, options.memory);
    if (seen.rows.length === 0 && seen.note) {
      // Everything that came was something we already had. That is not an empty channel and not a
      // broken robot — it is a quiet day, and it must not read like either.
      return {
        status: 'empty',
        rows: [],
        pagesVisited: robot.channels.length,
        reason: [sifted.note, seen.note].filter(Boolean).join('; '),
      };
    }

    return {
      status: 'ok',
      rows: seen.rows,
      pagesVisited: robot.channels.length,
      ...(sifted.note || seen.note ? { reason: [sifted.note, seen.note].filter(Boolean).join('; ') } : {}),
    };
  }

  const scenario =
    options.maxPages && (robot.pagination.type === 'link' ||
      robot.pagination.type === 'button' ||
      robot.pagination.type === 'param' ||
      robot.pagination.type === 'number')
      ? { ...robot, pagination: { ...robot.pagination, maxPages: options.maxPages } }
      : robot;

  const run = await runScenario(await options.page(), scenario, { rules: options.rules });
  // A run that did not come back with rows has nothing to sift and nothing to remember. Sifting and
  // remembering are separate things, though: a robot may do either, both, or neither.
  if (run.status !== 'ok' || (!robot.sift && !robot.remember)) return run;

  const sifted = await applySift(run.rows, robot.sift, options.ask);
  if (sifted.rows.length === 0 && robot.sift) {
    return { ...run, status: 'empty', rows: [], reason: `the sift kept none of the ${run.rows.length} rows` };
  }

  const seen = await remember(sifted.rows, robot.remember, options.memory);
  const reason = [sifted.note, seen.note].filter(Boolean).join('; ');
  if (seen.rows.length === 0 && seen.note) {
    return { ...run, status: 'empty', rows: [], reason };
  }
  return { ...run, rows: seen.rows, ...(reason ? { reason } : {}) };
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
): Promise<{ rows: Array<Record<string, string | null>>; note?: string }> {
  if (!rule || !memory) return { rows };

  const sighting = meet(rows, memory.seen, rule);
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
 * Patterns first, because they are free. Then, only if the robot asks for it and only for the rows no
 * pattern claimed, one batched question to a model: that is where the wording nobody anticipated gets
 * caught, and it is bounded so a busy day cannot quietly become an expensive one.
 */
async function applySift(
  rows: Array<Record<string, string | null>>,
  rule: Sift | undefined,
  ask?: (prompt: string) => Promise<string>,
): Promise<{ rows: Array<Record<string, string | null>>; note?: string }> {
  if (!rule) return { rows };

  const result = sift(rows, rule);
  const verdict = judgeSift(result, rows.length);
  if (!rule.judge || !ask || result.unclaimed.length === 0) {
    return { rows: result.rows, note: `sift: ${verdict.note}` };
  }

  try {
    const second = await judgeLeftovers(result.unclaimed, rule.judge.want, ask, rule.judge.maxRows);
    return {
      rows: [...result.rows, ...second.rows],
      note:
        `sift: ${verdict.note}; a model looked at ${second.asked} the patterns did not claim ` +
        `and kept ${second.rows.length}`,
    };
  } catch (error) {
    // A model that will not answer must not cost the run: the patterns already did their work.
    return {
      rows: result.rows,
      note: `sift: ${verdict.note}; the second opinion was unavailable (${firstLine(error)})`,
    };
  }
}

function firstLine(error: unknown): string {
  return error instanceof Error ? (error.message.split('\n')[0] ?? error.message).slice(0, 120) : String(error);
}
