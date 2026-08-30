import assert from 'node:assert/strict';
import { test } from 'vitest';

import { repairRule } from '../src/rule-repair.ts';

/**
 * Selectors rot when a site changes its markup; rules rot when people change how they write. Both
 * fail the same way — quietly — so both have to be measured against what the source says today, not
 * against what it said when somebody wrote the rule.
 */
const TODAY = [
  { text: 'Ищем модель в студию, оплата 60%' },
  { text: 'Требуется оператор, удалённо, з/п от 80 000' },
  { text: 'Нужен чаттер на вечернюю смену' },
  { text: 'Ищу работу чаттером, опыт 2 года' },
  { text: 'Продам аккаунт с базой' },
  { text: 'up' },
];

/** A model that answers each kind of question the repair asks. */
const model = ({ wrong = [], rules = [] } = {}) => {
  const asked = [];
  const ask = async (messages) => {
    const last = messages[messages.length - 1].content;
    asked.push(last);
    if (/Which do NOT match|do NOT match it/.test(last)) return { content: JSON.stringify({ wrong }) };
    if (/do NOT match/.test(last)) return { content: 'none' };
    return { content: rules.shift() ?? '{}' };
  };
  ask.asked = asked;
  return ask;
};

test('a rule that still holds is left alone', async () => {
  const repair = await repairRule({
    rows: TODAY,
    sift: { want: 'вакансии', keep: ['ищем', 'требуется', 'нужен'], drop: ['ищу работу', 'продам'] },
    ask: model(),
  });

  assert.equal(repair.status, 'not-needed');
  assert.deepEqual(repair.diff, []);
  assert.equal(repair.before.good, true);
  assert.equal(repair.before.kept, 3);
});

test('a rule that has stopped fitting is written again and proved before it replaces anything', async () => {
  // The old rule was written when the channel said "вакансия"; nobody writes that here any more.
  const ask = model({
    wrong: [],
    rules: [JSON.stringify({ keep: ['ищем', 'требуется', 'нужен'], drop: ['ищу работу', 'продам'] })],
  });

  const repair = await repairRule({
    rows: TODAY,
    sift: { want: 'вакансии', keep: ['вакансия дня'], drop: [] },
    ask,
  });

  assert.equal(repair.status, 'repaired');
  assert.equal(repair.before.kept, 0, 'it was keeping nothing');
  assert.equal(repair.after.kept, 3);
  assert.ok(repair.diff.some((line) => line.startsWith('+ keep: ищем')));
  assert.ok(repair.diff.some((line) => line.startsWith('− keep: вакансия дня')));
});

test('a rule that keeps plenty of the wrong things counts as rotted', async () => {
  // Coverage is not correctness: this keeps four of six, and two of them are the opposite of the task.
  const ask = model({
    wrong: [1, 2],
    rules: [JSON.stringify({ keep: ['ищем', 'требуется', 'нужен'], drop: ['ищу работу', 'продам'] })],
  });

  const repair = await repairRule({ rows: TODAY, sift: { want: 'вакансии', keep: ['работ|чаттер'] }, ask });

  assert.notEqual(repair.status, 'not-needed');
  assert.match(repair.before.note, /were not what was asked/);
});

test('a rule written by hand carries no task, and says so instead of guessing one', async () => {
  const repair = await repairRule({ rows: TODAY, sift: { keep: ['совершенно ничего'] }, ask: model() });

  assert.equal(repair.status, 'unfixable');
  assert.match(repair.reason, /carries no task/);
  assert.deepEqual(repair.diff, [], 'and nothing is changed on a guess');
});

test('when the model cannot write a better rule, the old one stays', async () => {
  const ask = model({ rules: [JSON.stringify({ keep: ['.'] }), JSON.stringify({ keep: ['.'] }), JSON.stringify({ keep: ['.'] })] });
  const repair = await repairRule({ rows: TODAY, sift: { want: 'вакансии', keep: ['вакансия дня'] }, ask });

  assert.equal(repair.status, 'unfixable');
  assert.equal(repair.sift, undefined, 'nothing replaces a rule until it is proved better');
});
