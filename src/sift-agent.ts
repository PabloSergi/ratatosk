import { judgeSift, sift, type Row, type Sift } from './sift.js';

/**
 * Turning "vacancies, not CVs" into a rule that runs without a model.
 *
 * A channel is a stream of whatever people write: postings, CVs from people looking for work, someone
 * selling accounts, someone saying "up". The task is in the person's words, and the difference between
 * the two directions of the same trade — hiring and being hired — lives in the wording of a sentence,
 * which is exactly what a model is for and exactly what a substring match cannot do.
 *
 * So the model reads real messages and writes patterns; the platform then applies them to those same
 * messages and says how many stayed, how many went, and which ones. A rule that keeps everything has
 * decided nothing and a rule that keeps nothing has matched a peculiarity of the sample — both are
 * refused. What survives is regular expressions in a file, and nothing calls a model again.
 */
export interface SiftAttempt {
  rule: Sift;
  kept: number;
  dropped: number;
  good: boolean;
  note: string;
  examples: { kept: string[]; dropped: string[]; collisions: string[] };
  /** How many messages a keep found and a drop then took away. */
  collisions: number;
  /** Of the kept messages that were checked, how many were not what the task asked for. */
  wrong?: { checked: number; wrong: number; examples: string[] };
  /** …and of the thrown-away ones, how many were. This is where a rule loses data quietly. */
  missed?: { checked: number; wrong: number; examples: string[] };
}

export interface SiftBuild {
  sift?: Sift;
  attempts: SiftAttempt[];
  usage: { promptTokens: number; completionTokens: number; calls: number };
  reason?: string;
}

export interface SiftOptions {
  /** Real messages, as the robot would collect them. The rule is judged on these and nothing else. */
  sample: Row[];
  /** What the person asked for, in their own words. */
  want: string;
  apiKey: string;
  model: string;
  baseUrl: string;
  maxSteps?: number;
  /** The model call, injectable so this can be tested without a network or a bill. */
  ask?: Ask;
}

export type Ask = (messages: Message[]) => Promise<{ content: string; usage?: Usage }>;
export interface Message {
  role: 'system' | 'user' | 'assistant';
  content: string;
}
interface Usage {
  prompt_tokens?: number;
  completion_tokens?: number;
}

const SYSTEM = `You are given real messages from a channel and a task in somebody's own words. Write the
rule that separates the messages the task wants from everything else.

Answer with JSON and nothing else:

{
  "keep": ["…", "…"],          // JavaScript regular expressions, case-insensitive. A message stays if it matches ANY.
  "drop": ["…"],               // …unless it matches one of these. A drop always wins over a keep.
  "fields": {                  // optional: values read out of the text itself
    "pay": { "pattern": "…" }  // the first capturing group is the value, or the whole match if there is none
  },
  "judge": true                // optional: have a model look at the leftovers on every run (see below)
}

What matters:
- The same trade has two directions and they read almost alike. "Looking for work" and "looking for
  someone" are opposite things; so are a CV and a posting, an offer to buy and an offer to sell. The
  task says which direction is wanted; the patterns must tell them apart by how people actually write
  them — in whatever language they write in, which is rarely English.
- Write for the language the messages are in, and for how people really write: abbreviations, typos,
  missing spaces after punctuation, emoji in the middle of a word.
- Do not write one enormous pattern. Several plain ones are easier to read and to repair later.
- A rule that keeps everything is not a rule. Neither is one that keeps two messages out of two hundred.
- A drop must not describe a word that also appears inside what you want. "Resume", "CV", "interested"
  and "experience" are written in postings as often as in the answers to them; a drop built on those
  removes the very messages you were asked to find. Aim a drop at who is speaking, not at a topic.
- Set "judge": true when the task cannot be settled by wording alone — when whether a message fits
  depends on meaning a pattern cannot see, or when people plainly write about this in many ways. Then
  every run puts the messages your patterns did not claim to a model, in one batched call. That costs
  money on every run, so ask for it when it is needed and not otherwise.`;

