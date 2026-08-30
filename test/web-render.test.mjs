import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  accountCard,
  badge,
  connectionCard,
  escapeHtml,
  scraperCard,
  proxyCard,
  rowsTable,
  stepsList,
  verdictBars,
} from '../web/render.ts';

/**
 * The front-end's markup is built from typed data by pure functions, so it can be checked here —
 * no browser, no server, no network. Escaping in particular: rows come from other people's pages.
 */
test('anything from a page is escaped before it reaches the markup', () => {
  assert.equal(escapeHtml('<script>alert(1)</script>'), '&lt;script&gt;alert(1)&lt;/script&gt;');
  assert.equal(escapeHtml('a "quoted" & odd'), 'a &quot;quoted&quot; &amp; odd');
});

test('a hostile value in a row cannot become markup', () => {
  const html = rowsTable([{ title: '<img src=x onerror=alert(1)>' }]);
  assert.ok(!html.includes('<img'), 'the tag must not survive');
  assert.ok(html.includes('&lt;img'));
});

test('a table shows columns, links and empties', () => {
  const html = rowsTable([
    { title: 'First', url: 'https://example.com/a', price: null },
    { title: 'Second', url: 'https://example.com/b', price: '' },
  ]);
  assert.ok(html.includes('<th>title</th>'));
  assert.ok(html.includes('href="https://example.com/a"'));
  assert.equal(html.match(/class="muted">—/g)?.length, 2, 'null and empty both read as nothing');
});

test('a long table says how much it is not showing', () => {
  const rows = Array.from({ length: 60 }, (_, index) => ({ n: String(index) }));
  const html = rowsTable(rows);
  assert.ok(html.includes('… and 10 more'));
  assert.equal(rowsTable([]), '', 'nothing to show is nothing at all');
});

test('coverage bars carry the number and the complaints', () => {
  const html = verdictBars({
    good: false,
    coverage: { title: 1, link: 0.13 },
    complaints: ['"link" is filled in only 1 of 8 rows'],
  });
  assert.ok(html.includes('100% of rows'));
  assert.ok(html.includes('13% of rows'));
  assert.ok(html.includes('var(--ok)'), 'a full column is green');
  assert.ok(html.includes('var(--empty)'), 'a partial column is not');
  assert.ok(html.includes('filled in only 1 of 8 rows'));
  assert.equal(verdictBars(undefined), '');
});

test('steps and badges render what the engine reports', () => {
  assert.ok(stepsList([{ tool: 'try', input: {}, result: '20 rows of 20 blocks' }]).includes('20 rows of 20 blocks'));
  assert.equal(badge('broken'), '<span class="badge broken">broken</span>');
});

test('a scraper card offers exactly the two actions', () => {
  const html = scraperCard({ name: 'city-jobs', url: 'https://jobs.example.com', fields: ['title', 'link'], pagination: 'button' });
  assert.ok(html.includes('data-run="city-jobs"'));
  assert.ok(html.includes('data-repair="city-jobs"'));
  assert.ok(html.includes('title · link'));
});

// --- cards that must show what a button did ---------------------------------------------------

test('a checked connection shows what the check found', () => {
  const html = connectionCard({
    id: 'abc',
    label: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    model: 'openai/gpt-5-nano',
    keyHint: '…9f2c',
    active: true,
    lastCheck: { at: '2026-08-27T09:00:00.000Z', ok: true, note: 'answered in 380 ms · $4.20 left of $10.00' },
  });
  assert.ok(html.includes('answered in 380 ms'), 'the verdict has to reach the card');
  assert.ok(html.includes('$4.20 left'));
});

test('an unchecked connection says so instead of showing nothing', () => {
  const html = connectionCard({
    id: 'abc',
    label: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    model: 'x',
    keyHint: '…1',
    active: false,
  });
  assert.match(html, /never checked/);
});

/**
 * The bug this exists for: pressing “Check connection” asked Telegram, got an answer, and changed
 * nothing on the page, because the answer was never part of what a card renders.
 */
test('a checked Telegram account shows what the check found', () => {
  const html = accountCard({
    id: 'f7',
    account: '@itssaithan',
    apiId: 24003941,
    alive: true,
    dialogs: 42,
    access: [{ channel: 'pythonjobs', ok: false, note: 'not a member' }],
    lastCheck: { at: '2026-08-27T09:00:00.000Z', ok: false, note: 'signed in as @itssaithan, 42 chats visible' },
  });
  assert.ok(html.includes('signed in as @itssaithan'), 'the verdict has to reach the card');
  assert.ok(html.includes('42'), 'how many chats are visible is the point of the check');
  assert.ok(html.includes('pythonjobs'), 'and whether each channel can still be read');
  assert.ok(html.includes('not a member'));
});

test('an unchecked Telegram account says so instead of showing nothing', () => {
  const html = accountCard({ id: 'f7', account: '@someone' });
  assert.match(html, /never checked/);
  assert.ok(!html.includes('chats visible'));
});

