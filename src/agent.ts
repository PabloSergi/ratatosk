import { buildScenario, paginateProbe, tryFields, widenRows } from './build.js';
import type { PageDriver } from './driver.js';
import { look } from './look.js';
import { judge, type QualityVerdict } from './quality.js';
import { applyRules, matchRules, type SiteRule } from './rules.js';
import { runScenario } from './run.js';
import { asExtractResult, EXTRACTOR_SOURCE } from './extractor.js';
import type { DetailRule, FieldRule, ListRule, PaginationRule, Scenario } from './scenario.js';

/**
 * The model builds the robot. This is the bet the whole product rests on.
 *
 * Heuristics are a floor: they take the first thing that yields rows and stop there, which is how you
 * end up with a column filled in one card out of eight and a list that never turns the page. Finding a
 * way to parse a site is judgement — see that the link is on the heading rather than the logo, notice
 * that the real list lives one URL over, recognise a badge as decoration — and judgement is what a
 * model is for.
 *
 * It works the same loop a person does, through the same tools, and it does not get to declare victory:
 * `finish` runs the scenario and puts it through the quality gate. Complaints come back as work.
 */
export interface AgentStep {
  tool: string;
  input: unknown;
  /** Compact, human-readable outcome — this is what the operator watches. */
  result: string;
}

export interface AgentResult {
  scenario?: Scenario;
  steps: AgentStep[];
  verdict?: QualityVerdict;
  rows: Array<Record<string, string | null>>;
  reason?: string;
  /** The page is a door meant for a person. Nothing to fix in a selector; someone has to open it. */
  challenge?: boolean;
  /** What the model cost, so the price of a build is never a mystery. */
  usage: { promptTokens: number; completionTokens: number; calls: number };
}

export interface AgentOptions {
  url: string;
  /** What the person asked for, in their own words. */
  want: string;
  name: string;
  rules?: SiteRule[];
  apiKey: string;
  model?: string;
  baseUrl?: string;
  maxSteps?: number;
}

const DEFAULT_MODEL = process.env['RATATOSK_MODEL'] ?? 'openai/gpt-5-nano';
/** Cheap models get rate-limited upstream. A build should step aside rather than die. */
const FALLBACKS = (process.env['RATATOSK_FALLBACK_MODELS'] ?? 'deepseek/deepseek-v4-flash,mistralai/mistral-nemo').split(',');
const DEFAULT_BASE = process.env['RATATOSK_LLM_URL'] ?? 'https://openrouter.ai/api/v1';

export async function buildWithModel(page: PageDriver, options: AgentOptions): Promise<AgentResult> {
  const rules = options.rules ?? [];
  const steps: AgentStep[] = [];
  const usage = { promptTokens: 0, completionTokens: 0, calls: 0 };
  const maxSteps = options.maxSteps ?? 20;

  await page.goto(options.url);
  await page.waitMs(2500);
  const applied = await applyRules(page, rules);
  const sketch = await look(page);
  const challenge = sketch.notes.find((note) => note.startsWith('CHALLENGE PAGE'));
  if (challenge) {
    steps.push({ tool: 'open', input: { url: options.url }, result: `${sketch.title} — ${challenge}` });
    return {
      steps,
      rows: [],
      usage,
      // Named, not just described: the interface offers the one thing that gets past this — a person.
      challenge: true,
      reason:
        `${options.url} answers with a door meant for a person, not the list ("${sketch.title}"). ` +
        `No amount of selector work gets past that: open it yourself, pass the check by hand, and this ` +
        `robot's profile keeps what the site leaves behind.`,
    };
  }

  steps.push({
    tool: 'open',
    input: { url: options.url },
    result: `${sketch.title} — ${sketch.candidates.length} repeating block(s)${applied.length ? `, cleared: ${applied.join('; ')}` : ''}`,
  });

  const messages: Message[] = [
    { role: 'system', content: SYSTEM },
    {
      role: 'user',
      content:
        `Site: ${options.url}\n` +
        `What is wanted: ${options.want}\n\n` +
        `First look at the page:\n${JSON.stringify(sketch, null, 1)}`,
    },
  ];

  let best: { scenario: Scenario; verdict: QualityVerdict; rows: Array<Record<string, string | null>> } | undefined;
  const progress: Progress = { step: 0, maxSteps, seen: new Set<string>() };

  for (let step = 0; step < maxSteps; step++) {
    const reply = await chat(messages, options, usage);
    if (!reply) break;

    if (!reply.tool_calls?.length) {
      // The model answered in prose. That is not an outcome; push it back to work.
      messages.push({ role: 'assistant', content: reply.content ?? '' });
      messages.push({ role: 'user', content: 'Use the tools. Nothing counts until finish() passes the quality gate.' });
      continue;
    }

    messages.push({ role: 'assistant', content: reply.content ?? '', tool_calls: reply.tool_calls });

    for (const call of reply.tool_calls) {
      const args = safeParse(call.function.arguments);
      const outcome = await runTool(page, call.function.name, args, { ...options, rules }, steps, progress);
      progress.step = step;

      if (outcome.finished) {
        best = outcome.finished;
        if (outcome.finished.verdict.good) {
          return { scenario: best.scenario, steps, verdict: best.verdict, rows: best.rows, usage };
        }
      }

      messages.push({ role: 'tool', tool_call_id: call.id, content: outcome.forModel });
    }

    if (step === maxSteps - 3) {
      messages.push({
        role: 'user',
        content: 'Three steps left. Call finish with the best row selector and fields you have — an imperfect robot that exists beats none.',
      });
    }
  }

  return {
    scenario: best?.scenario,
    steps,
    verdict: best?.verdict,
    rows: best?.rows ?? [],
    usage,
    reason: best
      ? `stopped after ${maxSteps} steps with a scenario that still falls short: ${best.verdict.complaints.join('; ')}`
      : `stopped after ${maxSteps} steps without a scenario that runs`,
  };
}

