import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'vitest';

import { identity, identityOfMessage, meet, readMemory, sameRowInThisRun, writeMemory } from '../src/memory.ts';

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

/**
 * The tail rule cuts both ways, and the wrong side of it loses data. Between runs, a scrap on the end
 * is somebody bumping their posting. Within one walk nobody bumped anything, and two rows that differ
 * by their last word are two rows — "Room 1" and "Room 2" is the whole of the argument.
 */
test('a short row is identified by all of it, tail included', () => {
  const one = identity(posting('Room 1 available now'));
  const other = identity(posting('Room 2 available now'));
  assert.notEqual(one, other, 'the number is what the row is about, not a bump');
});

test('a long posting still survives a bump on the end', () => {
  const long = 'Looking for a chat operator for the evening shift, 60% of takings, training provided. ';
  assert.equal(
    identity(posting(long)),
    identity(posting(`${long} UP`)),
    'on a real posting the tail carries nothing',
  );
});

test('within one run, nothing is forgiven on the end', () => {
  const long = 'Looking for a chat operator for the evening shift, 60% of takings, training provided. ';
  assert.notEqual(
    sameRowInThisRun(posting(long)),
    sameRowInThisRun(posting(`${long} UP`)),
    'nobody bumped a posting between page one and page two',
  );

  // …and the same row, twice on the same walk, is still the same row.
  assert.equal(sameRowInThisRun(posting(long)), sameRowInThisRun(posting(long)));
  assert.equal(
    sameRowInThisRun(posting('anything', 'https://example.com/1')),
    sameRowInThisRun(posting('rewritten', 'https://example.com/1')),
    'a link settles it, here as everywhere',
  );
});

/**
 * A channel is not a job board.
 *
 * On a board a posting keeps its address, and the link is the honest key. In a channel the address
 * belongs to the message: the same advert pushed out again tomorrow arrives as a new message with a
 * new number and a new link, and a memory keyed on either lets a daily reposter through daily.
 */
const message = (text, id) => ({ id, date: '2026-09-06T04:00:00.000Z', link: `https://t.me/jobs/${id}`, text, channel: 'jobs' });

test('the same advert posted again tomorrow is the same advert, whatever number the message got', () => {
  const today = message('Looking for a chat operator for evening shifts, 60% of takings, start immediately', '101');
  const tomorrow = message('Looking for a chat operator for evening shifts, 60% of takings, start immediately', '742');

  assert.notEqual(identity(today), identity(tomorrow), 'by its address it is a different message — and that is the trap');
  assert.equal(identityOfMessage(today), identityOfMessage(tomorrow), 'by what it says it is the advert we already handed over');

  const first = meet([today], {}, {}, new Date('2026-09-06T04:00:00Z'), identityOfMessage);
  const second = meet([tomorrow], first.memory, {}, new Date('2026-09-07T04:00:00Z'), identityOfMessage);
  assert.equal(second.fresh.length, 0);
  assert.equal(second.repeated.length, 1);
});

test('two different jobs in one channel stay two, and a named column still wins', () => {
  const one = message('Chat operator wanted for the evening shift in Madrid, 60% of takings', '101');
  const other = message('Content manager wanted, mornings, Valencia, 1800 a month, no experience needed', '102');
  assert.notEqual(identityOfMessage(one), identityOfMessage(other));

  // Somebody who says which column identifies their source knows their source; that is not overruled.
  assert.equal(identityOfMessage(one, 'id'), identityOfMessage({ ...one, text: 'rewritten' }, 'id'));
});

test('a channel watched for events can ask for per-message identity back', () => {
  // Identifying a post by what it says is a default, not a decision taken away: someone watching a
  // channel where the same words twice mean twice says so, and gets exactly the old behaviour.
  const said = 'the gate is open';
  const first = meet([message(said, '101')], {}, { by: 'link' }, new Date('2026-09-06T04:00:00Z'), identityOfMessage);
  const again = meet([message(said, '742')], first.memory, { by: 'link' }, new Date('2026-09-07T04:00:00Z'), identityOfMessage);

  assert.equal(again.fresh.length, 1, 'a second message is a second event, whatever it repeats');
  assert.equal(again.repeated.length, 0);
});

/**
 * The other half of a board: not what is new, but what is no longer there. A let flat never announces
 * itself — it simply stops appearing, and the memory is the only thing that noticed.
 */
test('what stopped appearing is answerable without opening anything', async () => {
  const { meet, vanished } = await import('../src/memory.ts');
  const rule = { by: 'id' };

  const monday = meet([{ id: '1' }, { id: '2' }, { id: '3' }], {}, rule, new Date('2026-09-10T08:00:00Z'));
  // Tuesday the second flat is gone from the board.
  const tuesday = meet([{ id: '1' }, { id: '3' }], monday.memory, rule, new Date('2026-09-11T08:00:00Z'));

  const gone = vanished(tuesday.memory, '2026-09-11T07:00:00Z');
  assert.deepEqual(gone.map((one) => one.id), ['2']);
  assert.equal(gone[0].times, 1, 'and how many times it had been seen before it went');
});

test('a row identified by its own words has no id to report as gone', async () => {
  const { meet, vanished } = await import('../src/memory.ts');

  const before = meet([posting('Looking for a chat operator for evening shifts, 60% of takings')], {}, {},
    new Date('2026-09-10T08:00:00Z'));

  // Nothing is claimed rather than a fingerprint handed back as if it were an address.
  assert.deepEqual(vanished(before.memory, '2026-09-11T08:00:00Z'), []);
});
