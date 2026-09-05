import type { AgentStep } from '../src/agent.js';
import type { QualityVerdict } from '../src/quality.js';
import type { RunStatus } from '../src/run.js';

/**
 * Turning results into markup. Everything here is a pure function of typed data, which is what makes
 * it testable without a browser — see test/web-render.test.mjs.
 */
export type Row = Record<string, string | null>;

export function escapeHtml(value: unknown): string {
  return String(value).replace(/[&<>"]/g, (character) => {
    const map: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' };
    return map[character]!;
  });
}

export function badge(status: RunStatus | 'weak'): string {
  return `<span class="badge ${status}">${status}</span>`;
}

/** Rows come from a page, so every value is treated as text — links become links, nothing else does. */
export function rowsTable(rows: Row[] | undefined, limit = 50): string {
  if (!rows?.length) return '';
  const columns = Object.keys(rows[0]!);

  const head = columns.map((column) => `<th>${escapeHtml(column)}</th>`).join('');
  const body = rows
    .slice(0, limit)
    .map((row) => {
      const cells = columns.map((column) => {
        const value = row[column];
        if (value === null || value === undefined || value === '') return '<td class="muted">—</td>';
        return /^https?:\/\//.test(value)
          ? `<td><a href="${escapeHtml(value)}" target="_blank" rel="noreferrer">${escapeHtml(value.slice(0, 70))}</a></td>`
          : `<td>${escapeHtml(value)}</td>`;
      });
      return `<tr>${cells.join('')}</tr>`;
    })
    .join('');

  const more = rows.length > limit ? `<div class="meta spaced">… and ${rows.length - limit} more</div>` : '';
  return `<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>${more}`;
}

/**
 * Rows as a CSV file.
 *
 * A run that ends on the screen is a run whose result cannot be used: two hundred rows in a table are
 * something to look at, not something to work with. This is the way out for a person — the way out for
 * a machine is the API, which hands back the same rows as JSON and needs no button.
 *
 * Everything is quoted, because a scraped value contains whatever the site had in it: commas, quotes,
 * and newlines all arrive eventually, and a file that breaks on the first comma is worse than no file.
 */
export function toCsv(rows: Row[]): string {
  if (!rows.length) return '';
  const columns = [...new Set(rows.flatMap((row) => Object.keys(row)))];
  const cell = (value: string | null | undefined): string => `"${String(value ?? '').replace(/"/g, '""')}"`;

  const head = columns.map(cell).join(',');
  const body = rows.map((row) => columns.map((column) => cell(row[column])).join(',')).join('\r\n');
  return `${head}\r\n${body}\r\n`;
}

/** What a person does with a result once it is on the screen. */
export function downloadBar(name: string, rows: number): string {
  if (!rows) return '';
  return (
    `<div class="row spaced"><span class="meta">${rows} row(s)</span>` +
    `<button data-download-csv="${escapeHtml(name)}">Download CSV</button>` +
    `<button data-download-json="${escapeHtml(name)}">Download JSON</button>` +
    `<span class="meta" id="handedOver"></span></div>`
  );
}

export function stepsList(steps: AgentStep[]): string {
  const lines = steps
    .map((step) => `<div class="step"><b>${escapeHtml(step.tool)}</b><span>${escapeHtml(step.result)}</span></div>`)
    .join('');
  return `<div class="steps">${lines}</div>`;
}

/** Coverage as bars: green where a column is filled everywhere, red where it is not filled at all. */
export function verdictBars(verdict: QualityVerdict | undefined): string {
  if (!verdict) return '';

  const bars = Object.entries(verdict.coverage)
    .map(([name, share]) => {
      const percent = Math.round(share * 100);
      const colour = share >= 0.8 ? 'var(--ok)' : share > 0 ? 'var(--empty)' : 'var(--broken)';
      return (
        `<div class="bar"><span>${escapeHtml(name)}</span>` +
        `<span class="track"><i style="width:${percent}%;background:${colour}"></i></span>` +
        `<span class="meta">${percent}% of rows</span></div>`
      );
    })
    .join('');

  const complaints = verdict.complaints.length
    ? `<pre>${verdict.complaints.map(escapeHtml).join('\n')}</pre>`
    : '';
  return `<div class="bars">${bars}</div>${complaints}`;
}