const SYSTEM = `You build web scrapers by working a page through tools, the way a person would.

The artifact is a scenario: a row selector, a map of columns to selectors inside that row, and a
pagination rule. It runs later without you, so it must be right, not merely plausible.

How to work:
- look() gives the page as structure. Selectors in "fields" are relative to the row block.
- try_selector() shows what a candidate really returns, plus warnings. Read the warnings: a column
  filled in one row out of eight means the selector matched one card's variant, not the card.
- Prefer selectors that describe the ROLE of an element (the heading's link, a price class) over
  decorative classes tied to one card's styling.
- paginate_probe() finds the next control and presses it. Pagination is ALWAYS verified by pressing:
  a rule you merely assert in finish() is ignored, so probe it if you care about later pages.
- If the page is not the real list — a landing page, a redirect stub — open_page() somewhere better.
- Name the columns exactly as the person asked for them. Drop badges, labels and decoration.
- If the person asked for something the cards do not carry — pay, contacts, the full text — it lives one
  page deeper. Collect the row's link, then try_detail() to open a row and read it there. Do not invent
  a column the list cannot fill: an empty column is worse than an honest absence.
- finish() runs the scenario and judges it. If it comes back with complaints, fix them and finish again.

Every tool answer carries "nextStep" — read it. When it says the attempt passes the gate, call finish
immediately with those exact arguments; polishing a result that is already good wastes the budget.
Never repeat an attempt you have already made: change the selector, the fields, or the page.

Be economical: a few good attempts, then finish.`;

/**
 * The model proposes, the platform disposes. Waiting for a model to announce success is a design
 * mistake: mechanical decisions belong to the machine. The moment an attempt clears the bar, the
 * scenario is assembled, its pagination is proven and it is run — no permission asked.
 */
