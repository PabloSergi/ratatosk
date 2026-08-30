import {
  api,
  ApiError,
  currentToken,
  forgetToken,
  rememberToken,
  type Account,
  type ConnectionView,
  type Provider,
  type ProviderId,
  type RobotSummary,
  type SiftAttempt,
  type Sift,
  type TelegramAccount,
} from './api.js';
import {
  accountCard,
  badge,
  connectionCard,
  escapeHtml,
  kindTabs,
  proxyCard,
  robotCard,
  rowsTable,
  runsList,
  keysList,
  ruleEditor,
  ruleVerdict,
  stepsList,
  verdictBars,
} from './render.js';

/** Wiring: which element does what. Everything that produces markup lives in render.ts. */
const el = <T extends HTMLElement>(id: string): T => {
  const found = document.getElementById(id);
  if (!found) throw new Error(`the page is missing #${id}`);
  return found as T;
};

const value = (id: string): string =>
  el<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(id).value.trim();

const show = (id: string, visible: boolean): void => {
  el(id).hidden = !visible;
};

function busy(button: HTMLButtonElement, label: string): () => void {
  const original = button.textContent ?? '';
  button.disabled = true;
  button.innerHTML = `<span class="spin">◠</span> ${escapeHtml(label)}`;
  return () => {
    button.disabled = false;
    button.textContent = original;
  };
}

