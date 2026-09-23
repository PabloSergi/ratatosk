import assert from 'node:assert/strict';
import { test } from 'vitest';
import { revise } from '../src/alive.ts';

/**
 * The revision, without a browser: what matters here is the verdict, not the fetching.
 *
 * Three answers and three meanings. Still there, gone, and — the one that must not be confused with
 * gone — no answer at all: a timeout or a network that blinked says nothing about the posting, and
 * treating it as gone is how a catalogue empties itself over a bad afternoon.
 */
class Site {
  constructor(pages) {
    this.pages = pages;
    this.asked = [];
    this.waited = 0;
  }
  async goto() {}
  async currentUrl() { return 'https://board.test/'; }
  async click() {}
  async waitMs(ms) { this.waited += ms; }
  async evaluate(source, argument) {
    if (!source.includes('fetch')) return null;
    this.asked.push(argument.url);
    const body = this.pages[argument.url];
    if (body === undefined) throw new Error('the network blinked');
    return { ok: true, gone: new RegExp(argument.gone, 'i').test(body) };
  }
}

const rule = { url: 'https://board.test/item/{id}', gone: "isn't available|has been removed", pace: 10 };

test('what answers for itself is still there, what says it is gone is gone', async () => {
  const site = new Site({
    'https://board.test/item/1': '<title>A flat</title> Property to rent',
    'https://board.test/item/2': "<title>Board</title> This content isn't available",
  });

  const revision = await revise(site, rule, ['1', '2']);

  assert.deepEqual(revision.alive, ['1']);
  assert.deepEqual(revision.gone, ['2']);
  assert.deepEqual(revision.unclear, []);
  assert.equal(site.waited, 20, 'and it waits between questions, because a revision is not an emergency');
});

test('a posting that could not be asked about is not reported as gone', async () => {
  const site = new Site({ 'https://board.test/item/1': 'A flat' });

  const revision = await revise(site, rule, ['1', '2']);

  assert.deepEqual(revision.alive, ['1']);
  assert.deepEqual(revision.gone, [], 'nothing is buried on the strength of a failed request');
  assert.deepEqual(revision.unclear, ['2']);
});

test('an id is put into the address, whatever it looks like', async () => {
  const site = new Site({ 'https://board.test/item/a%2Fb': 'A flat' });

  const revision = await revise(site, rule, ['a/b']);

  assert.deepEqual(revision.alive, ['a/b']);
  assert.deepEqual(site.asked, ['https://board.test/item/a%2Fb']);
});
