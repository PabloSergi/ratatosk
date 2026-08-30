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
 * A robot's kind is a real difference — a page walk and a Telegram read fail differently and are fixed
 * differently — so it is shown, and the list can be narrowed to one kind at a time.
 */
export function kindTabs(kinds: Array<{ kind: string; count: number }>, active: string): string {
  const all = kinds.reduce((sum, entry) => sum + entry.count, 0);
  const tab = (kind: string, label: string, count: number) =>
    `<button class="tab${kind === active ? ' on' : ''}" data-kind="${escapeHtml(kind)}">` +
    `${escapeHtml(label)} <span>${count}</span></button>`;

  return [tab('all', 'all', all), ...kinds.map((entry) => tab(entry.kind, entry.kind, entry.count))].join('');
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
}): string {
  const seen = proxy.exitIp
    ? `exit ${escapeHtml(proxy.exitIp)}${proxy.checkedAt ? ` · ${new Date(proxy.checkedAt).toLocaleTimeString()}` : ''}`
    : 'never checked';

  return `
    <div class="robot">
      <div>
        <b>${escapeHtml(proxy.label)}</b> <span class="kind">${escapeHtml(proxy.scheme)}</span>
        <div class="meta">${escapeHtml(proxy.host)}${proxy.user ? ` · ${escapeHtml(proxy.user)}` : ''}</div>
        <div class="meta">${seen}</div>
      </div>
      <div class="row">
        <button data-proxy-check="${escapeHtml(proxy.id)}">Check</button>
        <button data-proxy-remove="${escapeHtml(proxy.id)}">Remove</button>
      </div>
    </div>`;
}