export async function buildSift(options: SiftOptions): Promise<SiftBuild> {
  const usage = { promptTokens: 0, completionTokens: 0, calls: 0 };
  const attempts: SiftAttempt[] = [];
  const ask = options.ask ?? httpAsk(options);
  const maxSteps = options.maxSteps ?? 3;

  if (options.sample.length === 0) {
    return { attempts, usage, reason: 'there were no messages to learn from' };
  }

  const messages: Message[] = [
    { role: 'system', content: SYSTEM },
    {
      role: 'user',
      content:
        `Task: ${options.want}\n\n` +
        `Here are ${Math.min(options.sample.length, SHOWN)} real messages from the channel(s), one per line:\n` +
        options.sample
          .slice(0, SHOWN)
          // The first lines carry who is speaking and what they want, which is the whole decision; the
          // rest is terms and emoji. Sending it all costs tokens on every attempt and teaches nothing.
          .map((row, index) => `${index + 1}. ${textOf(row).replace(/\s+/g, ' ').slice(0, 200)}`)
          .join('\n'),
    },
  ];

  for (let step = 0; step < maxSteps; step++) {
    const reply = await ask(messages);
    usage.calls++;
    usage.promptTokens += reply.usage?.prompt_tokens ?? 0;
    usage.completionTokens += reply.usage?.completion_tokens ?? 0;

    const rule = parseRule(reply.content, options.want);
    if (!rule) {
      messages.push({ role: 'assistant', content: reply.content });
      messages.push({ role: 'user', content: 'That was not the JSON asked for. Answer with the object alone.' });
      continue;
    }

    // The platform decides, not the model: the rule meets the messages it was written for.
    let result;
    try {
      result = sift(options.sample, rule);
    } catch (error) {
      messages.push({ role: 'assistant', content: reply.content });
      messages.push({ role: 'user', content: `${(error as Error).message}. Fix the pattern and answer again.` });
      continue;
    }

    const verdict = judgeSift(result, options.sample.length);
    attempts.push({
      rule,
      kept: result.kept,
      dropped: result.dropped,
      good: verdict.good,
      note: verdict.note,
      examples: result.examples,
      collisions: result.collisions.length,
    });

    if (verdict.good) {
      // Coverage is only half of it. A rule that keeps a hundred messages has proved nothing if forty
      // of them are the opposite of what was asked — and patterns cannot see who the subject of a
      // sentence is: "looking for designers" and "designer looking for work" are the same string to them.
      // So the kept messages are read back, and the model marks the ones that do not belong.
      const audit = await checkKept(result.rows, options.want, ask, usage);
      attempts[attempts.length - 1]!.wrong = audit;

      // …and the other half. A rule that keeps eleven perfect postings and throws away thirty more
      // passes a precision check with full marks, and is still losing most of what was asked for.
      const dropped = options.sample.filter((row) => !result.rows.includes(row));
      const missed = await checkKept(shuffled(dropped), options.want, ask, usage, 'dropped');
      attempts[attempts.length - 1]!.missed = missed;

      const missedShare = missed.checked ? missed.wrong / missed.checked : 0;
      if (missedShare > 0.2) {
        attempts[attempts.length - 1]!.good = false;
        attempts[attempts.length - 1]!.note =
          `it keeps ${result.kept}, but ${missed.wrong} of ${missed.checked} it threw away were what was asked for`;

        messages.push({ role: 'assistant', content: reply.content });
        messages.push({
          role: 'user',
          content:
            `${attempts[attempts.length - 1]!.note}.\n` +
            `These were thrown away and should have been kept: ${missed.examples.join(' | ')}\n` +
            `Widen the keeps: people do not write one sentence pattern. The same posting appears as ` +
            `"we need", "urgently need", "looking for", "vacancy:", "recruiting", with emoji and ` +
            `capitals in between, and the job word may come before the verb. Match on the job and the ` +
            `direction rather than on a word order.`,
        });
        continue;
      }

      const wrongShare = audit.checked ? audit.wrong / audit.checked : 0;
      if (wrongShare > 0.2) {
        attempts[attempts.length - 1]!.good = false;
        attempts[attempts.length - 1]!.note =
          `it keeps ${result.kept}, but ${audit.wrong} of ${audit.checked} checked were not what was asked`;

        messages.push({ role: 'assistant', content: reply.content });
        messages.push({
          role: 'user',
          content:
            `${attempts[attempts.length - 1]!.note}.\n` +
            `These were kept and should not have been: ${audit.examples.join(' | ')}\n` +
            `A pattern cannot see who the subject of a sentence is: "looking for designers" and ` +
            `"designer looking for work" are the same string to it. Anchor the direction — who is ` +
            `speaking, and about whom — or leave those to the judge.`,
        });
        continue;
      }

      // Whether the edge needs a model on every run is measured, not asked. Anything the patterns did
      // not claim, and anything they claimed wrongly, is exactly what a second opinion is for.
      const unclaimedShare = result.unclaimed.length / options.sample.length;
      const needsJudge = audit.wrong > 0 || unclaimedShare > 0.1;
      const finalRule: Sift = needsJudge
        ? { ...rule, judge: rule.judge ?? { want: options.want, maxRows: LEFTOVERS_PER_RUN } }
        : { ...rule };
      if (!needsJudge) delete finalRule.judge;

      return { sift: finalRule, attempts, usage };
    }

    messages.push({ role: 'assistant', content: reply.content });
    messages.push({
      role: 'user',
      content:
        `${verdict.note}.\n` +
        `Kept, for example: ${result.examples.kept.join(' | ') || '—'}\n` +
        `Dropped, for example: ${result.examples.dropped.join(' | ') || '—'}\n` +
        (result.examples.collisions.length
          ? `Taken away by a drop although a keep had found them: ${result.examples.collisions.join(' | ')}\n` +
            `A word that appears inside what you want is not a rule against it — "send your CV" is written ` +
            `in postings too. Narrow those drops or anchor them to how the message begins.\n`
          : '') +
        `Look at those and answer with a corrected rule.`,
    });
  }

  return {
    attempts,
    usage,
    reason: attempts.length
      ? `no rule separated these messages: ${attempts[attempts.length - 1]!.note}`
      : 'the model never answered with a usable rule',
  };
}

