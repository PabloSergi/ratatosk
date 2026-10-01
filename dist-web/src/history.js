import { appendFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
/** How many lines a file keeps. Old enough to show a trend, small enough to read in one gulp. */
const KEEP = Number(process.env['RATATOSK_HISTORY_KEEP'] ?? 2000);
export function historyFileFor(userId) {
    return join(process.env['RATATOSK_HISTORY'] ?? 'history', `${userId}.jsonl`);
}
/**
 * Carry a scraper's past over to its new name.
 *
 * History is a log of lines, each naming the scraper it belongs to, so a rename that ignores it leaves
 * the story behind under a name nothing points at any more. The file is rewritten once, in place.
 */
export async function renameInHistory(file, from, to) {
    let lines;
    try {
        lines = (await readFile(file, 'utf8')).split('\n').filter(Boolean);
    }
    catch {
        return 0;
    }
    let moved = 0;
    const next = lines.map((line) => {
        const run = parse(line);
        if (!run || run.robot !== from)
            return line;
        moved++;
        return JSON.stringify({ ...run, robot: to });
    });
    if (moved > 0) {
        const temporary = `${file}.writing`;
        await writeFile(temporary, `${next.join('\n')}\n`, 'utf8');
        await rename(temporary, file);
    }
    return moved;
}
export async function remember(file, run) {
    await mkdir(dirname(file), { recursive: true });
    await appendFile(file, `${JSON.stringify(run)}\n`, 'utf8');
    await trim(file);
}
/**
 * The most recent runs, newest first. A robot name narrows it to one robot's own story.
 */
export async function recent(file, options = {}) {
    const limit = options.limit ?? 100;
    let lines;
    try {
        lines = (await readFile(file, 'utf8')).split('\n').filter(Boolean);
    }
    catch {
        return [];
    }
    const runs = [];
    for (let index = lines.length - 1; index >= 0 && runs.length < limit; index--) {
        const run = parse(lines[index]);
        if (!run)
            continue;
        if (options.robot && run.robot !== options.robot)
            continue;
        runs.push(run);
    }
    return runs;
}
export async function standing(file) {
    const runs = await recent(file, { limit: KEEP });
    const byRobot = new Map();
    // Newest first: the first line for a robot is how it is now, and the ones after it extend the streak
    // until one of them disagrees. After that the older runs are history, not the present state.
    for (const run of runs) {
        if (run.kind === 'build')
            continue; // a build is not how the scraper is doing
        // A quiet run is a working scraper with nothing new to say. Judged as itself it would read as
        // empty, and a streak of them as broken — which is what happens to every scraper that remembers,
        // every day, until nobody reads the warnings any more.
        const status = run.quiet ? 'ok' : run.status;
        const seen = byRobot.get(run.robot);
        if (!seen) {
            byRobot.set(run.robot, {
                now: {
                    robot: run.robot,
                    status,
                    at: run.at,
                    rows: run.rows,
                    inARow: 1,
                    ...(run.why ? { why: run.why } : {}),
                    ...(run.door ? { door: true } : {}),
                    ...(run.quiet ? { quiet: true } : {}),
                },
                streak: true,
            });
            continue;
        }
        if (!seen.streak)
            continue;
        if (status === seen.now.status)
            seen.now.inARow++;
        else
            seen.streak = false;
    }
    return [...byRobot.values()].map((entry) => entry.now).sort((left, right) => right.at.localeCompare(left.at));
}
function parse(line) {
    try {
        return JSON.parse(line);
    }
    catch {
        return undefined;
    }
}
/**
 * Keep the file from growing forever. Rewriting the tail is cheap at this size and needs no rotation
 * scheme, no cron and nothing to configure.
 */
async function trim(file) {
    const lines = (await readFile(file, 'utf8').catch(() => '')).split('\n').filter(Boolean);
    if (lines.length <= KEEP * 1.5)
        return;
    const temporary = `${file}.trimming`;
    await writeFile(temporary, `${lines.slice(-KEEP).join('\n')}\n`, 'utf8');
    await rename(temporary, file);
}
