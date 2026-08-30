import assert from 'node:assert/strict';
import { test } from 'vitest';

import { judgeSift, sift } from '../src/sift.ts';
import { buildSift } from '../src/sift-agent.ts';

/**
 * A channel is a stream of whatever people write, and the two directions of the same trade read almost
 * alike: "ищу работу" and "ищем сотрудника" differ by one letter and mean opposite things. This is the
 * part that has to tell them apart — and the part that must refuse a rule which only appears to.
 */
const CHANNEL = [
  { text: 'Ищем модель в студию, Москва, оплата 60% от кассы, писать @studio' },
  { text: 'Требуется чаттер на OF, опыт от года, ставка 1500₽ смена + %' },
  { text: 'Ищу работу чаттером, опыт 2 года, резюме в личку' },
  { text: 'Продам аккаунт OF с базой подписчиков, 30 000 ₽, торг' },
  { text: 'up' },
  { text: 'В команду нужен оператор, удалённо, з/п от 80 000 руб' },
  { text: 'Резюме: девушка 24 года, ищу подработку моделью' },
  { text: 'Куплю трафик, дорого' },
];

test('a rule keeps what the task wants and drops what it does not', () => {
  const result = sift(CHANNEL, {
    keep: ['ищем', 'требуется', 'нужен', 'в команду'],
    drop: ['ищу работу', 'резюме', 'продам', 'куплю'],
    fields: { pay: { pattern: '(\\d[\\d\\s]{2,}\\s*(?:₽|руб))' } },
  });

  assert.equal(result.kept, 3, 'three postings, and only those');
  assert.equal(result.dropped, 5);
  assert.ok(result.rows.every((row) => /ищем|требуется|нужен|в команду/i.test(row.text)));
  assert.equal(result.rows[1].pay, '1500₽', 'and a field is read out of the sentence itself');
  assert.equal(result.rows[0].pay, null, 'a posting without a number keeps an honest empty');
});

test('a drop wins over a keep', () => {
  const result = sift([{ text: 'Ищем модель. Резюме присылайте в личку' }], { keep: ['ищем'], drop: ['резюме'] });
  assert.equal(result.kept, 0, 'the refusal is the stronger word');
});

test('a rule that keeps everything is refused, and so is one that keeps nothing', () => {
  const everything = sift(CHANNEL, { keep: ['.'] });
  assert.equal(judgeSift(everything, CHANNEL.length).good, false);
  assert.match(judgeSift(everything, CHANNEL.length).note, /kept everything/);

  const nothing = sift(CHANNEL, { keep: ['вакансия в антарктиде'] });
  assert.equal(judgeSift(nothing, CHANNEL.length).good, false);
  assert.match(judgeSift(nothing, CHANNEL.length).note, /kept nothing/);
});

test('a broken pattern is an answer, not a crash', () => {
  assert.throws(() => sift(CHANNEL, { keep: ['('] }), /not a usable pattern/);
});

// --- the model writing the rule ----------------------------------------------------------------

/** A model that answers with whatever it is told to, in order. No network, no bill. */
const saying = (...answers) => {
  const said = [];
  const ask = async (messages) => {
    const last = messages[messages.length - 1].content;
    said.push(last);
    // The platform reads the kept messages back and asks which do not belong; unless a test says
    // otherwise, they all do.
    if (/do NOT match/.test(last)) return { content: 'none', usage: { prompt_tokens: 5, completion_tokens: 2 } };
    return { content: answers.shift() ?? '{}', usage: { prompt_tokens: 10, completion_tokens: 5 } };
  };
  ask.said = said;
  return ask;
};

const build = (ask, want = 'вакансии: ищем людей на работу, не резюме и не продажи') =>
  buildSift({ sample: CHANNEL, want, apiKey: 'x', model: 'm', baseUrl: 'https://nowhere', ask });

test('the model writes a rule and the platform proves it on the messages', async () => {
  const ask = saying(JSON.stringify({ keep: ['ищем', 'требуется', 'нужен'], drop: ['ищу работу', 'резюме', 'продам'] }));
  const built = await build(ask);

  assert.ok(built.sift, 'a rule that separates them is kept');
  assert.equal(built.attempts[0].good, true);
  assert.equal(built.attempts[0].kept, 3);
  assert.equal(built.usage.calls, 2, 'one call to write the rule, one to check what it kept');
  assert.match(ask.said[0], /Ищем модель/, 'the model was shown real messages, not a description of them');
});