test('an account whose check failed is not badged as healthy', () => {
  const html = accountCard({
    id: 'f7',
    account: '@someone',
    alive: false,
    lastCheck: { at: '2026-08-27T09:00:00.000Z', ok: false, note: 'AUTH_KEY_UNREGISTERED' },
  });
  assert.ok(html.includes('badge broken'), 'a dead session must not wear the same badge as a live one');
  assert.ok(html.includes('AUTH_KEY_UNREGISTERED'));
});

test('a page that turns out to be an anti-bot check is named as one', async () => {
  // The words the engine watches for, and the ones it must not mistake for a wall.
  const { CHALLENGE_WORDS } = await import('../src/look.ts').catch(() => ({ CHALLENGE_WORDS: undefined }));
  if (!CHALLENGE_WORDS) return; // the pattern lives inside the extractor source; nothing to assert here

  for (const wall of ['Just a moment…', 'Confirm that you are human', 'If you are human, click', 'Antibot Cloud', 'Я не робот']) {
    assert.ok(CHALLENGE_WORDS.test(wall), `${wall} is a wall`);
  }
  for (const fine of ['Вакансии в вебкам', 'Jobs in Amsterdam', 'Human Resources']) {
    assert.ok(!CHALLENGE_WORDS.test(fine), `${fine} is not a wall`);
  }
});

/**
 * The viewer is a page written as a string, which means nothing type-checks it and nothing runs it
 * until a person opens it. It once shipped with the same name declared twice: the whole script died of
 * a syntax error before its first line, so the window sat there with no picture, no requests and no
 * error in the console — the emptiest possible failure. This parses it on every run.
 */
test('the live viewer\'s script is valid JavaScript', async () => {
  const { viewerPage } = await import('../src/live-view.ts');
  const html = viewerPage('a-token', 'https://example.com/');
  const script = html.slice(html.indexOf('<script>') + 8, html.indexOf('</script>'));

  assert.ok(script.length > 500, 'the script has to actually be in there');
  // Parsed, not run: a browser refuses the whole file for a syntax error, and so does this.
  assert.doesNotThrow(() => new Function(script), 'the viewer script must parse');
});

test('the live viewer asks for frames and sends what a person does', async () => {
  const { viewerPage } = await import('../src/live-view.ts');
  const html = viewerPage('a-token', 'https://example.com/');

  assert.match(html, /\/frame\?since=/, 'it has to ask for frames');
  for (const move of ['down', 'move', 'up', 'wheel', 'write', 'key']) {
    assert.ok(html.includes(`type: '${move}'`), `${move} must reach the page`);
  }
  assert.ok(html.includes('draggable="false"'), 'or the browser drags the picture instead of the page');
  // Ending the session is what writes the profile, so it has to be possible from here.
  assert.match(html, /\/done'/, 'the window must be able to close the browser itself');
  assert.ok(html.includes('Save and close'));
});

/**
 * The same question on four different things.
 *
 * A connection, a proxy, a Telegram account and a scraper break in unrelated ways, but "is this still
 * working?" is one question, so it must be one control everywhere — and the answer must be a line of
 * its own rather than a word lost among the facts. A card that quietly loses its check is a card that
 * makes somebody run a scraper to find out what it could have told them.
 */
test('every card carries the same check control and says how it is underneath', () => {
  const cards = {
    connection: connectionCard({
      id: 'c1',
      label: 'OpenRouter',
      baseUrl: 'https://openrouter.ai/api/v1',
      model: 'a/b',
      keyHint: '…1',
      active: true,
      lastCheck: { at: new Date().toISOString(), ok: true, note: 'answered in 900 ms' },
    }),
    proxy: proxyCard({
      id: 'p1',
      label: 'US proxy',
      scheme: 'socks5',
      host: '198.51.100.7:1080',
      exitIp: '198.51.100.7',
      checkedAt: new Date().toISOString(),
      latencyMs: 240,
    }),
    account: accountCard({
      id: 'a1',
      account: '@someone',
      lastCheck: { at: new Date().toISOString(), ok: true, note: 'signed in, 42 chats visible' },
    }),
    scraper: scraperCard(
      { name: 'city-jobs', url: 'https://jobs.example.com', fields: ['title'], pagination: 'none' },
      undefined,
      { at: new Date().toISOString(), ok: true, note: '20 rows on the first page' },
    ),
  };

  for (const [what, html] of Object.entries(cards)) {
    assert.match(html, /<button class="icon"[^>]*data-[a-z-]*check/, `${what} has no way to ask`);
    assert.match(html, /class="state ok"/, `${what} does not say how it is`);
  }
});

test('a card that has never been checked says so rather than looking fine', () => {
  const proxy = proxyCard({ id: 'p1', label: 'US proxy', scheme: 'socks5', host: '198.51.100.7:1080' });
  assert.match(proxy, /class="state muted"/);
  assert.match(proxy, /never checked/);

  // A failed check is not a missing one, and the two must not look alike.
  const broken = connectionCard({
    id: 'c1',
    label: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    model: 'a/b',
    keyHint: '…1',
    active: true,
    lastCheck: { at: new Date().toISOString(), ok: false, note: 'the provider answered 401' },
  });
  assert.match(broken, /class="state bad"/);
  assert.match(broken, /401/);
});