/**
 * A scraper's kind is a real difference — a page walk and a Telegram read fail differently and are fixed
 * differently — so it is shown, and the list can be narrowed to one kind at a time.
 */
export function kindTabs(kinds: Array<{ kind: string; count: number }>, active: string): string {
  const all = kinds.reduce((sum, entry) => sum + entry.count, 0);
  const tab = (kind: string, label: string, count: number) =>
    `<button class="tab${kind === active ? ' on' : ''}" data-kind="${escapeHtml(kind)}">` +
    `${escapeHtml(label)} <span>${count}</span></button>`;

  return [tab('all', 'all', all), ...kinds.map((entry) => tab(entry.kind, entry.kind, entry.count))].join('');
}


/**
 * The same two things on every card: a way to ask "are you still working?", and the answer underneath.
 *
 * A connection, a proxy, a Telegram account and a scraper fail in completely different ways, but the
 * question a person has about them is identical — so the control is identical too, and it is an icon
 * rather than a word because a card is a row of verbs and only one of them is a question.
 */
export function checkIcon(attribute: string, id: string, title: string): string {
  return (
    `<button class="icon" ${attribute}="${escapeHtml(id)}" title="${escapeHtml(title)}" ` +
    `aria-label="${escapeHtml(title)}">&#10227;</button>`
  );
}

/** How a thing is, in its own line at the bottom of its card. Green when it answered, red when it did not. */
export function stateLine(
  check: { at: string; ok: boolean; note: string } | undefined,
  never = 'never checked',
): string {
  if (!check) return `<div class="state muted">${escapeHtml(never)}</div>`;
  const when = new Date(check.at).toLocaleTimeString();
  return `<div class="state ${check.ok ? 'ok' : 'bad'}">${escapeHtml(check.note)} <span class="meta">${escapeHtml(when)}</span></div>`;
}

/** A proxy is only as good as the address it actually gives you, so that is what the card shows. */
export function proxyCard(proxy: {
  id: string;
  label: string;
  scheme: string;
  host: string;
  user?: string;
  exitIp?: string;
  checkedAt?: string;
  latencyMs?: number;
}): string {
  const state = proxy.exitIp
    ? {
        at: proxy.checkedAt ?? new Date().toISOString(),
        ok: true,
        note: `comes out as ${proxy.exitIp}${proxy.latencyMs ? ` in ${proxy.latencyMs} ms` : ''}`,
      }
    : undefined;

  return `
    <div class="item">
      <div class="item-main">
        <b>${escapeHtml(proxy.label)}</b> <span class="kind">${escapeHtml(proxy.scheme)}</span>
        <div class="meta">${escapeHtml(proxy.host)}${proxy.user ? ` \u00b7 ${escapeHtml(proxy.user)}` : ''}</div>
        ${stateLine(state, 'never checked — press the arrow to send a request through it')}
      </div>
      <div class="row">
        ${checkIcon('data-proxy-check', proxy.id, 'check it now: go out through this address and report what the world sees')}
        <button data-proxy-remove="${escapeHtml(proxy.id)}">Remove</button>
      </div>
    </div>`;
}