test('a rule that keeps everything is sent back with what it did', async () => {
  const ask = saying(
    JSON.stringify({ keep: ['.'] }),
    JSON.stringify({ keep: ['ищем', 'требуется', 'нужен'], drop: ['ищу работу', 'резюме', 'продам'] }),
  );
  const built = await build(ask);

  assert.ok(built.sift, 'the second answer is the one that works');
  assert.equal(built.attempts.length, 2);
  assert.equal(built.attempts[0].good, false);
  assert.match(ask.said[1], /kept everything/, 'and the model was told exactly what was wrong');
  assert.match(ask.said[1], /Ищем модель|up/, 'with the messages it kept, so it can see for itself');
});

test('prose instead of JSON is pushed back, not accepted', async () => {
  const ask = saying('Sure! Here is my thinking about the channel…', JSON.stringify({ keep: ['ищем', 'требуется', 'нужен'], drop: ['резюме', 'продам', 'ищу работу'] }));
  const built = await build(ask);

  assert.ok(built.sift);
  assert.match(ask.said[1], /JSON/);
});

test('a model that never finds a rule leaves none, and says so', async () => {
  const ask = saying(JSON.stringify({ keep: ['.'] }), JSON.stringify({ keep: ['.'] }), JSON.stringify({ keep: ['.'] }));
  const built = await build(ask);

  assert.equal(built.sift, undefined, 'no rule at all beats a rule that decides nothing');
  assert.match(built.reason, /no rule separated/);
  assert.equal(built.attempts.length, 3);
});

test('nothing to learn from is said plainly', async () => {
  const built = await buildSift({ sample: [], want: 'вакансии', apiKey: 'x', model: 'm', baseUrl: 'https://nowhere', ask: saying('{}') });
  assert.match(built.reason, /no messages to learn from/);
});

// --- the second opinion, for what the patterns did not claim -------------------------------------

test('rows no pattern claimed are kept apart from rows a pattern refused', () => {
  const result = sift(CHANNEL, { keep: ['ищем', 'требуется'], drop: ['продам', 'куплю'] });

  const unclaimedText = result.unclaimed.map((row) => row.text).join(' | ');
  assert.ok(unclaimedText.includes('нужен оператор'), 'a posting worded differently is a question, not a refusal');
  assert.ok(!unclaimedText.includes('Продам аккаунт'), 'what a rule refused outright is settled');
});

test('a model looks at the leftovers once per run, not once per message', async () => {
  const { judgeLeftovers } = await import('../src/sift.ts');
  const asked = [];
  const ask = async (prompt) => {
    asked.push(prompt);
    return '{"keep":[1]}';
  };

  const leftovers = [{ text: 'В команду нужен оператор, удалённо' }, { text: 'кто пойдёт гулять' }];
  const second = await judgeLeftovers(leftovers, 'вакансии', ask, 40);

  assert.equal(asked.length, 1, 'one call for the whole batch');
  assert.equal(second.rows.length, 1);
  assert.match(second.rows[0].text, /оператор/);
  assert.match(asked[0], /1\. В команду нужен оператор/, 'the messages went in numbered');
  assert.match(asked[0], /\{"keep":\[1,3\]\}/, 'and the form of the answer was asked for exactly');
});

test('the second opinion is bounded, so a busy day cannot become an expensive one', async () => {
  const { judgeLeftovers } = await import('../src/sift.ts');
  const many = Array.from({ length: 500 }, (_, index) => ({ text: `сообщение ${index}` }));
  let shown = 0;
  const second = await judgeLeftovers(many, 'вакансии', async (prompt) => {
    shown = (prompt.match(/^\d+\./gm) ?? []).length;
    return '{"keep":[]}';
  }, 40);

  assert.equal(second.asked, 40, 'forty, not five hundred');
  assert.equal(shown, 40);
  assert.deepEqual(second.rows, [], '"none" is an answer and it is respected');
});

