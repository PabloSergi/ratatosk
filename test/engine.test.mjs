import assert from 'node:assert/strict';
import { test } from 'vitest';
import { parseScenario, runScenario } from '../src/index.ts';

/**
 * A fake browser that answers exactly what the engine asks a page, and nothing more.
 * It is deliberately dumb: these tests are about the walk and its verdicts, not about a real DOM.
 */
class FakePage {
  constructor({ rendered = true, blocksSeen = 2, rowsPerPage = 2, pages = 1, extractorAnswers = true, clickFails = false, clickChangesNothing = false } = {}) {
    Object.assign(this, { rendered, blocksSeen, rowsPerPage, pages, extractorAnswers, clickFails, clickChangesNothing });
    this.pageIndex = 0;
  }
  async goto(url) { this.url = url; }
  async currentUrl() { return `${this.url}#p${this.pageIndex}`; }
  async click() {
    if (this.clickFails) throw new Error('page.click: Timeout 30000ms exceeded.\nCall log:\n  - overlay intercepts pointer events');
    if (!this.clickChangesNothing) this.pageIndex++;
  }
  async waitMs() {}
  async evaluate(fn) {
    if (fn.includes('querySelectorAll(selector).length')) return this.rendered ? 5 : 0;
    if (fn.includes('blocksSeen')) {
      if (!this.extractorAnswers) return undefined;
      const rows = Array.from({ length: this.rowsPerPage }, (_, i) => ({ title: `row ${this.pageIndex}.${i}` }));
      return { rows, blocksSeen: this.blocksSeen, missing: rows.length ? {} : { title: this.blocksSeen } };
    }
    if (fn.includes('node.remove()')) return 3;
    if (fn.includes('document.querySelector(selector)')) return this.pageIndex < this.pages - 1;
    if (fn.includes('blocks.length')) return `${this.rowsPerPage}|page ${this.pageIndex}`;
    if (fn.includes('scrollHeight')) return 1000;
    return null;
  }
}

const base = {
  name: 'test', version: 1, url: 'https://example.com/jobs',
  wait: { selector: '.card', minCount: 3, timeoutMs: 300, settleMs: 0 },
  list: { rows: '.card', fields: { title: { type: 'text', selector: 'h2' } } },
  pagination: { type: 'none' },
};
const withLinks = { ...base, pagination: { type: 'link', next: 'a[rel=next]', maxPages: 20 } };

test('rows on one page', async () => {
  const result = await runScenario(new FakePage({ rowsPerPage: 2 }), parseScenario(base));
  assert.equal(result.status, 'ok');
  assert.equal(result.rows.length, 2);
  assert.equal(result.pagesVisited, 1);
});

test('walks pagination to the end', async () => {
  const result = await runScenario(new FakePage({ rowsPerPage: 2, pages: 3 }), parseScenario(withLinks));
  assert.equal(result.status, 'ok');
  assert.equal(result.rows.length, 6);
  assert.equal(result.pagesVisited, 3);
});

test('a page that never renders is broken, not empty', async () => {
  const result = await runScenario(new FakePage({ rendered: false }), parseScenario(base));
  assert.equal(result.status, 'broken');
  assert.match(result.reason, /never rendered/);
});

test('blocks matched but no fields means rotted selectors', async () => {
  const result = await runScenario(new FakePage({ rowsPerPage: 0, blocksSeen: 7 }), parseScenario(base));
  assert.equal(result.status, 'broken');
  assert.match(result.reason, /rotted/);
});

test('nothing matched at all is empty, and says so', async () => {
  const result = await runScenario(new FakePage({ rowsPerPage: 0, blocksSeen: 0 }), parseScenario(base));
  assert.equal(result.status, 'empty');
  assert.match(result.reason, /matched nothing/);
});

test('an extractor that answers nothing is broken', async () => {
  const result = await runScenario(new FakePage({ extractorAnswers: false }), parseScenario(base));
  assert.equal(result.status, 'broken');
  assert.match(result.reason, /nothing usable/);
});

