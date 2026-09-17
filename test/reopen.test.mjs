import assert from 'node:assert/strict';
import { test } from 'vitest';
import { runRobot } from '../src/run-robot.ts';

/**
 * A page opened twice is a page paid for twice.
 *
 * The walk into rows is one page load per row, and a list read every couple of hours is mostly rows
 * that were read last time. What the scraper already remembers must not be opened again — and what it
 * has never seen must be, or the new listing arrives without the half of it that lives one page in.
 */
class Board {
  constructor() {
    this.opened = [];
    this.at = 'https://board.test/list';
  }
  async goto(url) {
    this.at = url;
    if (url.includes('/item/')) this.opened.push(url);
  }
  async currentUrl() { return this.at; }
  async click() {}
  async waitMs() {}
  async evaluate(source, argument) {
    if (source.includes('querySelectorAll(selector).length')) return 5;
    if (source.includes('blocksSeen')) {
      if (argument?.rows === 'html') {
        // The page one level in: where the description lives.
        return { rows: [{ body: `the whole of ${this.at}` }], blocksSeen: 1, missing: {} };
      }
      return {
        rows: [
          { link: 'https://board.test/item/1' },
          { link: 'https://board.test/item/2' },
        ],
        blocksSeen: 2,
        missing: {},
      };
    }
    if (source.includes('document.querySelector(selector)')) return false;
    if (source.includes('blocks.length')) return { count: 2, texts: ['one', 'two'] };
    return null;
  }
}

const robot = {
  name: 'board',
  version: 1,
  url: 'https://board.test/list',
  wait: { selector: '.card', minCount: 1, timeoutMs: 300, settleMs: 0 },
  list: { rows: '.card', fields: { link: { type: 'attr', attr: 'href' } } },
  pagination: { type: 'none' },
  expect: { minRowsPerPage: 1 },
  detail: { follow: 'link', maxRows: 40, fields: { body: { type: 'text', selector: '.body' } } },
  remember: { mode: 'new', by: 'link', days: 30 },
};

function memoryOf(seen = {}) {
  const held = { seen, save: async (next) => { held.seen = next; } };
  return held;
}

test('a row the scraper already remembers is not opened again', async () => {
  const board = new Board();
  const memory = memoryOf();

  const first = await runRobot(robot, { page: async () => board, memory });
  assert.equal(first.status, 'ok');
  assert.deepEqual(board.opened, ['https://board.test/item/1', 'https://board.test/item/2'], 'the first pass reads both');
  assert.equal(first.rows.length, 2);
  assert.ok(first.rows[0].body, 'and brings back what is one page in');

  // Second pass, same board: one row is now known, the other is not.
  board.opened.length = 0;
  memory.seen = { ...memory.seen };
  delete memory.seen[Object.keys(memory.seen).find((key) => key.includes('item/2'))];

  const second = await runRobot(robot, { page: async () => board, memory });
  assert.deepEqual(board.opened, ['https://board.test/item/2'], 'only the one it does not know');
  assert.ok(second.reason?.includes('not opened again'), `the run says so: ${second.reason}`);
});
