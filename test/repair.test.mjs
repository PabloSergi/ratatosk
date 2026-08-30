import assert from 'node:assert/strict';
import { test } from 'vitest';
import { buildScenario, repairScenario } from '../src/index.ts';

/**
 * A page that can be made to rot on purpose: it answers only for the selectors it currently has,
 * and reports through `look` whatever structure it has now.
 */
class FakeSite {
  constructor({ rows, values, count = 6, candidates = [], controls = [] }) {
    Object.assign(this, { rows, values, count, candidates, controls });
  }
  async goto() {}
  async currentUrl() { return 'https://example.com/list'; }
  async waitMs() {}
  async click() {}
  async evaluate(fn, arg) {
    if (fn.includes('sketchCandidates')) {
      return { url: 'https://example.com/list', title: 'list', candidates: this.candidates, pagination: { kind: 'none' }, notes: [] };
    }
    if (fn.includes('blocksSeen')) {
      const list = arg;
      if (list.rows !== this.rows) return { rows: [], blocksSeen: 0, missing: {} };
      const rows = [];
      const missing = {};
      for (let i = 0; i < this.count; i++) {
        const row = {};
        let usable = false;
        for (const [name, rule] of Object.entries(list.fields)) {
          const value = this.values[rule.selector] ? `${this.values[rule.selector]} ${i}` : null;
          if (value === null) {
            if (!rule.optional) missing[name] = (missing[name] ?? 0) + 1;
            row[name] = null;
          } else {
            row[name] = value;
            usable = true;
          }
        }
        if (usable) rows.push(row);
      }
      return { rows, blocksSeen: this.count, missing };
    }
    if (fn.includes('querySelectorAll(selector).length')) return arg === this.rows ? this.count : 0;
    if (fn.includes('blocks.length')) return `${this.count}|page`;
    if (fn.includes('document.querySelector(selector)')) return this.controls.includes(arg);
    return null;
  }
}

const slow = (scenario) => ({ ...scenario, wait: { ...scenario.wait, timeoutMs: 300, settleMs: 0 } });

const robot = slow(buildScenario({
  name: 'jobs',
  url: 'https://example.com/list',
  rows: '.old-card',
  fields: {
    title: { type: 'text', selector: 'h5.title' },
    url: { type: 'attr', selector: 'a', attr: 'href', absolute: true },
  },
  pagination: { type: 'none' },
  minRowsPerPage: 2,
}));

test('a robot that still works is left alone', async () => {
  const site = new FakeSite({ rows: '.old-card', values: { 'h5.title': 'Job', a: '/job' } });
  const result = await repairScenario(site, robot);
  assert.equal(result.status, 'not-needed');
  assert.deepEqual(result.diff, []);
});

test('a renamed row class is found and the fields are kept', async () => {
  const site = new FakeSite({
    rows: '.new-card',
    values: { 'h5.title': 'Job', a: '/job' },
    candidates: [{ selector: '.new-card', count: 6, fields: [{ role: 'title', selector: 'h5.title' }, { role: 'link', selector: 'a' }] }],
  });
  const result = await repairScenario(site, robot);
  assert.equal(result.status, 'repaired');
  assert.equal(result.scenario.list.rows, '.new-card');
  assert.deepEqual(Object.keys(result.scenario.list.fields), ['title', 'url']);
  assert.ok(result.diff.some((line) => line.includes('rows: ".old-card" → ".new-card"')));
  assert.equal(result.after.rows.length, 6);
});

test('a dead field is replaced by role and the column keeps its name', async () => {
  const site = new FakeSite({
    rows: '.old-card',
    values: { h3: 'Job', a: '/job' },
    candidates: [{ selector: '.old-card', count: 6, fields: [{ role: 'title', selector: 'h3' }, { role: 'link', selector: 'a' }] }],
  });
  const result = await repairScenario(site, robot);
  assert.equal(result.status, 'repaired');
  assert.equal(result.scenario.list.fields.title.selector, 'h3');
  assert.ok(result.diff.some((line) => line.includes('field "title": h5.title → h3')));
});

test('a field with no replacement is dropped out loud, not silently', async () => {
  const site = new FakeSite({
    rows: '.old-card',
    values: { a: '/job' },
    candidates: [{ selector: '.old-card', count: 6, fields: [{ role: 'link', selector: 'a' }] }],
  });
  const result = await repairScenario(site, robot);
  assert.equal(result.status, 'repaired');
  assert.ok(!('title' in result.scenario.list.fields));
  assert.ok(result.diff.some((line) => line.includes('field "title"') && line.includes('dropped')));
});

test('a page with nothing on it is unfixable, and says why', async () => {
  const site = new FakeSite({ rows: '.gone', values: {}, count: 0, candidates: [] });
  const result = await repairScenario(site, robot);
  assert.equal(result.status, 'unfixable');
  assert.match(result.reason, /nothing on https:\/\/example\.com\/list looks like the old rows/);
  assert.equal(result.before.status, 'broken');
});

/**
 * A repair rebuilds the scenario, and a rebuilt object keeps only what somebody remembered to copy.
 * These two are the ones that fail silently: a robot that starts going out from the wrong address, and
 * a robot that quietly stops collecting the column that lived one page deeper.
 */
test('a repaired robot keeps the way out it was built through', async () => {
  const bound = { ...robot, proxy: 'f77737ab' };
  const site = new FakeSite({
    rows: '.old-card',
    values: { h3: 'Job', a: '/job' },
    candidates: [{ selector: '.old-card', count: 6, fields: [{ role: 'title', selector: 'h3' }, { role: 'link', selector: 'a' }] }],
  });

  const result = await repairScenario(site, bound);
  assert.equal(result.status, 'repaired');
  assert.equal(result.scenario.proxy, 'f77737ab', 'a robot bound to an address must stay bound to it');
});

test('a repaired robot keeps walking into rows', async () => {
  const deep = { ...robot, detail: { follow: 'url', fields: { pay: { type: 'text', selector: '.pay', optional: true } }, maxRows: 10 } };
  const site = new FakeSite({
    rows: '.old-card',
    values: { h3: 'Job', a: '/job' },
    candidates: [{ selector: '.old-card', count: 6, fields: [{ role: 'title', selector: 'h3' }, { role: 'link', selector: 'a' }] }],
  });

  const result = await repairScenario(site, deep);
  assert.equal(result.status, 'repaired');
  assert.deepEqual(result.scenario.detail, deep.detail, 'the deeper walk is not a decoration to drop');
});
