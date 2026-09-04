import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'vitest';

import { identity, meet, readMemory, writeMemory } from '../src/memory.ts';

/**
 * The failure this exists for: a bot reposts the same advertisement every ten minutes, and by the end
 * of a week the table is a thousand copies of the same eleven postings.
 */
const posting = (text, link) => ({ text, ...(link ? { link } : {}) });

test('the same posting reposted is not new, however many times it comes', () => {
  const message = posting('Looking for a chat operator for evening shifts, 60% of takings');
  const first = meet([message], {}, {}, new Date('2026-08-27T10:00:00Z'));

  assert.equal(first.fresh.length, 1, 'the first time it is news');
  assert.equal(first.repeated.length, 0);

  const again = meet([message], first.memory, {}, new Date('2026-08-27T10:10:00Z'));
  assert.equal(again.fresh.length, 0, 'ten minutes later it is the same posting');
  assert.equal(again.repeated[0].times, 2);
  assert.equal(again.repeated[0].firstSeen, '2026-08-27T10:00:00.000Z', 'and it remembers when it first came');

  const later = meet([message], again.memory, {}, new Date('2026-08-27T14:00:00Z'));
  assert.equal(later.fresh.length, 0);
  assert.equal(later.repeated[0].times, 3);
});

test('a repost that was fiddled with is still the same posting', () => {
  const before = meet([posting('🔥 Looking for a chat operator, 60% of takings 🔥')], {}, {}, new Date('2026-08-27T10:00:00Z'));
  const after = meet(
    [posting('Looking     for a chat operator, 60% of takings!!! ⌨️⌨️  UP')],
    before.memory,
    {},
    new Date('2026-08-27T12:00:00Z'),
  );

  assert.equal(after.fresh.length, 0, 'emoji, spacing and an appended "UP" do not make it new');
});

test('and the limit of that, said plainly', () => {
  // Emoji, spacing and a two-letter bump are handled. A whole word appended to a short message is not:
  // it could as easily be an edit that matters. On a long posting it changes nothing, because the
  // identity is taken from the first two hundred characters.
  const short = meet([posting('Looking for a chat operator, 60%')], {}, {});
  const worded = meet([posting('Looking for a chat operator, 60% still open')], short.memory, {});
  assert.equal(worded.fresh.length, 1, 'a short message plus a word is treated as a new one');

  const long = 'Looking for a chat operator for the evening shift. '.repeat(9);
  const first = meet([posting(long)], {}, {});
  const bumped = meet([posting(`${long} still open, write in a direct message`)], first.memory, {});
  assert.equal(bumped.fresh.length, 0, 'on a real posting the tail changes nothing');
});

test('a different posting is a different posting', () => {
  const first = meet([posting('Looking for a chat operator for evening shifts')], {}, {});
  const second = meet([posting('Looking for an operator in Madrid, from 80 000 a year')], first.memory, {});
  assert.equal(second.fresh.length, 1);
});

test('a link is the identity when there is one', () => {
  const key = identity(posting('anything at all here', 'https://example.com/jobs/42'));
  assert.equal(key, 'k:https://example.com/jobs/42');

  // The same posting with the text edited keeps its address, so it is still the same posting.
  const edited = identity(posting('the text was rewritten entirely', 'https://example.com/jobs/42'));
  assert.equal(edited, key);
});

test('a column can be named as the identity, for a source that has an id of its own', () => {
  const rows = [{ id: '7', text: 'first version' }];
  const first = meet(rows, {}, { by: 'id' });
  const second = meet([{ id: '7', text: 'completely rewritten' }], first.memory, { by: 'id' });
  assert.equal(second.fresh.length, 0, 'the id says it is the same thing');
});

test('a row with nothing to remember it by is always new, rather than wrongly merged', () => {
  const thin = meet([{ text: 'up' }, { text: '+' }], {}, {});
  assert.equal(thin.fresh.length, 2, 'two words are not an identity');
});

test('what has not been seen for a long time is forgotten, because it is news again', () => {
  const old = { 'h:whatever': { firstSeen: '2026-01-01T00:00:00Z', lastSeen: '2026-01-01T00:00:00Z', times: 4 } };
  const now = meet([], old, { days: 30 }, new Date('2026-08-27T00:00:00Z'));

  assert.equal(now.forgotten, 1);
  assert.deepEqual(now.memory, {}, 'a memory that only grows eventually costs more than the scraping');
});

test('a memory survives being written down and read back', async () => {
  const file = join(await mkdtemp(join(tmpdir(), 'ratatosk-memory-')), 'robot.json');
  assert.deepEqual(await readMemory(file), {}, 'a robot that has never run remembers nothing');

  const seen = meet([posting('Looking for a chat operator for evening shifts, 60% of takings')], {}, {});
  await writeMemory(file, seen.memory);

  const back = await readMemory(file);
  const again = meet([posting('Looking for a chat operator for evening shifts, 60% of takings')], back, {});
  assert.equal(again.fresh.length, 0, 'yesterday is remembered today');
});

test('two postings that merely open alike are still two postings', () => {
  // The cost of taking the identity from the beginning, stated out loud: a source whose postings share
  // a long opening template needs a column of its own as the identity.
  const head = 'An agency is hiring for permanent positions, full time, training at our expense. ';
  const first = meet([{ text: `${head} Position: chat operator, Madrid, 80 000` }], {}, {});
  const second = meet([{ text: `${head} Position: operator, Valencia, 60 000` }], first.memory, {});

  assert.equal(second.fresh.length, 1, 'the part that differs is inside the first two hundred characters');
});