export function robotCard(
  robot: {
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
): string {
  // How it is now, next to what it is. A card that only says what a robot was built to do cannot tell
  // you the one thing you came to find out.
  const how = standing
    ? `<div class="meta">${badge(standing.status)} ${standing.rows} rows · ` +
      `${escapeHtml(new Date(standing.at).toLocaleString())}` +
      `${standing.inARow > 1 ? ` · ${standing.inARow} runs in a row` : ''}` +
      `${standing.why ? `<br><span class="${standing.status === 'ok' ? 'muted' : 'broken'}">${escapeHtml(standing.why)}</span>` : ''}</div>`
    : '<div class="meta muted">never run here</div>';

  return `
    <div class="robot">
      <div>
        <b>${escapeHtml(robot.name)}</b>${robot.kind ? ` <span class="kind">${escapeHtml(robot.kind)}</span>` : ''}
        <div class="meta">${escapeHtml(robot.url)}</div>
        ${how}
        <div class="meta">${robot.fields.map(escapeHtml).join(' · ')}${
          // Columns from inside a row are marked, because they are not free: one page load each.
          robot.deeper?.length ? ` · ${robot.deeper.map((field) => `${escapeHtml(field)} ↓`).join(' · ')}` : ''
        } — ${escapeHtml(robot.pagination)}${robot.proxy ? ` · <span class="via">via proxy</span>` : ''}</div>
      </div>
      <div class="row">
        <button data-run="${escapeHtml(robot.name)}">Run</button>
        <button data-repair="${escapeHtml(robot.name)}">Repair</button>
        <button data-rule="${escapeHtml(robot.name)}" title="what this robot keeps and what it throws away">Rule${
          robot.sift ? ` <span class="kind">${robot.sift}</span>` : ''
        }</button>
        <button data-delete="${escapeHtml(robot.name)}" title="delete this robot and what its profile remembers about the site">Delete</button>
      </div>
    </div>`;
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
  const check = connection.lastCheck;
  const state = check
    ? `<dt>state</dt><dd class="${check.ok ? '' : 'broken'}">${escapeHtml(check.note)} · ${new Date(check.at).toLocaleTimeString()}</dd>`
    : '<dt>state</dt><dd class="muted">press “Check” — it asks the provider and pings the model</dd>';

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
        ${state}
      </dl>
      <div class="card-foot">
        <label class="meta">builds with</label>
        <select data-connection-model="${escapeHtml(connection.id)}">
          <option value="${escapeHtml(connection.model)}">${escapeHtml(connection.model)}</option>
        </select>
        <button data-check-connection="${escapeHtml(connection.id)}">Check</button>
        <span class="meta" data-connection-note="${escapeHtml(connection.id)}">the list loads when you open it</span>
      </div>
    </div>`;
}

/**
 * A Telegram account card. Same shape as a connection card on purpose: a checked account has to show
 * what the check found — being signed in, how many chats are visible, and whether the channels the
 * robots depend on can still be read.
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
  const check = account.lastCheck;
  const facts = [
    account.phone ? `<dt>phone</dt><dd>${escapeHtml(account.phone)}</dd>` : '',
    account.connectedAt
      ? `<dt>connected</dt><dd>${escapeHtml(new Date(account.connectedAt).toLocaleString())}</dd>`
      : '',
    account.apiId ? `<dt>api_id</dt><dd>${account.apiId}</dd>` : '',
    check
      ? `<dt>state</dt><dd class="${check.ok ? '' : 'broken'}">${escapeHtml(check.note)} · ${new Date(check.at).toLocaleTimeString()}</dd>`
      : '<dt>state</dt><dd class="muted">press “Check connection” — it uses the session for real</dd>',
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
        <button data-tg-forget="${escapeHtml(account.id)}">Disconnect</button>
      </div>
      <dl class="facts">${facts}</dl>
      <div class="card-row"><button data-tg-check="${escapeHtml(account.id)}">Check connection</button></div>
    </div>`;
}


/** A robot's story, newest first: what each run returned and why it stopped there. */
export function runsList(runs: Array<{ at: string; robot: string; kind: string; status: 'ok' | 'empty' | 'broken'; rows: number; pages?: number; ms: number; why?: string; door?: boolean }>): string {
  if (!runs.length) return '<div class="meta muted">nothing has run yet</div>';

  const rows = runs
    .map(
      (run) => `
        <tr>
          <td class="mono">${escapeHtml(new Date(run.at).toLocaleString())}</td>
          <td><b>${escapeHtml(run.robot)}</b> <span class="kind">${escapeHtml(run.kind)}</span></td>
          <td>${badge(run.status)}</td>
          <td class="mono">${run.rows}${run.pages ? ` / ${run.pages}p` : ''}</td>
          <td class="mono">${Math.round(run.ms / 100) / 10}s</td>
          <td class="${run.status === 'ok' ? 'muted' : 'broken'}">${escapeHtml(run.why ?? '')}${run.door ? ' · a door meant for a person' : ''}</td>
        </tr>`,
    )
    .join('');

  return `<table><thead><tr><th>when</th><th>robot</th><th></th><th>rows</th><th>took</th><th>why</th></tr></thead><tbody>${rows}</tbody></table>`;
}


/** The machine credentials an account has handed out, and what each one was for. */
export function keysList(keys: Array<{ id: string; label: string; hint: string; createdAt: string; lastUsedAt?: string }>): string {
  if (!keys.length) return '<div class="meta muted">no keys yet — a schedule cannot reach this account</div>';

  return keys
    .map(
      (key) => `
      <div class="robot">
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
): string {
  const rule = sift ?? { keep: [], drop: [] };
  return `
    <div class="meta">
      A rule decides what this robot returns. <b>Keeps</b> are matched first — a row stays if any of them
      hits. <b>Drops</b> are checked after, and a drop always wins. Rows nothing claims are the edge:
      with a second opinion switched on, a model looks at those on every run.
    </div>
    <div class="row spaced">
      <input type="text" id="ruleWant" placeholder="what this robot should keep, in your own words" value="${escapeHtml(rule.want ?? '')}">
      <label class="meta"><input type="checkbox" id="ruleJudge" ${rule.judge ? 'checked' : ''}> ask a model about the edge</label>
      <label class="meta" title="the same posting reposted every ten minutes is not news; a run hands back only what it has not seen">
        <input type="checkbox" id="ruleRemember" ${remembering ? 'checked' : ''}> only what I have not seen before
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
