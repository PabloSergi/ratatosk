import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, test } from 'vitest';

/**
 * The failure this exists for, and it is a quiet one.
 *
 * A scraper that remembers hands over only what is new. Its journal of runs is therefore a journal of
 * increments, and anyone reconstructing the source by adding those runs together gets the right answer
 * only until the oldest one ages out — after which a source of eleven thousand reads as a source of
 * fifty, with no error anywhere, and whatever tidies up behind it deletes the rest.
 */
let store;
beforeEach(async () => {
  delete process.env.RATATOSK_DB;
  store = await mkdtemp(join(tmpdir(), 'ratatosk-catalogue-'));
  process.env.RATATOSK_CATALOGUE = store;
});

const load = async () => import('../src/catalogue.ts');
const listing = (id, price) => ({ id, price: String(price), title: `flat ${id}` });

test('the source is what the last pass saw, not what it handed over', async () => {
  const { keepSeen, catalogueOf } = await load();

  // Monday: the whole board is new, so the run hands over all three.
  await keepSeen('u1', 'flats', [listing('1', 100), listing('2', 200), listing('3', 300)], 'id', '2026-09-10T08:00:00Z');
  // Tuesday: only one listing is new, and that is all the run returns — but the source still has three.
  await keepSeen('u1', 'flats', [listing('1', 100), listing('2', 200), listing('3', 300), listing('4', 400)], 'id', '2026-09-11T08:00:00Z');

  const listed = await catalogueOf('u1', 'flats');
  assert.equal(listed.length, 4, 'источник целиком, а не приращение последнего прогона');
  assert.deepEqual(listed.map((one) => one.id), ['1', '2', '3', '4']);
});

test('a row keeps the day it was first listed, however often it is seen again', async () => {
  const { keepSeen, catalogueOf } = await load();

  await keepSeen('u1', 'flats', [listing('1', 100)], 'id', '2026-09-10T08:00:00Z');
  await keepSeen('u1', 'flats', [listing('1', 90)], 'id', '2026-09-12T08:00:00Z');

  const [one] = await catalogueOf('u1', 'flats');
  assert.equal(one.firstSeen, '2026-09-10T08:00:00Z', 'сколько объявление уже висит — это первый раз');
  assert.equal(one.lastSeen, '2026-09-12T08:00:00Z');
  assert.equal(one.row.price, '90', 'а сама строка — последняя известная');
});

test('what the pass did not see is gone, and says when it was last there', async () => {
  const { keepSeen, goneFrom } = await load();

  await keepSeen('u1', 'flats', [listing('1', 100), listing('2', 200)], 'id', '2026-09-10T08:00:00Z');
  // The second flat has been let: this pass does not see it.
  await keepSeen('u1', 'flats', [listing('1', 100)], 'id', '2026-09-11T08:00:00Z');

  const gone = await goneFrom('u1', 'flats', '2026-09-11T08:00:00Z');
  assert.deepEqual(gone.map((one) => one.id), ['2']);
  assert.equal(gone[0].lastSeen, '2026-09-10T08:00:00Z');
});

test('a row with nothing to be identified by is not catalogued at all', async () => {
  const { keepSeen, catalogueOf } = await load();

  const kept = await keepSeen('u1', 'flats', [{ id: null, title: 'no id' }, listing('7', 700)], 'id');
  assert.equal(kept, 1, 'строка без опознавательного столбца не выдумывается');
  assert.deepEqual((await catalogueOf('u1', 'flats')).map((one) => one.id), ['7']);
});

test('a large source is answered in pages, and the pages join up', async () => {
  const { keepSeen, catalogueOf } = await load();
  await keepSeen('u1', 'flats', Array.from({ length: 25 }, (_, n) => listing(String(100 + n), n)), 'id');

  const first = await catalogueOf('u1', 'flats', { limit: 10 });
  const second = await catalogueOf('u1', 'flats', { limit: 10, after: first[first.length - 1].id });

  assert.equal(first.length, 10);
  assert.equal(second.length, 10);
  assert.equal(new Set([...first, ...second].map((one) => one.id)).size, 20, 'страницы не пересекаются');
});

test('a scraper that goes takes its catalogue with it', async () => {
  const { keepSeen, catalogueOf, forgetCatalogue } = await load();
  await keepSeen('u1', 'flats', [listing('1', 100)], 'id');
  await forgetCatalogue('u1', 'flats');
  assert.deepEqual(await catalogueOf('u1', 'flats'), []);
});

/**
 * The same mistake three times, so it gets a test.
 *
 * A run is written into the journal when it finishes and into the catalogue when it starts. Measuring
 * "gone" from the journal's timestamp therefore marks every row the run just saw as missing — the
 * whole source vanishing at once, silently, and whatever cleans up behind it deleting all of it.
 */
test('the boundary for what is gone comes from the catalogue, not from another clock', async () => {
  const { keepSeen, goneFrom, lastPassOf } = await load();

  // The pass began at 08:00 and its rows are stamped so. The journal will stamp it 08:06, when it ended.
  await keepSeen('u1', 'flats', [listing('1', 100), listing('2', 200)], 'id', '2026-09-13T08:00:00Z');

  const boundary = await lastPassOf('u1', 'flats');
  assert.equal(boundary, '2026-09-13T08:00:00Z', 'граница — когда каталог в последний раз писали');
  assert.deepEqual(await goneFrom('u1', 'flats', boundary), [], 'то, что проход только что видел, не пропало');

  // …whereas the journal's own timestamp would have condemned both rows.
  assert.equal((await goneFrom('u1', 'flats', '2026-09-13T08:06:00Z')).length, 2);
});
