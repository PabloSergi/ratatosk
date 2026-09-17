import assert from 'node:assert/strict';
import { afterAll, beforeEach, test } from 'vitest';

/**
 * The catalogue against a real Postgres, for the one thing the file store cannot fail at.
 *
 * A walk sees the same posting twice — a pinned card, a list that shifts, a link stamped with tracking
 * so the two sightings are not even the same string. Written as two lines in one statement, Postgres
 * refuses the whole thing ("ON CONFLICT DO UPDATE command cannot affect row a second time"), and the
 * pass is lost at its final step. Two and a half hours of walking were lost that way once.
 */
const url = process.env.RATATOSK_DB;
const when = url ? test : test.skip;

const load = async () => import('../src/catalogue.ts');
const account = `test-${process.pid}`;

beforeEach(async () => {
  if (!url) return;
  const { forgetCatalogue } = await load();
  await forgetCatalogue(account, 'flats');
});

afterAll(async () => {
  if (!url) return;
  const { forgetCatalogue } = await load();
  await forgetCatalogue(account, 'flats');
  const { closeDb } = await import('../src/db.ts');
  await closeDb();
});

when('one posting seen twice in a pass is one line in the catalogue', async () => {
  const { keepSeen, catalogueOf } = await load();

  const kept = await keepSeen(
    account,
    'flats',
    [
      { id: '7', link: 'https://board.test/7?ref=feed&tracking=aaa', price: '100' },
      { id: '8', link: 'https://board.test/8', price: '200' },
      // The same posting again, met later in the same walk: another link, the same flat, a newer price.
      { id: '7', link: 'https://board.test/7?ref=search&tracking=bbb', price: '120' },
    ],
    'id',
    '2026-09-17T08:00:00Z',
  );

  assert.equal(kept, 2, 'two postings were seen, however many times each was met');

  const held = await catalogueOf(account, 'flats', { limit: 10 });
  assert.deepEqual(held.map((one) => one.id).sort(), ['7', '8']);
  assert.equal(held.find((one) => one.id === '7').row.price, '120', 'the last sighting is the one kept');
});