async function close(
  page: PageDriver,
  listInput: { rows: string; fields: Record<string, FieldRule> },
  options: AgentOptions & { rules: SiteRule[] },
  steps: AgentStep[],
  pagination?: PaginationRule,
  detail?: DetailRule,
): Promise<ToolOutcome> {
  /** Pagination a site rule declares for this host, if any. */
  type Walking = Exclude<PaginationRule, { type: 'none' }>;
  const paginationHint = (rules: SiteRule[], url: string): Walking | undefined => {
    for (const rule of matchRules(url, rules)) {
      const hint = rule.pagination as PaginationRule | undefined;
      if (hint && typeof hint === 'object' && 'type' in hint && hint.type !== 'none') return hint as Walking;
    }
    return undefined;
  };

  // Only a rule that was pressed counts. A pagination rule the model asserted is a guess, and a guess
  // here means a robot that walks page one forever and calls it a full harvest.
  // Before anything is frozen: is this selector the whole list, or a slice of it?
  let list = listInput;
  const wider = await widenRows(page, list);
  if (wider.widened) {
    steps.push({ tool: 'widen', input: { from: list.rows, to: wider.rows }, result: `wider selector keeps quality and finds ${wider.count} rows instead of fewer — taking it` });
    list = { ...list, rows: wider.rows };
  }

  // A site rule may know how this host continues when the page itself says nothing — a message
  // archive walks backwards by cursor. It is still only a hint: it counts once it has moved us.
  if (!pagination) {
    const hint = paginationHint(options.rules, options.url);
    if (hint) {
      const trial = buildScenario({
        name: options.name,
        url: options.url,
        rows: list.rows,
        fields: list.fields,
        pagination: hint.type === 'scroll' ? { ...hint, maxRounds: 2 } : { ...hint, maxPages: 2 },
      });
      const walk = await runScenario(page, trial, { rules: options.rules });
      if (walk.pagesVisited >= 2) {
        pagination = hint;
        steps.push({ tool: 'paginate_probe', input: hint, result: `site rule pagination works — ${walk.pagesVisited} pages, ${walk.rows.length} rows` });
      }
    }
  }

  let rule = pagination;
  // "There is no next control" is an answer, not a failure: a one-page list is a legitimate robot.
  // What must never pass is a control that was found and never pressed.
  let settled = pagination !== undefined;
  if (!rule) {
    const probe = await paginateProbe(page, list.rows);
    steps.push({ tool: 'paginate_probe', input: { rows: list.rows }, result: probe.note });
    rule = probe.worked ? probe.pagination : { type: 'none' };
    settled = probe.worked;
  }

  const scenario = buildScenario({ name: options.name, url: options.url, rows: list.rows, fields: list.fields, pagination: rule });
  // A walk into rows joins the robot only if it was actually walked — the same rule as pagination.
  if (detail && list.fields[detail.follow]) scenario.detail = detail;
  const proof = await runScenario(page, { ...scenario, pagination: { type: 'none' } }, { rules: options.rules });
  const verdict = judge({
    rows: proof.rows,
    fields: scenario.list.fields,
    blocksSeen: proof.evidence?.blocksSeen ?? proof.rows.length,
    paginationProven: settled,
    wanted: Object.keys(scenario.list.fields),
  });

  steps.push({
    tool: 'finish',
    input: { rows: scenario.list.rows, fields: Object.keys(scenario.list.fields), pagination: scenario.pagination.type },
    result: verdict.good
      ? `accepted — ${proof.rows.length} rows, every column filled`
      : `rejected — ${verdict.complaints.join('; ')}`,
  });

  if (proof.status !== 'ok') {
    return { forModel: JSON.stringify({ accepted: false, ran: proof.status, reason: proof.reason }) };
  }
  return {
    forModel: JSON.stringify({ accepted: verdict.good, rows: proof.rows.length, coverage: verdict.coverage, complaints: verdict.complaints }),
    finished: { scenario, verdict, rows: proof.rows },
  };
}

interface ToolOutcome {
  forModel: string;
  finished?: { scenario: Scenario; verdict: QualityVerdict; rows: Array<Record<string, string | null>> };
}

interface Progress {
  step: number;
  maxSteps: number;
  seen: Set<string>;
  pagination?: PaginationRule;
  /** The list being worked on, so a walk into a row can find a row to walk into. */
  list?: ListRule;
  /** Proven by opening a row, never merely asserted — the same rule as pagination. */
  detail?: DetailRule;
}