/**
 * Read the kept messages back and ask which of them do not belong.
 *
 * One call, on a sample: this is the only way to catch a rule that is generous in the wrong direction,
 * and it costs a fraction of what a wrong robot costs the person running it.
 */
/**
 * Reading a rule's decisions back to a model, in whichever direction is being checked.
 *
 * Coverage is not correctness, and correctness has two halves. Asking only "is what you kept right?"
 * measures precision and nothing else — a rule that keeps eleven perfect postings and throws away
 * thirty more passes that test with full marks. The thrown-away half is where a rule loses data
 * silently, which is the failure this whole project exists to prevent, so it is asked about too.
 */
async function checkKept(
  kept: Row[],
  want: string,
  ask: Ask,
  usage: { promptTokens: number; completionTokens: number; calls: number },
  direction: 'kept' | 'dropped' = 'kept',
): Promise<{ checked: number; wrong: number; examples: string[] }> {
  const batch = kept.slice(0, 15);
  if (batch.length === 0) return { checked: 0, wrong: 0, examples: [] };

  const listed = batch
    .map((row, index) => `${index + 1}. ${textOf(row).replace(/\s+/g, ' ').slice(0, 250)}`)
    .join('\n');

  const question =
    direction === 'kept'
      ? `A rule kept these messages as matching the task. Which of them do NOT match it? `
      : `A rule threw these messages away as not matching the task. Which of them DO match it, and ` +
        `should have been kept? `;

  const reply = await ask([
    {
      role: 'user',
      content: `Task: ${want}\n\n${question}Answer with their numbers only, comma separated, or the word none.\n\n${listed}`,
    },
  ]);
  usage.calls++;
  usage.promptTokens += reply.usage?.prompt_tokens ?? 0;
  usage.completionTokens += reply.usage?.completion_tokens ?? 0;

  if (/\bnone\b/i.test(reply.content)) return { checked: batch.length, wrong: 0, examples: [] };

  const wrong = [
    ...new Set(
      (reply.content.match(/\d+/g) ?? [])
        .map((number) => Number(number))
        .filter((number) => number >= 1 && number <= batch.length),
    ),
  ];
  return {
    checked: batch.length,
    wrong: wrong.length,
    examples: wrong.slice(0, 3).map((number) => textOf(batch[number - 1]!).replace(/\s+/g, ' ').slice(0, 110)),
  };
}