function result(title: string, html: string): void {
  el('resultTitle').textContent = title;
  el('result').innerHTML = html;
  el('resultBox').hidden = false;
  el('resultBox').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function fail(where: string, error: unknown): void {
  if (error instanceof ApiError && error.unauthorised) return; // the sign-in screen is already back
  el(where).innerHTML = `<span class="broken">${escapeHtml(error instanceof Error ? error.message : String(error))}</span>`;
}

// --- views --------------------------------------------------------------------------------------

/**
 * Four different things live here — robots, the models that build them, the addresses they go out
 * from, and Telegram accounts — and they are not steps of one flow. So they are places, switched from
 * the header, rather than one scroll where everything shouts at once.
 */
let view = localStorage.getItem('ratatosk.view') ?? 'robots';

function showView(next: string): void {
  view = next;
  localStorage.setItem('ratatosk.view', next);

  for (const section of document.querySelectorAll<HTMLElement>('section.app')) {
    const belongs = section.dataset['view'];
    if (belongs !== 'any') section.hidden = belongs !== next;
  }
  for (const tab of document.querySelectorAll<HTMLElement>('.view-tab')) {
    tab.classList.toggle('on', tab.dataset['view'] === next);
  }
  el('resultBox').hidden = true;
}

// --- account ------------------------------------------------------------------------------------

function signedOut(note?: string): void {
  forgetToken();
  for (const section of document.querySelectorAll<HTMLElement>('.app')) section.hidden = true;
  show('views', false);
  show('who', false);
  show('authBox', true);
  if (note) el('authNote').innerHTML = `<span class="broken">${escapeHtml(note)}</span>`;
}

function signedIn(user: Account): void {
  show('authBox', false);
  show('who', true);
  show('views', true);
  showView(view);

  el('who').innerHTML =
    `${escapeHtml(user.email)} · <a href="#" id="showToken">token for MCP</a> · <a href="#" id="signOut">sign out</a>`;

  el('signOut').addEventListener('click', (event) => {
    event.preventDefault();
    signedOut();
  });
  el('showToken').addEventListener('click', (event) => {
    event.preventDefault();
    result(
      'token for MCP',
      '<div class="meta">Put this in your MCP client config as RATATOSK_TOKEN. It is your account — treat it' +
        ` like a password, and sign out to end it.</div><pre>${escapeHtml(currentToken())}</pre>`,
    );
  });
}

async function enter(kind: 'login' | 'register'): Promise<void> {
  const email = value('authEmail');
  const password = el<HTMLInputElement>('authPassword').value;
  const answer = kind === 'login' ? await api.login(email, password) : await api.register(email, password);
  rememberToken(answer.token);
  el<HTMLInputElement>('authPassword').value = '';
  signedIn(answer.user);
  await loadEverything();
}

// --- robots -------------------------------------------------------------------------------------

let shownKind = 'all';

/** The robots as last listed. A card's buttons act on one of these, so they have to be to hand. */
let known: RobotSummary[] = [];

async function loadRobots(): Promise<void> {
  try {
    const { robots } = await api.robots();
    known = robots;

    const counts = new Map<string, number>();
    for (const robot of robots) counts.set(robot.kind, (counts.get(robot.kind) ?? 0) + 1);
    if (shownKind !== 'all' && !counts.has(shownKind)) shownKind = 'all';

    el('kinds').innerHTML =
      counts.size > 1 ? kindTabs([...counts].map(([kind, count]) => ({ kind, count })), shownKind) : '';

    // How each robot is doing, fetched beside the list: a card that cannot say that is half a card.
    const how = new Map((await api.history().catch(() => ({ standing: [] }))).standing.map((entry) => [entry.robot, entry]));

    const shown = shownKind === 'all' ? robots : robots.filter((robot) => robot.kind === shownKind);
    el('robots').innerHTML = shown.length
      ? shown.map((robot) => robotCard(robot, how.get(robot.name))).join('')
      : '<span class="muted">nothing of that kind yet</span>';
  } catch (error) {
    fail('robots', error);
  }
}

async function runRobot(name: string, button: HTMLButtonElement): Promise<void> {
  const done = busy(button, 'running');
  // The panel keeps the last answer until this one arrives, and a stale answer under a running button
  // reads as the new one. Say what is happening instead.
  result(name, '<span class="muted">running…</span>');
  try {
    const run = await api.run(name, 2);
    void loadRuns();
    result(
      name,
      `${badge(run.status)} <b>${run.rows.length} rows</b> from ${run.pagesVisited} page(s)` +
        (run.reason ? `<pre>${escapeHtml(run.reason)}</pre>` : '') +
        (run.challenge ? doorNote() : '') +
        (run.rulesApplied?.length
          ? `<div class="meta spaced">${run.rulesApplied.map(escapeHtml).join('<br>')}</div>`
          : '') +
        rowsTable(run.rows),
    );
  } catch (error) {
    result(name, `<span class="broken">${escapeHtml(error instanceof Error ? error.message : error)}</span>`);
  } finally {
    done();
  }
}

async function repairRobot(name: string, button: HTMLButtonElement): Promise<void> {
  const done = busy(button, 'repairing');
  result(name, '<span class="muted">repairing…</span>');
  try {
    const repair = await api.repair(name);

    // A robot has two halves that rot in different ways, and a repair may touch either or both.
    const selectors = repair.status
      ? repair.status === 'repaired'
        ? `${badge('ok')} selectors repaired — <b>${repair.after?.rows.length ?? 0} rows</b> where there were ${repair.before?.rows.length ?? 0}`
        : repair.status === 'not-needed'
          ? `${badge('ok')} the selectors still fit the page`
          : `${badge('broken')} selectors unfixable: ${escapeHtml(repair.reason ?? '')}`
      : '';

    const rule = repair.rule
      ? repair.rule.status === 'repaired'
        ? `${badge('ok')} the rule was written again — it kept ${repair.rule.before.kept} of ` +
          `${repair.rule.before.sampled}, now ${repair.rule.after?.kept}` +
          `<div class="meta">${escapeHtml(repair.rule.before.note)}</div>`
        : repair.rule.status === 'not-needed'
          ? `${badge('ok')} the rule still holds — ${escapeHtml(repair.rule.before.note)}`
          : `${badge('weak')} the rule needs looking at: ${escapeHtml(repair.rule.reason ?? '')}` +
            `<div class="meta">${escapeHtml(repair.rule.before.note)}</div>`
      : '';

    const diff = [...(repair.diff ?? []), ...(repair.rule?.diff ?? [])];
    result(
      `${name} — repair`,
      [selectors, rule].filter(Boolean).join('<div class="meta spaced"></div>') +
        (diff.length ? `<pre>${diff.map(escapeHtml).join('\n')}</pre>` : '') +
        rowsTable(repair.after?.rows),
    );
    await loadRobots();
  } catch (error) {
    result(
      `${name} — repair`,
      `<span class="broken">${escapeHtml(error instanceof Error ? error.message : error)}</span>`,
    );
  } finally {
    done();
  }
}

/** The rule as the editor has it now: patterns one per line, blanks ignored. */
function ruleFromEditor(): Sift {
  const lines = (id: string): string[] =>
    el<HTMLTextAreaElement>(id)
      .value.split('\n')
      .map((line) => line.trim())
      .filter(Boolean);

  const want = value('ruleWant');
  const judge = el<HTMLInputElement>('ruleJudge').checked;
  return {
    ...(want ? { want } : {}),
    keep: lines('ruleKeep'),
    ...(lines('ruleDrop').length ? { drop: lines('ruleDrop') } : {}),
    ...(judge ? { judge: { want, maxRows: 40 } } : {}),
  };
}

function putRuleInEditor(rule: Sift): void {
  el<HTMLTextAreaElement>('ruleKeep').value = rule.keep.join('\n');
  el<HTMLTextAreaElement>('ruleDrop').value = (rule.drop ?? []).join('\n');
  el<HTMLInputElement>('ruleJudge').checked = Boolean(rule.judge);
  if (rule.want) el<HTMLInputElement>('ruleWant').value = rule.want;
}

/**
 * A door meant for a person is not a build that failed — it is a build that cannot start. Saying so in
 * the same words every time, next to the one thing that opens it, is the whole difference between
 * "this site does not work" and "press this, then build again".
 */
function doorNote(through = 'this machine'): string {
  return (
    `<div class="meta spaced"><b>This is a door meant for a person</b>, not a list a selector can miss. ` +
    `This attempt went out through <b>${escapeHtml(through)}</b> — a door passed from one address does ` +
    `nothing for another, so open it with the same one: press <b>Open it myself</b> above, pass the ` +
    `check by hand, <b>Save and close</b>, then build again.</div>`
  );
}

// --- building -----------------------------------------------------------------------------------

el('agent').addEventListener('click', async () => {
  const url = value('url');
  if (!url) return;
  const done = busy(el<HTMLButtonElement>('agent'), 'the model is working');
  el('buildOut').innerHTML =
    '<div class="meta spaced">looking, trying selectors, pressing the next button… this takes a minute.</div>';
  try {
    const proxyId = value('buildProxy') || undefined;
    const through = proxyId ? el<HTMLSelectElement>('buildProxy').selectedOptions[0]?.text : 'this machine';
    const build = await api.agent(url, value('want'), value('name'), proxyId);
    const good = build.verdict?.good ?? false;
    el('buildOut').innerHTML =
      stepsList(build.steps) +
      `<div class="meta spaced">${build.usage.calls} model calls · ` +
      `${build.usage.promptTokens + build.usage.completionTokens} tokens</div>`;

    result(
      `${build.scenario?.name ?? url} — model build`,
      (good
        ? `${badge('ok')} saved — <b>${build.rows.length} rows</b>, every column filled`
        : `${badge(build.scenario ? 'weak' : 'broken')} not saved — ${escapeHtml(build.reason ?? 'the gate was not passed')}`) +
        (build.challenge ? doorNote(through ?? 'this machine') : '') +
        verdictBars(build.verdict) +
        (build.scenario ? `<pre>${escapeHtml(JSON.stringify(build.scenario, null, 2))}</pre>` : '') +
        rowsTable(build.rows),
    );
    void loadRuns();
    if (good) await loadRobots();
  } catch (error) {
    fail('buildOut', error);
  } finally {
    done();
  }
});

el('draft').addEventListener('click', async () => {
  const url = value('url');
  if (!url) return;
  const done = busy(el<HTMLButtonElement>('draft'), 'drafting');
  el('buildOut').innerHTML = '';
  try {
    const draft = await api.draft(url, value('name'), value('buildProxy') || undefined);
    el('buildOut').innerHTML = `<pre>${draft.log.map(escapeHtml).join('\n')}</pre>`;
    if (!draft.scenario) {
      el('buildOut').innerHTML += `<div class="broken spaced">${escapeHtml(draft.reason ?? 'no draft')}</div>`;
      return;
    }
    const weak = draft.verdict && !draft.verdict.good;
    result(
      `${draft.scenario.name} — heuristics`,
      `${weak ? `${badge('weak')} saved but weak` : badge('ok')}, proven on <b>${draft.provenRows} rows</b>` +
        verdictBars(draft.verdict) +
        `<pre>${escapeHtml(JSON.stringify(draft.scenario, null, 2))}</pre>`,
    );
    await loadRobots();
  } catch (error) {
    fail('buildOut', error);
  } finally {
    done();
  }
});

/** A Telegram robot is made where every other robot is made, not on the page where accounts live. */
/**
 * What the model made of the task, in the only terms that mean anything: how many real messages the
 * rule kept, which ones, and what it threw away. A rule nobody can check is a rule nobody should trust.
 */
function siftNote(sift?: { built: boolean; attempts: SiftAttempt[]; usage: { calls: number }; reason?: string }): string {
  if (!sift) return '';
  const last = sift.attempts[sift.attempts.length - 1];
  if (!sift.built || !last) {
    return `<div class="meta spaced">${badge('weak')} no rule separated these messages${
      sift.reason ? ` — ${escapeHtml(sift.reason)}` : ''
    }. The robot keeps everything for now.</div>`;
  }

  const patterns = [
    `<b>keeps</b> ${last.rule.keep.map((one) => `<code>${escapeHtml(one)}</code>`).join(' · ')}`,
    last.rule.drop?.length ? `<b>drops</b> ${last.rule.drop.map((one) => `<code>${escapeHtml(one)}</code>`).join(' · ')}` : '',
    Object.keys(last.rule.fields ?? {}).length
      ? `<b>reads out</b> ${Object.keys(last.rule.fields ?? {}).map(escapeHtml).join(' · ')}`
      : '',
  ]
    .filter(Boolean)
    .join('<br>');

  return (
    `<div class="meta spaced">${badge('ok')} the rule keeps <b>${last.kept}</b> of ` +
    `${last.kept + last.dropped} sampled messages, in ${sift.usage.calls} model call(s)<br>${patterns}` +
    `<br><span class="muted">kept: ${last.examples.kept.map(escapeHtml).join(' | ') || '—'}</span>` +
    `<br><span class="muted">dropped: ${last.examples.dropped.map(escapeHtml).join(' | ') || '—'}</span></div>`
  );
}

el('tgCreate').addEventListener('click', async () => {
  const done = busy(el<HTMLButtonElement>('tgCreate'), 'creating');
  try {
    const created = await api.telegramRobot({
      channels: value('tgChannels'),
      name: value('tgRobotName'),
      limit: Number(value('tgLimit')) || 100,
      contains: value('tgContains'),
      want: value('tgWant'),
      account: value('tgAccount') || undefined,
    });

    result(
      `${created.robot.name} — telegram robot`,
      `${badge('ok')} created for ${created.robot.channels.map(escapeHtml).join(', ')}` +
        siftNote(created.sift) +
        '<div class="meta spaced">press Run in the list below to read it</div>',
    );
    await loadRobots();
  } catch (error) {
    result(
      'telegram robot',
      `<span class="broken">${escapeHtml(error instanceof Error ? error.message : error)}</span>`,
    );
  } finally {
    done();
  }
});

// --- model connections ---------------------------------------------------------------------------

let providers: Record<ProviderId, Provider> | undefined;

/**
 * Catalogues are fetched when somebody actually opens the list — one request per provider per hour,
 * not one per card on every render.
 */
document.addEventListener('focusin', async (event) => {
  const select = (event.target as HTMLElement).closest<HTMLSelectElement>('select[data-connection-model]');
  if (!select || select.dataset['loaded']) return;

  const id = select.dataset['connectionModel']!;
  const note = document.querySelector<HTMLElement>(`[data-connection-note="${id}"]`);
  const chosen = select.value;

  try {
    if (note) note.textContent = 'asking the provider…';
    const list = await api.catalogueFor(id);
    select.innerHTML = list.models
      .map((model) => {
        const price = model.free ? 'free' : `$${model.price.toFixed(2)}/M`;
        return `<option value="${escapeHtml(model.id)}">${escapeHtml(model.name)} — ${price}</option>`;
      })
      .join('');
    select.value = chosen;
    select.dataset['loaded'] = 'yes';
    if (note) note.textContent = `${list.total} ${list.note ?? 'models'} · read ${new Date(list.fetchedAt).toLocaleTimeString()}`;
  } catch (error) {
    if (note) note.textContent = error instanceof Error ? error.message : String(error);
  }
});

document.addEventListener('change', async (event) => {
  const select = (event.target as HTMLElement).closest<HTMLSelectElement>('select[data-connection-model]');
  if (!select) return;
  try {
    await api.setConnectionModel(select.dataset['connectionModel']!, select.value);
    await loadConnections();
  } catch (error) {
    fail('llmStatus', error);
  }
});

async function loadConnections(): Promise<void> {
  try {
    const answer = await api.models();
    providers = answer.providers;

    const select = el<HTMLSelectElement>('llmProvider');
    if (!select.options.length) {
      select.innerHTML = Object.entries(answer.providers)
        .map(([id, provider]) => `<option value="${escapeHtml(id)}">${escapeHtml(provider.label)}</option>`)
        .join('');
      showProviderHelp();
    }

    el('llmList').innerHTML = answer.connections.map(connectionCard).join('');
    el('llmStatus').innerHTML = answer.connections.length
      ? `<span class="muted">${answer.connections.length} connection${answer.connections.length > 1 ? 's' : ''} — the one marked “in use” builds your robots</span>`
      : '<span class="muted">no connection yet — the model cannot build robots until one is here</span>';
  } catch (error) {
    fail('llmStatus', error);
  }
}

function showProviderHelp(): void {
  const chosen = value('llmProvider') as ProviderId;
  const provider = providers?.[chosen];
  show('llmBaseUrl', chosen === 'custom');
  el('llmModelNote').innerHTML = provider
    ? `${provider.keysAt ? `<a href="${escapeHtml(provider.keysAt)}" target="_blank" rel="noreferrer">get a key</a> · ` : ''}` +
      escapeHtml(provider.note ?? provider.baseUrl)
    : '';
}

el('llmProvider').addEventListener('change', showProviderHelp);

el('llmLoad').addEventListener('click', async () => {
  const done = busy(el<HTMLButtonElement>('llmLoad'), 'asking the provider');
  try {
    const list = await api.catalogue(
      value('llmProvider') as ProviderId,
      el<HTMLInputElement>('llmKey').value.trim(),
      value('llmBaseUrl') || undefined,
    );
    el<HTMLSelectElement>('llmModel').innerHTML = list.models
      .map((model) => {
        const price = model.free ? 'free' : `$${model.price.toFixed(2)}/M`;
        return `<option value="${escapeHtml(model.id)}">${escapeHtml(model.name)} — ${price}</option>`;
      })
      .join('');
    el('llmModelNote').textContent =
      `${list.total} ${list.note ?? 'models'} · read ${new Date(list.fetchedAt).toLocaleTimeString()}`;
  } catch (error) {
    fail('llmModelNote', error);
  } finally {
    done();
  }
});

el('llmAdd').addEventListener('click', async () => {
  const done = busy(el<HTMLButtonElement>('llmAdd'), 'adding');
  try {
    await api.addConnection(
      value('llmProvider') as ProviderId,
      el<HTMLInputElement>('llmKey').value.trim(),
      value('llmModel'),
      value('llmLabel'),
      value('llmBaseUrl') || undefined,
    );
    el<HTMLInputElement>('llmKey').value = '';
    el<HTMLInputElement>('llmLabel').value = '';
    await loadConnections();
  } catch (error) {
    fail('llmStatus', error);
  } finally {
    done();
  }
});

// --- proxies ------------------------------------------------------------------------------------

async function loadProxies(): Promise<void> {
  try {
    const { proxies } = await api.proxies();
    el('proxyList').innerHTML = proxies.map(proxyCard).join('');
    el('proxyStatus').innerHTML = proxies.length
      ? `<span class="muted">${proxies.length} address${proxies.length > 1 ? 'es' : ''} — a robot keeps the one it was built through</span>`
      : '<span class="muted">no proxies — robots go out from this machine&rsquo;s own address</span>';

    const menu =
      '<option value="">direct</option>' +
      proxies.map((proxy) => `<option value="${escapeHtml(proxy.id)}">${escapeHtml(proxy.label)}</option>`).join('');

    // The way out is remembered. A page that quietly resets this to "direct" on every reload sends a
    // robot from the wrong address, and the site answers with a door — which looks like the door being
    // broken rather than like the address being wrong.
    const chosen = localStorage.getItem('ratatosk.proxy') ?? '';
    const select = el<HTMLSelectElement>('buildProxy');
    select.innerHTML = menu;
    if (proxies.some((proxy) => proxy.id === chosen)) select.value = chosen;
  } catch (error) {
    fail('proxyStatus', error);
  }
}

el('proxyAdd').addEventListener('click', async () => {
  const done = busy(el<HTMLButtonElement>('proxyAdd'), 'adding');
  try {
    await api.addProxyParts({
      scheme: value('proxyScheme'),
      host: value('proxyHost'),
      port: value('proxyPort'),
      user: value('proxyUser'),
      pass: el<HTMLInputElement>('proxyPass').value,
      label: value('proxyLabel'),
    });
    for (const id of ['proxyHost', 'proxyPort', 'proxyUser', 'proxyPass', 'proxyLabel']) {
      el<HTMLInputElement>(id).value = '';
    }
    await loadProxies();
  } catch (error) {
    fail('proxyStatus', error);
  } finally {
    done();
  }
});

/**
 * Taking the browser over. It opens in a tab of its own rather than in a panel here: a screen inside a
 * page is a screen you fight with, and this is the moment someone needs the mouse to behave.
 */
// --- what the robots have been doing ---------------------------------------------------------------

async function loadRuns(): Promise<void> {
  try {
    const { runs, standing } = await api.history();
    const broken = standing.filter((entry) => entry.status !== 'ok');
    el('runsStatus').innerHTML = standing.length
      ? broken.length
        ? `${badge('broken')} ${broken.length} of ${standing.length} robots need looking at`
        : `${badge('ok')} all ${standing.length} robots came back with rows`
      : '<span class="muted">nothing has run yet</span>';
    el('runsList').innerHTML = runsList(runs);
  } catch (error) {
    fail('runsStatus', error);
  }
}

async function loadKeys(): Promise<void> {
  try {
    el('keysList').innerHTML = keysList((await api.keys()).keys);
  } catch (error) {
    fail('keysStatus', error);
  }
}

el('keyCreate').addEventListener('click', async () => {
  const done = busy(el<HTMLButtonElement>('keyCreate'), 'making');
  try {
    const made = await api.createKey(value('keyLabel'));
    el<HTMLInputElement>('keyLabel').value = '';
    // Shown once, here, and never again — the server keeps only its hash.
    el('keysStatus').innerHTML =
      `${badge('ok')} copy it now, it is not shown again:<pre>${escapeHtml(made.key)}</pre>`;
    el('keysList').innerHTML = keysList(made.keys);
  } catch (error) {
    fail('keysStatus', error);
  } finally {
    done();
  }
});

el('takeoverOpen').addEventListener('click', async () => {
  const done = busy(el<HTMLButtonElement>('takeoverOpen'), 'starting a screen');
  try {
    // The same address and the same way out as the build below it: one door, not a second set of fields.
    const session = await api.takeover(value('url'), value('buildProxy') || undefined);
    window.open(session.view, '_blank', 'noreferrer');
    show('takeoverNote', true);
    el('takeoverNote').innerHTML =
      `${badge('ok')} open in a new tab until ${escapeHtml(new Date(session.expiresAt).toLocaleTimeString())} — ` +
      `press straight on the picture, and finish with <b>Save and close</b> there: that is what writes the ` +
      `profile. Need the whole desktop instead? ` +
      `<a href="${escapeHtml(session.desktop)}" target="_blank" rel="noreferrer">open it over VNC</a>.`;
  } catch (error) {
    show('takeoverNote', true);
    fail('takeoverNote', error);
  } finally {
    done();
  }
});

el('buildProxy').addEventListener('change', (event) => {
  localStorage.setItem('ratatosk.proxy', (event.target as HTMLSelectElement).value);
});

// --- telegram accounts ---------------------------------------------------------------------------

function telegramStep(step: 1 | 2 | 3): void {
  for (const [index, id] of ['tgStep1', 'tgStep2', 'tgStep3'].entries()) {
    el(id).classList.toggle('here', index + 1 === step);
    el(id).classList.toggle('done', index + 1 < step);
  }
}

async function loadTelegram(): Promise<void> {
  try {
    const { accounts } = await api.telegramAccounts();
    el('tgList').innerHTML = accounts.map(accountCard).join('');
    el('tgStatus').innerHTML = accounts.length
      ? `<span class="muted">${accounts.length} account${accounts.length > 1 ? 's' : ''} connected — a robot names the one it reads with</span>`
      : '<span class="muted">no account connected — public channels work without one, groups do not</span>';

    el<HTMLSelectElement>('tgAccount').innerHTML = accounts.length
      ? accounts
          .map((account) => `<option value="${escapeHtml(account.id)}">${escapeHtml(account.account ?? account.id)}</option>`)
          .join('')
      : '<option value="">— no account —</option>';

    el('tgRobotNote').innerHTML = accounts.length
      ? 'List the channels and groups by username, without the @. The robot takes that many recent messages from each; the filter keeps only messages containing one of those words.'
      : 'Public channels can be read as pages — build them as a <b>website</b> robot on <code>t.me/s/&lt;channel&gt;</code>. Groups need an account: connect one under <b>Telegram</b>.';

    if (!accounts.length) telegramStep(1);
  } catch (error) {
    fail('tgStatus', error);
  }
}

el('tgSend').addEventListener('click', async () => {
  const done = busy(el<HTMLButtonElement>('tgSend'), 'sending');
  try {
    await api.telegramSendCode(value('tgApiId'), value('tgApiHash'), value('tgPhone'));
    telegramStep(2);
    el<HTMLInputElement>('tgCode').focus();
    el('tgStatus').innerHTML =
      '<span class="muted">Telegram sent a code to that account — step 2 below. Do not give that code to anyone.</span>';
  } catch (error) {
    fail('tgStatus', error);
  } finally {
    done();
  }
});

el('tgSignIn').addEventListener('click', async () => {
  const done = busy(el<HTMLButtonElement>('tgSignIn'), 'connecting');
  try {
    await api.telegramSignIn(value('tgPhone'), value('tgCode'), el<HTMLInputElement>('tgPassword').value);
    for (const id of ['tgApiId', 'tgApiHash', 'tgPhone', 'tgCode', 'tgPassword']) {
      el<HTMLInputElement>(id).value = '';
    }
    telegramStep(3);
    await loadTelegram();
  } catch (error) {
    fail('tgStatus', error);
  } finally {
    done();
  }
});

// --- one handler for everything the lists offer ----------------------------------------------------

document.addEventListener('click', async (event) => {
  const target = event.target as HTMLElement;

  const viewTab = target.closest<HTMLElement>('.view-tab');
  if (viewTab?.dataset['view']) return showView(viewTab.dataset['view']);

  const kindTab = target.closest<HTMLElement>('.tab[data-kind]');
  if (kindTab) {
    shownKind = kindTab.dataset['kind'] ?? 'all';
    void loadRobots();
    return;
  }

  const sourceTab = target.closest<HTMLElement>('.tab[data-source]');
  if (sourceTab) {
    const source = sourceTab.dataset['source'] ?? 'web';
    for (const tab of document.querySelectorAll<HTMLElement>('.tab[data-source]')) {
      tab.classList.toggle('on', tab.dataset['source'] === source);
    }
    show('sourceWeb', source === 'web');
    show('sourceTelegram', source === 'telegram');
    return;
  }

  if (!(target instanceof HTMLButtonElement)) return;

  const actions: Array<[string, string, (id: string) => Promise<void>]> = [
    ['data-run', 'robots', async (id) => runRobot(id, target)],
    ['data-repair', 'robots', async (id) => repairRobot(id, target)],
    ['data-rule', 'robots', async (id) => {
      const rule = await api.rule(id);
      result(`${id} — what it keeps`, ruleEditor(id, rule.sift, rule.remember));
    }],
    ['data-rule-test', 'robots', async (id) => {
      const done = busy(target, 'collecting');
      try {
        el('ruleOut').innerHTML = '<span class="muted">reading the source as the robot reads it…</span>';
        el('ruleOut').innerHTML = ruleVerdict(await api.testRule(id, ruleFromEditor()));
      } finally {
        done();
      }
    }],
    ['data-rule-rebuild', 'robots', async (id) => {
      const done = busy(target, 'the model is reading');
      try {
        el('ruleOut').innerHTML = '<span class="muted">collecting fresh material and writing the rule again…</span>';
        const written = await api.rebuildRule(id, value('ruleWant'));
        if (!written.proposed) {
          el('ruleOut').innerHTML =
            `${badge('weak')} ${escapeHtml(written.reason ?? 'no rule separated this material')}` +
            `<div class="meta">nothing was changed — the rule you have is still the rule.</div>`;
          return;
        }
        // Proposed, not applied: the diff is for a person, and Save is a separate press.
        putRuleInEditor(written.proposed);
        el('ruleOut').innerHTML =
          `${badge('ok')} written from ${written.sampled} rows in ${written.usage.calls} model call(s) — ` +
          `read it above and press <b>Save</b> to keep it, or <b>Try it</b> first.`;
      } finally {
        done();
      }
    }],
    ['data-rule-save', 'robots', async (id) => {
      const done = busy(target, 'saving');
      try {
        const saved = await api.saveRule(id, ruleFromEditor(), el<HTMLInputElement>('ruleRemember').checked);
        el('ruleOut').innerHTML =
          (saved.sift
            ? `${badge('ok')} saved — the previous rule is kept beside it as .previous.json`
            : `${badge('empty')} saved with no rule — this robot now keeps everything it collects`) +
          (saved.remember
            ? '<div class="meta">it will hand back only what it has not seen before</div>'
            : '<div class="meta">it will hand back everything it collects, every time</div>');
        await loadRobots();
      } finally {
        done();
      }
    }],
    ['data-delete', 'robots', async (id) => {
      // Deleting is one click too easy to do by accident, so the first one only asks. The file itself
      // is moved aside rather than destroyed — a robot is minutes of a model's work.
      if (target.dataset['sure'] !== id) {
        target.dataset['sure'] = id;
        target.textContent = 'really?';
        target.classList.add('danger');
        setTimeout(() => {
          if (target.dataset['sure'] !== id) return;
          delete target.dataset['sure'];
          target.textContent = 'Delete';
          target.classList.remove('danger');
        }, 4000);
        return;
      }

      const done = busy(target, 'deleting');
      try {
        const gone = await api.deleteRobot(id);
        result(
          id,
          `${badge('ok')} deleted` +
            (gone.forgotten
              ? ` — and its profile forgot ${gone.forgotten} cookie${gone.forgotten > 1 ? 's' : ''} for <b>${escapeHtml(gone.host ?? '')}</b>`
              : gone.kept
                ? ` — ${escapeHtml(gone.kept)}, so the profile keeps what it knows`
                : ''),
        );
        await Promise.all([loadRobots(), loadRuns()]);
      } finally {
        done();
      }
    }],
    ['data-runs', 'llmStatus', async (id) => {
      await api.runWithConnection(id);
      await loadConnections();
    }],
    ['data-use', 'llmStatus', async (id) => {
      await api.useConnection(id);
      await loadConnections();
    }],
    ['data-remove-connection', 'llmStatus', async (id) => {
      await api.removeConnection(id);
      await loadConnections();
    }],
    ['data-check-connection', 'llmStatus', async (id) => {
      const done = busy(target, 'asking');
      try {
        const checked = await api.checkConnection(id);
        el('llmStatus').innerHTML = `${badge(checked.ok ? 'ok' : 'broken')} ${escapeHtml(checked.note)}`;
        await loadConnections();
      } finally {
        done();
      }
    }],
    ['data-proxy-check', 'proxyStatus', async (id) => {
      const done = busy(target, 'going out');
      try {
        const seen = await api.checkProxy(id);
        el('proxyStatus').innerHTML =
          `${badge('ok')} <b>${escapeHtml(seen.label)}</b> comes out as <b>${escapeHtml(seen.exitIp)}</b> in ${seen.latencyMs} ms`;
        await loadProxies();
      } finally {
        done();
      }
    }],
    ['data-proxy-remove', 'proxyStatus', async (id) => {
      await api.removeProxy(id);
      await Promise.all([loadProxies(), loadRobots()]);
    }],
    ['data-tg-forget', 'tgStatus', async (id) => {
      await api.telegramForget(id);
      await Promise.all([loadTelegram(), loadRobots()]);
    }],
    ['data-key-revoke', 'keysStatus', async (id) => {
      const revoked = await api.revokeKey(id);
      el('keysList').innerHTML = keysList(revoked.keys);
      el('keysStatus').innerHTML = '<span class="muted">revoked — whatever was using it stops now</span>';
    }],
    ['data-tg-check', 'tgStatus', async (id) => {
      const done = busy(target, 'asking Telegram');
      try {
        const state = await api.telegramCheck(id);
        el('tgStatus').innerHTML = `${badge(state.lastCheck?.ok === false ? 'broken' : 'ok')} ${escapeHtml(
          state.lastCheck?.note ?? 'the session answered',
        )}`;
        await loadTelegram();
      } finally {
        done();
      }
    }],
  ];

  for (const [attribute, where, run] of actions) {
    const id = target.getAttribute(attribute);
    if (!id) continue;
    try {
      await run(id);
    } catch (error) {
      fail(where, error);
    }
    return;
  }
});

// --- start ------------------------------------------------------------------------------------------

for (const [id, kind] of [
  ['authLogin', 'login'],
  ['authRegister', 'register'],
] as const) {
  el(id).addEventListener('click', async () => {
    const done = busy(el<HTMLButtonElement>(id), kind === 'login' ? 'signing in' : 'creating');
    try {
      await enter(kind);
    } catch (error) {
      fail('authNote', error);
    } finally {
      done();
    }
  });
}

document.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !el('authBox').hidden) el<HTMLButtonElement>('authLogin').click();
});

window.addEventListener('unhandledrejection', (event) => {
  if (event.reason instanceof ApiError && event.reason.unauthorised) signedOut(event.reason.message);
});

async function loadEverything(): Promise<void> {
  await Promise.all([loadRobots(), loadRuns(), loadKeys(), loadConnections(), loadProxies(), loadTelegram()]);
}

void (async () => {
  if (!currentToken()) return signedOut();
  try {
    const { user } = await api.me();
    signedIn(user);
    await loadEverything();
  } catch (error) {
    signedOut(error instanceof Error ? error.message : undefined);
  }
})();