test('the model can ask for a second opinion, and the platform sets its budget', async () => {
  const ask = saying(JSON.stringify({ keep: ['ищем', 'требуется', 'нужен'], drop: ['резюме', 'продам', 'ищу работу'], judge: true }));
  const built = await build(ask);

  assert.ok(built.sift.judge, 'the model asked for it');
  assert.equal(built.sift.judge.maxRows, 40, 'and the platform said how much of it it may have');
  assert.match(built.sift.judge.want, /вакансии/, 'the task travels with the rule, because a run has no other memory of it');
});

// --- and the other half: is what it kept actually what was asked? --------------------------------

test('a rule that keeps the wrong direction is refused, however much it keeps', async () => {
  // The failure a pattern cannot see on its own: "looking for designers" and "chatter looking for
  // work" are the same string to a regex, and one of them is a CV.
  const answers = [
    JSON.stringify({ keep: ['looking for'], drop: [] }),
    JSON.stringify({ keep: ['\\bwe are (looking|hiring)', 'требуется', 'ищем'], drop: ['ищу работу', 'резюме'] }),
  ];
  let audits = 0;
  const ask = async (messages) => {
    const last = messages[messages.length - 1].content;
    if (/do NOT match/.test(last)) {
      audits++;
      // Numbered within what was kept, not within the sample: the first rule kept two CVs.
      return { content: audits === 1 ? '1, 2' : 'none' };
    }
    return { content: answers.shift() ?? '{}' };
  };

  const sample = [
    { text: 'Ищем модель в студию, оплата 60%' },
    { text: 'Ищу работу чаттером, looking for a job' },
    { text: 'Резюме: девушка 24, looking for work' },
    { text: 'Требуется оператор, з/п от 80 000' },
    { text: 'up' },
  ];
  const built = await buildSift({ sample, want: 'вакансии, не резюме', apiKey: 'x', model: 'm', baseUrl: 'https://nowhere', ask });

  assert.equal(built.attempts[0].good, false, 'kept plenty, but kept the wrong things');
  assert.match(built.attempts[0].note, /were not what was asked/);
  assert.equal(built.attempts[0].wrong.wrong, 2);
  assert.ok(built.sift, 'and the corrected rule is accepted');
});

test('the second opinion is switched on by measurement, not by the model saying so', async () => {
  const sample = [
    { text: 'Ищем модель в студию' },
    { text: 'Требуется оператор' },
    { text: 'нужен чаттер, писать в лс' },
    { text: 'up' },
    { text: 'кто пойдёт гулять' },
  ];

  // A rule that leaves a lot unclaimed gets a judge whether or not the model asked for one.
  const built = await buildSift({
    sample,
    want: 'вакансии',
    apiKey: 'x',
    model: 'm',
    baseUrl: 'https://nowhere',
    ask: saying(JSON.stringify({ keep: ['ищем', 'требуется'], drop: [] })),
  });

  assert.ok(built.sift.judge, 'two of five went unclaimed — that edge is what a model is for');
  assert.equal(built.sift.judge.maxRows, 40);
});

test('a model that explains itself is not misread as choosing', async () => {
  const { judgeLeftovers } = await import('../src/sift.ts');
  const leftovers = [{ text: 'I am an experienced designer looking for a job' }, { text: 'We are hiring designers' }];

  // The failure this exists for: reading every digit in the reply keeps message 1 because the model
  // mentioned message 1 while explaining that it does not fit.
  const explaining = await judgeLeftovers(leftovers, 'вакансии', async () => 'Message 1 is a CV, so it does not fit the task.', 40);
  assert.deepEqual(explaining.rows, [], 'an explanation is not a choice');

  const proper = await judgeLeftovers(leftovers, 'вакансии', async () => '{"keep":[2]}', 40);
  assert.equal(proper.rows.length, 1);
  assert.match(proper.rows[0].text, /hiring/);

  const bare = await judgeLeftovers(leftovers, 'вакансии', async () => ' 2 ', 40);
  assert.equal(bare.rows.length, 1, 'a bare list of numbers is still an answer');

  const none = await judgeLeftovers(leftovers, 'вакансии', async () => '{"keep":[]}', 40);
  assert.deepEqual(none.rows, []);
});