/**
 * A sample of what was thrown away, from across the whole of it rather than the top.
 *
 * The first fifteen dropped rows are the fifteen oldest, and a channel's oldest messages are not what
 * it is like today. Fifteen taken at random are.
 */
function shuffled(rows: Row[]): Row[] {
  const copy = [...rows];
  for (let index = copy.length - 1; index > 0; index--) {
    const swap = Math.floor(Math.random() * (index + 1));
    [copy[index], copy[swap]] = [copy[swap]!, copy[index]!];
  }
  return copy;
}

function textOf(row: Row): string {
  return Object.values(row)
    .filter((value): value is string => typeof value === 'string')
    .join('  ');
}

/** How many sampled messages the model is shown. Enough to see the shape, not the whole archive. */
const SHOWN = Number(process.env['RATATOSK_SIFT_SHOWN'] ?? 80);

/** How many unclaimed rows a single run may put to a model. A busy day must not become an expensive one. */
const LEFTOVERS_PER_RUN = Number(process.env['RATATOSK_JUDGE_PER_RUN'] ?? 40);

/** Models like to wrap JSON in prose or in a fence. Take the object and ignore the rest. */
function parseRule(content: string, want: string): Sift | undefined {
  const start = content.indexOf('{');
  const end = content.lastIndexOf('}');
  if (start === -1 || end <= start) return undefined;

  try {
    const parsed = JSON.parse(content.slice(start, end + 1)) as Sift & { judge?: boolean | { want: string; maxRows: number } };
    if (!Array.isArray(parsed.keep)) return undefined;
    return {
      want,
      keep: parsed.keep.filter((pattern) => typeof pattern === 'string'),
      ...(Array.isArray(parsed.drop) ? { drop: parsed.drop.filter((pattern) => typeof pattern === 'string') } : {}),
      ...(parsed.from ? { from: parsed.from } : {}),
      ...(parsed.fields && typeof parsed.fields === 'object' ? { fields: parsed.fields } : {}),
      // The model asks for a second opinion; the platform decides what it may cost.
      ...(parsed.judge ? { judge: { want, maxRows: LEFTOVERS_PER_RUN } } : {}),
    };
  } catch {
    return undefined;
  }
}

/** The ordinary call, same shape as everything else here: OpenAI-compatible chat completions. */
function httpAsk(options: SiftOptions): Ask {
  return async (messages) => {
    const response = await fetch(`${options.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${options.apiKey}`, 'x-title': 'ratatosk' },
      body: JSON.stringify({ model: options.model, messages, temperature: 0 }),
    });
    if (!response.ok) throw new Error(`the model answered ${response.status}: ${(await response.text()).slice(0, 200)}`);

    const body = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
      usage?: Usage;
    };
    return { content: body.choices?.[0]?.message?.content ?? '', ...(body.usage ? { usage: body.usage } : {}) };
  };
}
