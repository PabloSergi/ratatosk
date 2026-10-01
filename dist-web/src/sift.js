export class SiftError extends Error {
}
/** Compiled once per run, not once per row: a channel is thousands of messages. */
function compile(patterns) {
    return patterns.map((pattern) => {
        try {
            return new RegExp(pattern, 'iu');
        }
        catch (error) {
            throw new SiftError(`"${pattern}" is not a usable pattern: ${error.message}`);
        }
    });
}
function textOf(row, from) {
    if (from)
        return String(row[from] ?? '');
    return Object.values(row)
        .filter((value) => typeof value === 'string')
        .join('  ');
}
/**
 * The fields a rule reads out of a row's text, without deciding anything about the row.
 *
 * Separate because the identity of a row can live in one of them — an id cut out of a link — and
 * whoever needs that identity before the sift has run (to know whether the row is worth opening at
 * all) must read it the same way, or the two will disagree about what a row is.
 */
export function fieldsOf(row, rule) {
    const found = {};
    for (const [name, field] of Object.entries(rule.fields ?? {})) {
        const pattern = compile([field.pattern])[0];
        const match = pattern.exec(textOf(row, field.from ?? rule.from));
        found[name] = match ? (match[1] ?? match[0]).trim() : null;
    }
    return found;
}
export function sift(rows, rule) {
    const keep = compile(rule.keep ?? []);
    const drop = compile(rule.drop ?? []);
    const fields = Object.entries(rule.fields ?? {}).map(([name, field]) => ({
        name,
        from: field.from,
        pattern: compile([field.pattern])[0],
    }));
    const out = [];
    const unclaimed = [];
    const discarded = [];
    const collisions = [];
    const examples = { kept: [], dropped: [], collisions: [] };
    for (const row of rows) {
        const text = textOf(row, rule.from);
        const wanted = keep.length === 0 || keep.some((pattern) => pattern.test(text));
        const refused = drop.some((pattern) => pattern.test(text));
        if (!wanted || refused) {
            discarded.push(row);
            if (examples.dropped.length < 3)
                examples.dropped.push(text.replace(/\s+/g, ' ').slice(0, 90));
            // Refused outright is a decision; merely unclaimed is a question, and a question can be asked.
            if (!refused)
                unclaimed.push(row);
            // A collision is a keep and a drop disagreeing about one row. With no keeps at all there is
            // nothing to disagree with: "keep everything except this" is a legitimate shape of rule, and
            // counting each of its drops as a collision refuses it for doing exactly what it says.
            if (keep.length > 0 && wanted && refused) {
                collisions.push(row);
                if (examples.collisions.length < 3)
                    examples.collisions.push(text.replace(/\s+/g, ' ').slice(0, 110));
            }
            continue;
        }
        // Only now, on a row that is staying: reading fields out of text nobody keeps is wasted work.
        const found = { ...row };
        for (const field of fields) {
            const match = field.pattern.exec(textOf(row, field.from ?? rule.from));
            found[field.name] = match ? (match[1] ?? match[0]).trim() : null;
        }
        out.push(found);
        if (examples.kept.length < 3)
            examples.kept.push(text.replace(/\s+/g, ' ').slice(0, 90));
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
export function judgeSift(result, total) {
    if (total === 0)
        return { good: false, note: 'there was nothing to sift' };
    const share = result.kept / total;
    if (result.kept === 0)
        return { good: false, note: 'it kept nothing at all — the patterns match none of these messages' };
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
            note: `the drops took away ${result.collisions.length} of the ${claimed} messages the keeps found — ` +
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
export async function judgeLeftovers(rows, want, ask, limit) {
    const batch = rows.slice(0, Math.max(0, limit));
    if (batch.length === 0)
        return { rows: [], asked: 0 };
    const listed = batch
        .map((row, index) => `${index + 1}. ${textOf(row).replace(/\s+/g, ' ').slice(0, 300)}`)
        .join('\n');
    const answer = await ask(`Task: ${want}\n\n` +
        `Which of these messages fit the task?\n` +
        `Answer with JSON and nothing else: {"keep":[1,3]} — or {"keep":[]} if none of them do.\n\n${listed}`);
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
function chosen(answer, count) {
    const inRange = (numbers) => new Set(numbers.filter((number) => Number.isInteger(number) && number >= 1 && number <= count));
    const start = answer.indexOf('{');
    const end = answer.lastIndexOf('}');
    if (start !== -1 && end > start) {
        try {
            const parsed = JSON.parse(answer.slice(start, end + 1));
            if (Array.isArray(parsed.keep))
                return inRange(parsed.keep.map(Number));
        }
        catch {
            // Not JSON after all; fall through to the plain-list form.
        }
    }
    const bare = answer.trim();
    if (/^none$/i.test(bare))
        return new Set();
    if (/^[\d\s,]+$/.test(bare))
        return inRange(bare.split(/[\s,]+/).filter(Boolean).map(Number));
    // Wordy and without JSON: it did not answer in the form asked for, and a guess here silently keeps
    // the wrong messages. Nothing is kept, and the run says how many were asked.
    return new Set();
}