async function runTool(
  page: PageDriver,
  name: string,
  args: Record<string, unknown>,
  options: AgentOptions & { rules: SiteRule[] },
  steps: AgentStep[],
  progress: Progress,
): Promise<ToolOutcome> {
  try {
    if (name === 'open_page') {
      await page.goto(String(args['url']));
      await page.waitMs(2500);
      await applyRules(page, options.rules);
      const sketch = await look(page);
      steps.push({ tool: 'open_page', input: args, result: `${sketch.title} — ${sketch.candidates.length} block(s)` });
      return { forModel: JSON.stringify(sketch) };
    }

    if (name === 'look') {
      const sketch = await look(page);
      steps.push({ tool: 'look', input: {}, result: `${sketch.candidates.length} repeating block(s)` });
      return { forModel: JSON.stringify(sketch) };
    }

    if (name === 'try_selector') {
      const list = { rows: String(args['rows']), fields: args['fields'] as Record<string, FieldRule> };
      const fingerprint = JSON.stringify(list);
      const repeated = progress.seen.has(fingerprint);
      progress.seen.add(fingerprint);

      progress.list = list;
      const attempt = await tryFields(page, list);
      const verdict = judge({ rows: attempt.sample, fields: list.fields, blocksSeen: attempt.blocksSeen });
      steps.push({
        tool: 'try',
        input: list,
        result: `${list.rows} → ${attempt.rows} rows of ${attempt.blocksSeen} blocks${attempt.warnings.length ? `; ${attempt.warnings.length} warning(s)` : ''}`,
      });
      // Without this the model keeps polishing a result that was already good enough, or repeats an
      // attempt it has already made. Both are the same failure: nobody told it where it stands.
      if (verdict.good && attempt.rows > 0) {
        return close(page, list, options, steps, progress.pagination, progress.detail);
      }

      const advice = repeated
        ? 'You already tried exactly this and got the same answer. Change something or call finish.'
        : verdict.good
          ? 'This passes the gate. Call finish now with these exact rows and fields.'
          : `Not good enough yet: ${verdict.complaints.join('; ')}`;

      return {
        forModel: JSON.stringify({
          rows: attempt.rows,
          blocksSeen: attempt.blocksSeen,
          warnings: attempt.warnings,
          coverage: verdict.coverage,
          sample: attempt.sample.slice(0, 2),
          step: `${progress.step + 1} of ${progress.maxSteps}`,
          nextStep: advice,
        }),
      };
    }

    /**
     * A list rarely carries everything. This opens one row for real and reads what is inside it, so a
     * deeper walk is proven the same way pagination is — by doing it once, not by claiming it.
     */
    if (name === 'try_detail') {
      const follow = String(args['follow'] ?? 'link');
      const fields = args['fields'] as Record<string, FieldRule>;
      if (!progress.list) return { forModel: 'try a row selector first — there is no list to walk into yet.' };
      if (!fields || Object.keys(fields).length === 0) return { forModel: 'name at least one field to look for inside a row.' };

      const listUrl = await page.currentUrl();
      const attempt = await tryFields(page, progress.list);
      const where = attempt.sample.find((row) => typeof row[follow] === 'string' && /^https?:\/\//.test(row[follow]!))?.[follow];
      if (!where) {
        steps.push({ tool: 'try_detail', input: args, result: `no row carries an address in "${follow}"` });
        return {
          forModel: JSON.stringify({
            error: `the column "${follow}" holds no address to open. Collect the row's link first, as an attr field with absolute: true.`,
          }),
        };
      }

      await page.goto(where);
      await page.waitMs(600);
      const raw = await page.evaluate<unknown>(EXTRACTOR_SOURCE, { rows: 'html', fields });
      const found = asExtractResult(raw, where).rows[0] ?? {};
      await page.goto(listUrl); // put the page back where the list was
      await page.waitMs(600);

      const filled = Object.keys(fields).filter((field) => found[field]);
      const empty = Object.keys(fields).filter((field) => !found[field]);
      if (filled.length > 0) progress.detail = { follow, fields, maxRows: Math.min(Number(args['maxRows'] ?? 40) || 40, 200) };

      steps.push({
        tool: 'try_detail',
        input: args,
        result: `${where} → ${filled.length} of ${Object.keys(fields).length} field(s) filled`,
      });
      return {
        forModel: JSON.stringify({
          opened: where,
          found,
          empty,
          nextStep: filled.length
            ? 'This walk is proven and will be part of the robot. Call finish with the list as before.'
            : 'Nothing was found on the row page. Look at it with open_page and try selectors that exist there.',
        }),
      };
    }

    if (name === 'paginate_probe') {
      const probe = await paginateProbe(page, String(args['rows']));
      progress.pagination = probe.worked ? probe.pagination : { type: 'none' };
      steps.push({ tool: 'paginate_probe', input: args, result: probe.note });
      return { forModel: JSON.stringify(probe) };
    }

    if (name === 'finish') {
      const list = { rows: String(args['rows']), fields: args['fields'] as Record<string, FieldRule> };
      // args.pagination is deliberately ignored: only progress.pagination, set by an actual probe, is trusted.
      progress.list = list;
      return close(page, list, options, steps, progress.pagination, progress.detail);
    }

    return { forModel: `no such tool: ${name}` };
  } catch (error) {
    const message = error instanceof Error ? error.message.split('\n')[0]! : String(error);
    steps.push({ tool: name, input: args, result: `error: ${message}` });
    return { forModel: JSON.stringify({ error: message }) };
  }
}

// --- the model call itself: plain HTTP, no SDK ------------------------------------------------

interface ToolCall { id: string; function: { name: string; arguments: string } }
interface Message {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

const FIELD_SCHEMA = {
  type: 'object',
  additionalProperties: {
    type: 'object',
    properties: {
      type: { type: 'string', enum: ['text', 'attr', 'html'] },
      selector: { type: 'string', description: 'CSS selector inside the row block; omit to read the block itself' },
      attr: { type: 'string', description: 'attribute name, required when type is attr' },
      absolute: { type: 'boolean', description: 'resolve a URL attribute against the page' },
      optional: { type: 'boolean' },
    },
    required: ['type'],
  },
} as const;

const TOOLS = [
  { type: 'function', function: { name: 'look', description: 'The current page as structure.', parameters: { type: 'object', properties: {} } } },
  {
    type: 'function',
    function: {
      name: 'open_page',
      description: 'Go to a different URL — use it when this page is not the real list.',
      parameters: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'try_selector',
      description: 'Run a candidate row selector and field map, and see what really comes back.',
      parameters: { type: 'object', properties: { rows: { type: 'string' }, fields: FIELD_SCHEMA }, required: ['rows', 'fields'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'try_detail',
      description:
        'Open one row for real and read what is inside it. Use this when the person asked for something the list does not carry — pay, contacts, the full text. Proven by opening, like pagination.',
      parameters: {
        type: 'object',
        properties: {
          follow: { type: 'string', description: 'the column holding the row address, usually "link"' },
          fields: FIELD_SCHEMA,
          maxRows: { type: 'number', description: 'how many rows to open when it runs later; every one is a page load' },
        },
        required: ['follow', 'fields'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'paginate_probe',
      description: 'Find the next-page control and press it. Returns a rule that was actually used.',
      parameters: { type: 'object', properties: { rows: { type: 'string' } }, required: ['rows'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'finish',
      description: 'Run the scenario and submit it. It is accepted only if it passes the quality gate.',
      parameters: {
        type: 'object',
        properties: {
          rows: { type: 'string' },
          fields: FIELD_SCHEMA,
          pagination: {
            type: 'object',
            properties: {
              type: { type: 'string', enum: ['none', 'link', 'button', 'scroll'] },
              next: { type: 'string' },
              maxPages: { type: 'number' },
              maxRounds: { type: 'number' },
              settleMs: { type: 'number' },
            },
            required: ['type'],
          },
          url: { type: 'string', description: 'the URL the robot should start from, if not the one opened' },
        },
        required: ['rows', 'fields'],
      },
    },
  },
];

async function chat(
  messages: Message[],
  options: AgentOptions,
  usage: { promptTokens: number; completionTokens: number; calls: number },
): Promise<{ content?: string; tool_calls?: ToolCall[] } | undefined> {
  const candidates = [options.model ?? DEFAULT_MODEL, ...FALLBACKS];
  let last = '';
  for (const model of candidates) {
    try {
      return await callModel(messages, { ...options, model }, usage);
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
      if (!/\b(429|5\d\d)\b/.test(last)) throw error;
    }
  }
  throw new Error(last);
}

async function callModel(
  messages: Message[],
  options: AgentOptions,
  usage: { promptTokens: number; completionTokens: number; calls: number },
): Promise<{ content?: string; tool_calls?: ToolCall[] } | undefined> {
  const response = await fetch(`${options.baseUrl ?? DEFAULT_BASE}/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${options.apiKey}`,
      'x-title': 'ratatosk',
    },
    body: JSON.stringify({
      model: options.model ?? DEFAULT_MODEL,
      messages,
      tools: TOOLS,
      tool_choice: 'auto',
      temperature: 0.2,
    }),
  });

  if (!response.ok) {
    throw new Error(`the model refused: ${response.status} ${(await response.text()).slice(0, 200)}`);
  }

  const data = (await response.json()) as {
    choices?: Array<{ message: { content?: string; tool_calls?: ToolCall[] } }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };

  usage.calls++;
  usage.promptTokens += data.usage?.prompt_tokens ?? 0;
  usage.completionTokens += data.usage?.completion_tokens ?? 0;
  return data.choices?.[0]?.message;
}

function safeParse(text: string): Record<string, unknown> {
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return {};
  }
}