export function scraperCard(
  scraper: {
    name: string;
    kind?: string;
    url: string;
    fields: string[];
    deeper?: string[];
    pagination: string;
    proxy?: string;
    /** How many patterns its rule carries, if it has one. */
    sift?: number;
  },
  standing?: { status: 'ok' | 'empty' | 'broken'; at: string; rows: number; inARow: number; why?: string },
  /** A probe done just now, which is newer than any run and therefore what the card should say. */
  check?: { at: string; ok: boolean; note: string },
): string {
  // How it is now, under what it is. A card that only says what a scraper was built to do cannot tell
  // you the one thing you came to find out.
  const how = check
    ? stateLine(check)
    : standing
      ? `<div class="state ${standing.status === 'ok' ? 'ok' : 'bad'}">${badge(standing.status)} ${standing.rows} rows ` +
        `<span class="meta">${escapeHtml(new Date(standing.at).toLocaleString())}` +
        `${standing.inARow > 1 ? ` \u00b7 ${standing.inARow} runs in a row` : ''}</span>` +
        `${standing.why ? `<br><span class="${standing.status === 'ok' ? 'meta' : 'broken'}">${escapeHtml(standing.why)}</span>` : ''}</div>`
      : stateLine(undefined, 'never run here — press the arrow to see whether the page still answers');

  return `
    <div class="item">
      <div class="item-main">
        <button class="rename" data-scraper-rename="${escapeHtml(scraper.name)}"
                title="rename it — the memory of what it has handed over and its whole history come along">${escapeHtml(scraper.name)}</button>${
          scraper.kind ? ` <span class="kind">${escapeHtml(scraper.kind)}</span>` : ''
        }
        <div class="meta">${escapeHtml(scraper.url)}</div>
        <div class="meta">${scraper.fields.map(escapeHtml).join(' \u00b7 ')}${
          // Columns from inside a row are marked, because they are not free: one page load each.
          scraper.deeper?.length ? ` \u00b7 ${scraper.deeper.map((field) => `${escapeHtml(field)} \u2193`).join(' \u00b7 ')}` : ''
        } \u2014 ${escapeHtml(scraper.pagination)}${scraper.proxy ? ` \u00b7 <span class="via">via proxy</span>` : ''}</div>
        <button class="opener" data-scraper-history="${escapeHtml(scraper.name)}"
                aria-label="the story of ${escapeHtml(scraper.name)}"
                title="every run this scraper has had: what came back and why it stopped there">${how}</button>
        <div class="history" data-history-for="${escapeHtml(scraper.name)}" hidden></div>
      </div>
      <div class="row">
        ${checkIcon('data-scraper-check', scraper.name, 'check it now: one page, no model, nothing remembered')}
        <button data-run="${escapeHtml(scraper.name)}">Run</button>
        <button data-repair="${escapeHtml(scraper.name)}">Repair</button>
        <button data-rule="${escapeHtml(scraper.name)}" title="what this scraper keeps and what it throws away">Rule${
          scraper.sift ? ` <span class="kind">${scraper.sift}</span>` : ''
        }</button>
        <button data-delete="${escapeHtml(scraper.name)}" title="delete this scraper and what its profile remembers about the site">Delete</button>
      </div>
    </div>`;
}

/**
 * What has been deleted lately, and the way back.
 *
 * Shown only when there is something to show: a permanent "nothing deleted" heading is furniture. A
 * deletion is not undone by remembering to keep the file — it is undone by being able to reach it.
 */
export function deletedList(deleted: Array<{ file: string; name: string; kind: string; at: string }>): string {
  if (!deleted.length) return '';

  const rows = deleted
    .map(
      (one) =>
        `<div class="item"><div class="item-main"><b>${escapeHtml(one.name)}</b> ` +
        `<span class="kind">${escapeHtml(one.kind)}</span>` +
        `<div class="meta">deleted ${escapeHtml(new Date(one.at).toLocaleString())}</div></div>` +
        `<div class="row"><button data-restore="${escapeHtml(one.file)}">Restore</button></div></div>`,
    )
    .join('');

  return `<h2 class="spaced">Deleted</h2><p class="meta">Brought back under its own name, without the
    memory of what it had already handed over — after a fortnight away, what is there now is news.</p>${rows}`;
}

/**
 * A connection card answers the three questions people actually have: which key is this, what does it
 * build with, and is there anything left on it. The model is changed here rather than by making a
 * second connection — the key stays, the model is just a choice.
 */
export function connectionCard(connection: {
  id: string;
  label: string;
  baseUrl: string;
  model: string;
  keyHint: string;
  active: boolean;
  runs?: boolean;
  lastCheck?: { at: string; ok: boolean; note: string };
}): string {
  return `
    <div class="card">
      <div class="card-head">
        <span class="badge ${connection.active ? 'ok' : connection.runs ? 'empty' : 'empty'}">${
          connection.active ? (connection.runs ? 'builds · runs' : 'builds') : connection.runs ? 'runs' : 'idle'
        }</span>
        <b class="mono">${escapeHtml(connection.label)}</b>
        <span class="meta">${escapeHtml(connection.keyHint)}</span>
        ${connection.active ? '' : `<button data-use="${escapeHtml(connection.id)}">Build with this</button>`}
        ${connection.runs ? '' : `<button data-runs="${escapeHtml(connection.id)}" title="the cheap one: the second opinion on borderline rows, on every run">Run with this</button>`}
        <button data-remove-connection="${escapeHtml(connection.id)}">Remove</button>
      </div>
      <dl class="facts">
        <dt>where</dt><dd>${escapeHtml(connection.baseUrl)}</dd>
      </dl>
      <div class="card-foot">
        <label class="meta">builds with</label>
        <select data-connection-model="${escapeHtml(connection.id)}">
          <option value="${escapeHtml(connection.model)}">${escapeHtml(connection.model)}</option>
        </select>
        ${checkIcon('data-check-connection', connection.id, 'check it now: ask the provider what is left, and ping the model')}
        <span class="meta" data-connection-note="${escapeHtml(connection.id)}">the list loads when you open it</span>
      </div>
      ${stateLine(connection.lastCheck, 'never checked \u2014 press the arrow to ask the provider')}
    </div>`;
}