test('a blocked pagination click keeps the rows and records why the walk stopped', async () => {
  const result = await runScenario(new FakePage({ rowsPerPage: 2, pages: 3, clickFails: true }), parseScenario(withLinks));
  assert.equal(result.status, 'ok');
  assert.equal(result.rows.length, 2);
  assert.match(result.reason, /stopped early/);
});

test('a click that changes nothing stops the walk instead of collecting the page twice', async () => {
  const result = await runScenario(new FakePage({ rowsPerPage: 2, pages: 3, clickChangesNothing: true }), parseScenario(withLinks));
  assert.equal(result.status, 'ok');
  assert.equal(result.rows.length, 2);
  assert.equal(result.pagesVisited, 1);
  assert.match(result.reason, /did not change/);
});

test('site rules that fire are reported, not silent', async () => {
  const page = new FakePage({ rowsPerPage: 2 });
  const result = await runScenario(page, parseScenario(base), {
    rules: [{ name: 'consent overlay', match: 'example.com', remove: ['#overlay'] }],
  });
  assert.equal(result.status, 'ok');
  assert.deepEqual(result.rulesApplied, ['consent overlay: removed 3 element(s)']);
});

test('a scenario without fields is refused before any browser starts', () => {
  assert.throws(() => parseScenario({ ...base, list: { rows: '.card', fields: {} } }), /at least one field/);
});

// --- build-time tools -------------------------------------------------------

import { buildScenario, fieldsFromRoles, tryFields } from '../src/index.ts';

/** A page whose extractor answers with rows we dictate, so the warnings can be checked exactly. */
class CannedPage {
  constructor(rows, blocksSeen = rows.length, missing = {}) {
    Object.assign(this, { rows, blocksSeen, missing });
  }
  async currentUrl() { return 'https://example.com/list'; }
  async evaluate(fn) {
    if (fn.includes('blocksSeen')) return { rows: this.rows, blocksSeen: this.blocksSeen, missing: this.missing };
    return null;
  }
}

const list = { rows: '.card', fields: { title: { type: 'text' }, city: { type: 'text' }, town: { type: 'text' } } };

test('try reports a column that never varies', async () => {
  const rows = [
    { title: 'a', city: 'Berlin', town: 'x' },
    { title: 'b', city: 'Berlin', town: 'y' },
    { title: 'c', city: 'Berlin', town: 'z' },
  ];
  const result = await tryFields(new CannedPage(rows), list);
  assert.equal(result.rows, 3);
  assert.ok(result.warnings.some((w) => w.startsWith('"city"') && w.includes('static label')));
});

test('try reports one column repeating another', async () => {
  const rows = [
    { title: 'a', city: 'Ulm', town: 'Ulm' },
    { title: 'b', city: 'Kiel', town: 'Kiel' },
  ];
  const result = await tryFields(new CannedPage(rows), list);
  assert.ok(result.warnings.some((w) => w.includes('"town" repeats "city"')));
});

test('try reports blocks that matched but filled nothing', async () => {
  const result = await tryFields(new CannedPage([], 12, { title: 12 }), list);
  assert.ok(result.warnings.some((w) => w.includes('12 blocks matched but no field ever filled')));
});

test('roles from look become field rules, links and images as attributes', () => {
  const fields = fieldsFromRoles([
    { role: 'title', selector: 'h3 a', attr: 'title' },
    { role: 'link', selector: 'a' },
    { role: 'image', selector: 'img' },
    { role: 'price', selector: '.p' },
  ]);
  assert.deepEqual(fields.title, { type: 'attr', selector: 'h3 a', attr: 'title', optional: false });
  assert.equal(fields.url.attr, 'href');
  assert.equal(fields.url.absolute, true);
  assert.equal(fields.image.optional, true);
  assert.equal(fields.price.type, 'text');
});

