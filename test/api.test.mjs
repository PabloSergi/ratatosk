import assert from 'node:assert/strict';
import { test } from 'vitest';

import { readRow, runApiRobot } from '../src/api.ts';

/**
 * The failure this exists for: a board refuses to page past ten thousand AND reports its total as ten
 * thousand, so a naive walk returns exactly ten thousand rows, no error, and a quarter of the board
 * missing. It looks like success, which is what makes it worth a test.
 */
const CAP = 10_000;

/** A board that behaves the way the real one does: inclusive range, clamped total, hard offset cap. */
function board(count) {
  const all = Array.from({ length: count }, (_, index) => ({
    id: `ad-${index}`,
    price: index,
    subject: `listing ${index}`,
    thumbs: [{ url: `https://pics/${index}-a.jpg` }, { url: `https://pics/${index}-b.jpg` }],
  }));

  let asked = 0;
  const ask = async (href) => {
    asked++;
    const url = new URL(href);
    const range = url.searchParams.get('price');
    const [from, to] = range ? range.split('-').map(Number) : [0, Number.MAX_SAFE_INTEGER];
    const matching = all.filter((one) => one.price >= from && one.price <= to);
    const offset = Number(url.searchParams.get('o') ?? 0);
    const size = Number(url.searchParams.get('limit') ?? 50);
    return {
      total: Math.min(matching.length, CAP),
      ads: offset >= CAP ? [] : matching.slice(offset, offset + size),
    };
  };
  return { ask, calls: () => asked };
}

const robot = (window) => ({
  name: 'board',
  version: 1,
  source: 'api',
  url: 'https://example.test/v1/ads',
  rowsAt: 'ads',
  totalAt: 'total',
  page: { param: 'o', sizeParam: 'limit', size: 50 },
  identity: 'id',
  fields: { id: 'id', price: 'price', title: 'subject', pics: 'thumbs[].url' },
  ...(window ? { window } : {}),
});

test('a board that hides everything past ten thousand is still read whole', async () => {
  const source = board(12_500);

  const run = await runApiRobot(robot({ param: 'price', from: 0, to: 20_000, cap: CAP }), source.ask);

  assert.equal(run.rows.length, 12_500, 'the clamped total is a floor, not a count — cut the window and keep going');
  assert.equal(new Set(run.rows.map((row) => row.id)).size, 12_500, 'and every row is itself, once');
});

test('without a window, a capped board quietly returns a tenth of itself', async () => {
  // The same board, read the naive way. This is not a wish — it is what the cap does, and the reason
  // the window exists at all.
  const source = board(12_500);

  const run = await runApiRobot(robot(undefined), source.ask);
  assert.equal(run.rows.length, CAP);
});

test('the two halves share a boundary, and the row on it is kept once', async () => {
  const source = board(400);

  const run = await runApiRobot(robot({ param: 'price', from: 0, to: 400, cap: 150 }), source.ask);

  assert.equal(run.rows.length, 400, 'an inclusive range double-counts its edge unless rows are keyed by id');
  assert.equal(new Set(run.rows.map((row) => row.id)).size, 400);
});

test('a window one wide that still will not fit says so instead of pretending', async () => {
  // Every row at the same price: cutting cannot help, and the honest answer is to take what the board
  // gives and name what is left behind.
  const all = Array.from({ length: 300 }, (_, index) => ({ id: `x-${index}`, price: 7, subject: 's' }));
  const ask = async (href) => {
    const url = new URL(href);
    const offset = Number(url.searchParams.get('o') ?? 0);
    const size = Number(url.searchParams.get('limit') ?? 50);
    return { total: Math.min(all.length, 100), ads: offset >= 100 ? [] : all.slice(offset, offset + size) };
  };

  const run = await runApiRobot(robot({ param: 'price', from: 7, to: 8, cap: 100 }), ask);
  assert.match(run.reason ?? '', /unreachable/);
  assert.equal(run.rows.length, 100, 'what it did give is still handed over');
});

test('a row comes out flat, whatever shape the feed had', () => {
  const row = readRow(
    { id: 5, price: 0, subject: '', thumbs: [{ url: 'a' }, { url: 'b' }], deep: { kept: { name: 'x' } } },
    { id: 'id', price: 'price', title: 'subject', pics: 'thumbs[].url', who: 'deep.kept.name', gone: 'nothing.here' },
  );

  assert.equal(row.id, '5', 'numbers become text: a row is text, and zero is not nothing');
  assert.equal(row.price, '0');
  assert.equal(row.title, null, 'an empty string is nothing to hand over');
  assert.equal(row.pics, '["a","b"]', 'a list of pictures survives as a list, for whoever unpacks it');
  assert.equal(row.who, 'x');
  assert.equal(row.gone, null);
});

/**
 * A list is built to be cheap and wide, so it leaves things out. What it leaves out is often what
 * decides the thing — the deposit, the number of bathrooms, when the advert first went up as opposed
 * to when it was last pushed back to the top.
 */
test('what the list will not say is asked for one row at a time', async () => {
  const { deepen } = await import('../src/api.ts');

  const asked = [];
  const ask = async (href) => {
    asked.push(href);
    const id = href.split('/').pop();
    return { ad: { deposit: Number(id) * 2, toilets: 2, orig_list_time: 1789000000000 } };
  };

  const rows = [{ id: '11', price: '100' }, { id: '22', price: '200' }];
  const done = await deepen(rows, {
    url: 'https://example.test/v1/ads/{id}',
    fields: { deposit: 'ad.deposit', toilets: 'ad.toilets', posted_at: 'ad.orig_list_time' },
  }, ask);

  assert.deepEqual(asked, ['https://example.test/v1/ads/11', 'https://example.test/v1/ads/22']);
  assert.equal(done.rows[0].deposit, '22', 'the deeper answer is merged onto the row it belongs to');
  assert.equal(done.rows[1].toilets, '2');
  assert.equal(done.rows[0].price, '100', 'and what the list already said is left alone');
  assert.equal(done.calls, 2);
});

test('a row that will not deepen keeps what the list gave it', async () => {
  const { deepen } = await import('../src/api.ts');

  const ask = async (href) => {
    if (href.endsWith('22')) throw new Error('502');
    return { ad: { deposit: 7 } };
  };
  const rows = [{ id: '11', price: '100' }, { id: '22', price: '200' }];
  const done = await deepen(rows, { url: 'https://example.test/{id}', fields: { deposit: 'ad.deposit' } }, ask);

  assert.equal(done.rows[0].deposit, '7');
  assert.equal(done.rows[1].deposit, undefined, 'nothing invented where the source refused');
  assert.equal(done.rows[1].price, '200');
});

test('the cap is real: a board is not deepened row by row for ever', async () => {
  const { deepen } = await import('../src/api.ts');
  let calls = 0;
  const ask = async () => { calls++; return { ad: { deposit: 1 } }; };

  const rows = Array.from({ length: 50 }, (_, index) => ({ id: String(index) }));
  await deepen(rows, { url: 'https://example.test/{id}', fields: { deposit: 'ad.deposit' }, maxRows: 10 }, ask);
  assert.equal(calls, 10);
});