/**
 * A Telegram account card. Same shape as a connection card on purpose: a checked account has to show
 * what the check found — being signed in, how many chats are visible, and whether the channels the
 * scrapers depend on can still be read.
 */
export function accountCard(account: {
  id: string;
  account?: string;
  phone?: string;
  connectedAt?: string;
  apiId?: number;
  alive?: boolean;
  dialogs?: number;
  access?: Array<{ channel: string; ok: boolean; note: string }>;
  lastCheck?: { at: string; ok: boolean; note: string };
}): string {
  const facts = [
    account.phone ? `<dt>phone</dt><dd>${escapeHtml(account.phone)}</dd>` : '',
    account.connectedAt
      ? `<dt>connected</dt><dd>${escapeHtml(new Date(account.connectedAt).toLocaleString())}</dd>`
      : '',
    account.apiId ? `<dt>api_id</dt><dd>${account.apiId}</dd>` : '',
    account.dialogs !== undefined ? `<dt>chats visible</dt><dd>${account.dialogs}</dd>` : '',
    ...(account.access ?? []).map(
      (entry) =>
        `<dt>${escapeHtml(entry.channel)}</dt><dd class="${entry.ok ? '' : 'broken'}">${escapeHtml(entry.note)}</dd>`,
    ),
  ].join('');

  return `
    <div class="card">
      <div class="card-head">
        <span class="badge ${account.alive === false ? 'broken' : 'ok'}">account</span>
        <b class="mono">${escapeHtml(account.account ?? 'connected')}</b>
        ${checkIcon('data-tg-check', account.id, 'check it now: use the session and see which channels still answer')}
        <button data-tg-forget="${escapeHtml(account.id)}">Disconnect</button>
      </div>
      <dl class="facts">${facts}</dl>
      ${stateLine(account.lastCheck, 'never checked \u2014 press the arrow to use the session for real')}
    </div>`;
}


/**
 * One scraper's own story, under its card.
 *
 * A run list belonged in a tab of its own for about a week, until the obvious question — "and how has
 * THIS one been doing?" — turned out to be the only one anybody asked of it. So it lives where the
 * question is asked, and says nothing the card already says: no name in every line, no kind.
 */
export function scraperHistory(
  runs: Array<{ at: string; kind: string; status: 'ok' | 'empty' | 'broken'; rows: number; pages?: number; ms: number; why?: string }>,
  scraper = '',
  kept: string[] = [],
): string {
  if (!runs.length) return '<div class="meta muted">nothing yet — press Run, or the arrow for a quick look</div>';

  const has = new Set(kept);
  return `<table class="runs">${runs
    .map(
      (run) => `
        <tr>
          <td class="mono">${escapeHtml(new Date(run.at).toLocaleString())}</td>
          <td>${badge(run.status)}${run.kind === 'run' ? '' : ` <span class="kind">${escapeHtml(run.kind)}</span>`}</td>
          <td class="mono">${
            // A run whose rows are still here is a run you can open. One whose rows have aged out says
            // how many there were and nothing more, rather than offering a button that apologises.
            has.has(run.at)
              ? `<button class="inline" data-open-result="${escapeHtml(scraper)}" data-at="${escapeHtml(run.at)}">${run.rows} rows</button>`
              : `${run.rows} rows`
          }${run.pages ? ` · ${run.pages}p` : ''}</td>
          <td class="mono">${Math.round(run.ms / 100) / 10}s</td>
          <td class="meta">${run.why ? escapeHtml(run.why) : ''}</td>
        </tr>`,
    )
    .join('')}</table>`;
}