test('a built scenario is validated at build time, not at first run', () => {
  const scenario = buildScenario({
    name: 'jobs', url: 'https://example.com/jobs', rows: '.card',
    fields: { title: { type: 'text', selector: 'h3' } },
    pagination: { type: 'link', next: 'a[rel=next]', maxPages: 5 },
    minRowsPerPage: 8,
  });
  assert.equal(scenario.wait.selector, '.card');
  assert.equal(scenario.expect.minRowsPerPage, 8);
  assert.throws(() => buildScenario({
    name: 'broken', url: 'not-a-url', rows: '.card',
    fields: { title: { type: 'text' } }, pagination: { type: 'none' },
  }), /url must be http/);
});

// --- cursor pagination ------------------------------------------------------

import { cursorFrom } from '../src/run.ts';

test('a cursor is taken from the last row', () => {
  const rows = [{ link: 'https://t.me/ch/120' }, { link: 'https://t.me/ch/118' }];
  assert.equal(cursorFrom(rows, 'link'), '118');
  assert.equal(cursorFrom([], 'link'), undefined);
  assert.equal(cursorFrom([{ id: 'post-42-x' }], 'id', '(\\d+)'), '42');
});

test('the cursor does not depend on what the column was called', () => {
  // A rule is written once for a whole site; the robot may name its columns in any language.
  const rows = [{ 'ссылка': 'https://t.me/ch/118', 'цена': '500' }];
  assert.equal(cursorFrom(rows, '*'), '118');
  assert.equal(cursorFrom(rows, 'link'), '118', 'a missing column name falls back to the link');
});

// --- numbered pagination -----------------------------------------------------

/**
 * A pager that is nothing but numbers: ?page=2, ?page=3. The class marking the current page is
 * generated at build time on most of these sites, so the number in the URL is the only durable
 * thing about them — and a number past the end is answered with the first page, not an error.
 */
class NumberedPage extends FakePage {
  constructor(options) {
    super(options);
    this.lastPage = options.lastPage ?? 3;
    this.visited = [];
  }
  async goto(url) {
    this.url = url;
    const asked = Number(new URL(url).searchParams.get('page') ?? 1);
    // Past the end the site quietly serves page one again.
    this.pageIndex = asked > this.lastPage ? 0 : asked - 1;
    this.visited.push(asked);
  }
  async currentUrl() { return this.url; }
}

const numbered = {
  ...base,
  url: 'https://example.com/jobs',
  pagination: { type: 'number', param: 'page', maxPages: 10 },
};

test('a numbered pager is walked by counting up', async () => {
  const page = new NumberedPage({ rowsPerPage: 2, lastPage: 3 });
  const result = await runScenario(page, parseScenario(numbered));

  assert.equal(result.status, 'ok');
  assert.equal(result.pagesVisited, 3);
  assert.equal(result.rows.length, 6);
  assert.deepEqual(page.visited, [1, 2, 3, 4], 'it stops after the page that repeats itself');
});

test('a numbered pager that repeats page one does not collect it twice', async () => {
  const page = new NumberedPage({ rowsPerPage: 2, lastPage: 1 });
  const result = await runScenario(page, parseScenario(numbered));

  assert.equal(result.pagesVisited, 1);
  assert.equal(result.rows.length, 2, 'the same rows must not be counted again');
});

test('a numbered pager can start and step where the site does', async () => {
  const page = new NumberedPage({ rowsPerPage: 1, lastPage: 5 });
  await runScenario(page, parseScenario({ ...numbered, pagination: { type: 'number', param: 'page', start: 3, step: 2, maxPages: 3 } }));
  assert.deepEqual(page.visited, [1, 3, 5], 'first the page as given, then counting from start by step');
});

// --- walking into rows -------------------------------------------------------

/**
 * A list rarely carries everything: pay, contacts and the full text live one page deeper. This is the
 * fake for that — a list page, and a page per row that knows what the list could not hold.
 */
