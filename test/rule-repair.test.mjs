import assert from 'node:assert/strict';
import { test } from 'vitest';

import { repairRule } from '../src/rule-repair.ts';

/**
 * Selectors rot when a site changes its markup; rules rot when people change how they write. Both
 * fail the same way — quietly — so both have to be measured against what the source says today, not
 * against what it said when somebody wrote the rule.
 */
const TODAY = [
  { text: 'We are looking for a designer, 60% of takings' },
  { text: 'Operator needed, remote, from 80 000 a year' },
  { text: 'Need a chat operator for the evening shift' },
  { text: 'Looking for work as a chat operator, two years of experience' },
  { text: 'Selling an account with a subscriber base' },
  { text: 'up' },
];

/** A model that answers each kind of question the repair asks. */
const model = ({ wrong = [], missed = [], rules = [] } = {}) => {
  const asked = [];
  let looked = 0;
  const ask = async (messages) => {
    const last = messages[messages.length - 1].content;
    asked.push(last);
    // Two questions, opposite directions: what was kept wrongly, and what was thrown away wrongly.
    // The complaint applies to the rule as it was — the rewritten one is judged on its own.
    if (/DO match it/.test(last)) return { content: JSON.stringify({ wrong: looked++ === 0 ? missed : [] }) };
    if (/do NOT match/i.test(last)) return { content: JSON.stringify({ wrong }) };
    return { content: rules.shift() ?? '{}' };
  };
  ask.asked = asked;
  return ask;
};

test('a rule that still holds is left alone', async () => {
  const repair = await repairRule({
    rows: TODAY,
    sift: { want: 'job postings', keep: ['we are looking for', 'needed', 'need a'], drop: ['looking for work', 'selling'] },
    ask: model(),
  });

  assert.equal(repair.status, 'not-needed');
  assert.deepEqual(repair.diff, []);
  assert.equal(repair.before.good, true);
  assert.equal(repair.before.kept, 3);
});

test('a rule that has stopped fitting is written again and proved before it replaces anything', async () => {
  // The old rule was written when the channel said "vacancy of the day"; nobody writes that any more.
  const ask = model({
    wrong: [],
    rules: [JSON.stringify({ keep: ['we are looking for', 'needed', 'need a'], drop: ['looking for work', 'selling'] })],
  });

  const repair = await repairRule({
    rows: TODAY,
    sift: { want: 'job postings', keep: ['vacancy of the day'], drop: [] },
    ask,
  });

  assert.equal(repair.status, 'repaired');
  assert.equal(repair.before.kept, 0, 'it was keeping nothing');
  assert.equal(repair.after.kept, 3);
  assert.ok(repair.diff.some((line) => line.startsWith('+ keep: we are looking for')));
  assert.ok(repair.diff.some((line) => line.startsWith('− keep: vacancy of the day')));
});

test('a rule that keeps plenty of the wrong things counts as rotted', async () => {
  // Coverage is not correctness: this keeps four of six, and two of them are the opposite of the task.
  const ask = model({
    wrong: [1, 2],
    rules: [JSON.stringify({ keep: ['we are looking for', 'needed', 'need a'], drop: ['looking for work', 'selling'] })],
  });

  const repair = await repairRule({ rows: TODAY, sift: { want: 'job postings', keep: ['work|operator'] }, ask });

  assert.notEqual(repair.status, 'not-needed');
  assert.match(repair.before.note, /were not what was asked/);
});

test('a rule written by hand carries no task, and says so instead of guessing one', async () => {
  const repair = await repairRule({ rows: TODAY, sift: { keep: ['nothing at all like this'] }, ask: model() });

  assert.equal(repair.status, 'unfixable');
  assert.match(repair.reason, /carries no task/);
  assert.deepEqual(repair.diff, [], 'and nothing is changed on a guess');
});

test('when the model cannot write a better rule, the old one stays', async () => {
  const ask = model({ rules: [JSON.stringify({ keep: ['.'] }), JSON.stringify({ keep: ['.'] }), JSON.stringify({ keep: ['.'] })] });
  const repair = await repairRule({ rows: TODAY, sift: { want: 'job postings', keep: ['vacancy of the day'] }, ask });

  assert.equal(repair.status, 'unfixable');
  assert.equal(repair.sift, undefined, 'nothing replaces a rule until it is proved better');
});

/**
 * How a rule actually rots: not by starting to keep the wrong things, but by quietly stopping to catch
 * the right ones. People change how they write; the rule keeps matching the wording it was made for
 * and everything else lands in the discard pile, where nobody looks.
 */
test('a rule that has stopped catching things is rotted, however clean what it keeps', async () => {
  const ask = model({
    wrong: [],           // everything it kept is right…
    missed: [1, 2, 3, 4], // …and it threw away four postings out of the handful it was shown
    rules: [JSON.stringify({ keep: ['we are looking for', 'needed', 'need a'], drop: ['looking for work'] })],
  });

  const repair = await repairRule({
    rows: TODAY,
    sift: { want: 'job postings', keep: ['we are looking for'], drop: [] },
    ask,
  });

  assert.equal(repair.before.good, false, 'clean precision is not the same as doing the job');
  assert.match(repair.before.note, /threw away were what was asked for/);
  assert.equal(repair.before.missed, 4);
  assert.equal(repair.status, 'repaired');
});