export function keysList(keys: Array<{ id: string; label: string; hint: string; createdAt: string; lastUsedAt?: string }>): string {
  if (!keys.length) return '<div class="meta muted">no keys yet — a schedule cannot reach this account</div>';

  return keys
    .map(
      (key) => `
      <div class="scraper">
        <div>
          <b>${escapeHtml(key.label)}</b> <span class="kind mono">${escapeHtml(key.hint)}</span>
          <div class="meta">made ${escapeHtml(new Date(key.createdAt).toLocaleString())}${
            key.lastUsedAt ? ` · last used ${escapeHtml(new Date(key.lastUsedAt).toLocaleString())}` : ' · never used'
          }</div>
        </div>
        <div class="row"><button data-key-revoke="${escapeHtml(key.id)}">Revoke</button></div>
      </div>`,
    )
    .join('');
}


/**
 * The rule, laid out so a person can read it, change one line of it, and see what that did. Patterns
 * are one per line: the smallest editor that is honest about what is stored.
 */
export function ruleEditor(
  name: string,
  sift: { want?: string; keep: string[]; drop?: string[]; judge?: unknown } | null,
  remembering = false,
  deduping = true,
): string {
  const rule = sift ?? { keep: [], drop: [] };
  return `
    <div class="meta">
      A rule decides what this scraper returns. <b>Keeps</b> are matched first — a row stays if any of them
      hits. <b>Drops</b> are checked after, and a drop always wins. Rows nothing claims are the edge:
      with a second opinion switched on, a model looks at those on every run.
    </div>
    <div class="row spaced">
      <input type="text" id="ruleWant" placeholder="what this scraper should keep, in your own words" value="${escapeHtml(rule.want ?? '')}">
      <label class="meta"><input type="checkbox" id="ruleJudge" ${rule.judge ? 'checked' : ''}> ask a model about the edge</label>
      <label class="meta" title="the same posting reposted every ten minutes is not news; a run hands back only what it has not seen">
        <input type="checkbox" id="ruleRemember" ${remembering ? 'checked' : ''}> only what I have not seen before
      </label>
      <label class="meta" title="a pager that shifts under you shows the same posting on two pages; turn this off only where identical rows are genuinely different things">
        <input type="checkbox" id="ruleDedupe" ${deduping ? 'checked' : ''}> drop rows repeated within a run
      </label>
    </div>
    <div class="row spaced">
      <div class="half">
        <label class="meta">keeps — one pattern per line</label>
        <textarea id="ruleKeep" rows="8">${escapeHtml((rule.keep ?? []).join('\n'))}</textarea>
      </div>
      <div class="half">
        <label class="meta">drops — one pattern per line</label>
        <textarea id="ruleDrop" rows="8">${escapeHtml((rule.drop ?? []).join('\n'))}</textarea>
      </div>
    </div>
    <div class="row spaced">
      <button data-rule-test="${escapeHtml(name)}">Try it on fresh material</button>
      <button data-rule-rebuild="${escapeHtml(name)}">Write it again with the model</button>
      <button class="primary" data-rule-save="${escapeHtml(name)}">Save</button>
    </div>
    <div id="ruleOut" class="meta spaced"></div>`;
}

/** What a rule did to real rows: the numbers, and enough of the material to judge them by. */
export function ruleVerdict(result: {
  sampled: number;
  kept: number;
  dropped: number;
  unclaimed: number;
  collisions: number;
  good: boolean;
  note: string;
  examples: { kept: string[]; dropped: string[]; collisions: string[] };
}): string {
  const lines = [
    `${badge(result.good ? 'ok' : 'weak')} ${escapeHtml(result.note)}`,
    `<div class="meta">of ${result.sampled} collected now: <b>${result.kept}</b> kept, ${result.dropped} dropped, ` +
      `${result.unclaimed} claimed by nothing${result.collisions ? `, <b>${result.collisions}</b> found by a keep and taken by a drop` : ''}</div>`,
    show('kept', result.examples.kept),
    show('dropped', result.examples.dropped),
    result.examples.collisions.length ? show('taken away although a keep found them', result.examples.collisions) : '',
  ];
  return lines.filter(Boolean).join('');
}

function show(title: string, rows: string[]): string {
  if (!rows.length) return '';
  return `<div class="meta spaced"><b>${escapeHtml(title)}</b><br>${rows.map((row) => `<span class="muted">${escapeHtml(row)}</span>`).join('<br>')}</div>`;
}