class PageWithRows extends FakePage {
  constructor(options = {}) {
    super({ rowsPerPage: 3, ...options });
    this.opened = [];
    this.where = 'list';
    this.broken = options.broken ?? [];
  }
  async goto(url) {
    this.url = url;
    if (url.includes('/row/')) {
      this.opened.push(url);
      this.where = url;
      if (this.broken.includes(url)) throw new Error(`page.goto: ${url} did not open`);
    } else {
      this.where = 'list';
    }
  }
  async evaluate(fn, argument) {
    if (fn.includes('blocksSeen')) {
      if (this.where !== 'list') {
        // The row's own page: one block, holding what the list could not.
        return { rows: [{ pay: `pay for ${this.where.split('/').pop()}` }], blocksSeen: 1, missing: {} };
      }
      const rows = Array.from({ length: this.rowsPerPage }, (_, i) => ({
        title: `row ${this.pageIndex}.${i}`,
        link: `https://example.com/row/${this.pageIndex}-${i}`,
      }));
      return { rows, blocksSeen: this.blocksSeen, missing: {} };
    }
    return super.evaluate(fn, argument);
  }
}

const withDetail = {
  ...base,
  list: { rows: '.card', fields: { title: { type: 'text' }, link: { type: 'attr', attr: 'href', absolute: true } } },
  detail: { follow: 'link', fields: { pay: { type: 'text', selector: '.pay' } }, maxRows: 10 },
};

test('each row is opened and gives up what the list could not hold', async () => {
  const page = new PageWithRows();
  const result = await runScenario(page, parseScenario(withDetail));

  assert.equal(result.status, 'ok');
  assert.equal(result.rows.length, 3);
  assert.deepEqual(page.opened, [
    'https://example.com/row/0-0',
    'https://example.com/row/0-1',
    'https://example.com/row/0-2',
  ]);
  assert.equal(result.rows[0].pay, 'pay for 0-0', 'the deeper field belongs to its own row');
  assert.equal(result.rows[2].pay, 'pay for 0-2');
  assert.equal(result.evidence.rowsOpened, 3, 'how many pages this cost is not a mystery');
});

test('the walk into rows is capped, because every row is a page load', async () => {
  const page = new PageWithRows({ rowsPerPage: 9 });
  const result = await runScenario(page, parseScenario({ ...withDetail, detail: { ...withDetail.detail, maxRows: 4 } }));

  assert.equal(page.opened.length, 4, 'four pages, not nine');
  assert.equal(result.rows.length, 9, 'and every row still comes back');
  assert.equal(result.rows[8].pay, undefined, 'the ones not opened simply have nothing extra');
});

test('a row whose page will not open keeps what the list gave it', async () => {
  const page = new PageWithRows({ broken: ['https://example.com/row/0-1'] });
  const result = await runScenario(page, parseScenario(withDetail));

  assert.equal(result.status, 'ok', 'one bad page does not break the run');
  assert.equal(result.rows[0].pay, 'pay for 0-0');
  assert.equal(result.rows[1].pay, undefined);
  assert.equal(result.rows[1].title, 'row 0.1', 'what the list gave it is still there');
});

test('a deeper field that is empty in every row is a rotted field, not a quiet gap', async () => {
  const page = new PageWithRows();
  page.evaluate = async function (fn, argument) {
    if (fn.includes('blocksSeen') && this.where !== 'list') return { rows: [{ pay: null }], blocksSeen: 1, missing: { pay: 1 } };
    return PageWithRows.prototype.evaluate.call(this, fn, argument);
  };
  const result = await runScenario(page, parseScenario(withDetail));

  assert.equal(result.status, 'broken');
  assert.match(result.reason, /"pay"/);
});

test('a detail rule that follows a column the list never collects is refused at parse time', () => {
  assert.throws(
    () => parseScenario({ ...withDetail, detail: { follow: 'nowhere', fields: { pay: { type: 'text' } }, maxRows: 5 } }),
    /detail.follow names "nowhere"/,
  );
});
