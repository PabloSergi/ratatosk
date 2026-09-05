import assert from 'node:assert/strict';
import { test } from 'vitest';

import { judgeSift, sift } from '../src/sift.ts';
import { buildSift } from '../src/sift-agent.ts';

/**
 * A channel is a stream of whatever people write, and the two directions of the same trade read almost
 * alike: "looking for work" and "looking for someone" are one word apart and mean opposite things. This
 * is the part that has to tell them apart — and the part that must refuse a rule which only appears to.
 */
const CHANNEL = [
  { text: 'We are looking for a designer, Madrid, 60% of takings, write to @studio' },
  { text: 'Chat operator needed, a year of experience, rate 1500 EUR a month + %' },
  { text: 'Looking for work as a chat operator, two years of experience, CV on request' },
  { text: 'Selling an account with a subscriber base, 30 000 EUR, open to offers' },
  { text: 'up' },
  { text: 'Our team needs an operator, remote, from 80 000 EUR a year' },
  { text: 'CV: 24, looking for part-time work as a model' },
  { text: 'Buying traffic, paying well' },
];

test('a rule keeps what the task wants and drops what it does not', () => {
  const result = sift(CHANNEL, {
    keep: ['we are looking for', 'needed', 'team needs'],
    drop: ['looking for work', '\\bcv\\b', 'selling', 'buying'],
    fields: { pay: { pattern: '(\\d[\\d\\s]{2,}\\s*EUR)' } },
  });

  assert.equal(result.kept, 3, 'three postings, and only those');
  assert.equal(result.dropped, 5);
  assert.ok(result.rows.every((row) => /looking for|needed|team needs/i.test(row.text)));
  assert.equal(result.rows[1].pay, '1500 EUR', 'and a field is read out of the sentence itself');
  assert.equal(result.rows[0].pay, null, 'a posting without a number keeps an honest empty');
});

test('a drop wins over a keep', () => {
  const result = sift([{ text: 'We are looking for a designer. Send a CV in a direct message' }], {
    keep: ['looking for'],
    drop: ['\\bcv\\b'],
  });
  assert.equal(result.kept, 0, 'the refusal is the stronger word');
});

test('a rule that keeps everything is refused, and so is one that keeps nothing', () => {
  const everything = sift(CHANNEL, { keep: ['.'] });
  assert.equal(judgeSift(everything, CHANNEL.length).good, false);
  assert.match(judgeSift(everything, CHANNEL.length).note, /kept everything/);

  const nothing = sift(CHANNEL, { keep: ['vacancy in antarctica'] });
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
    // The platform reads its own decisions back — which of the kept ones do not belong, and which of
    // the thrown-away ones did. Unless a test says otherwise, both answers are "none".
    if (/do NOT match|should have been kept/.test(last)) {
      return { content: 'none', usage: { prompt_tokens: 5, completion_tokens: 2 } };
    }
    return { content: answers.shift() ?? '{}', usage: { prompt_tokens: 10, completion_tokens: 5 } };
  };
  ask.said = said;
  return ask;
};

const build = (ask, want = 'job postings: someone hiring, not CVs and not sales') =>
  buildSift({ sample: CHANNEL, want, apiKey: 'x', model: 'm', baseUrl: 'https://nowhere', ask });

test('the model writes a rule and the platform proves it on the messages', async () => {
  const ask = saying(JSON.stringify({ keep: ['we are looking for', 'needed', 'team needs'], drop: ['looking for work', '\\bcv\\b', 'selling'] }));
  const built = await build(ask);

  assert.ok(built.sift, 'a rule that separates them is kept');
  assert.equal(built.attempts[0].good, true);
  assert.equal(built.attempts[0].kept, 3);
  assert.equal(built.usage.calls, 3, 'one to write the rule, one to check what it kept, one what it threw away');
  assert.match(ask.said[0], /looking for a designer/, 'the model was shown real messages, not a description of them');
});

test('a rule that keeps everything is sent back with what it did', async () => {
  const ask = saying(
    JSON.stringify({ keep: ['.'] }),
    JSON.stringify({ keep: ['we are looking for', 'needed', 'team needs'], drop: ['looking for work', '\\bcv\\b', 'selling'] }),
  );
  const built = await build(ask);

  assert.ok(built.sift, 'the second answer is the one that works');
  assert.equal(built.attempts.length, 2);
  assert.equal(built.attempts[0].good, false);
  assert.match(ask.said[1], /kept everything/, 'and the model was told exactly what was wrong');
  assert.match(ask.said[1], /looking for a designer|up/, 'with the messages it kept, so it can see for itself');
});

test('prose instead of JSON is pushed back, not accepted', async () => {
  const ask = saying('Sure! Here is my thinking about the channel…', JSON.stringify({ keep: ['we are looking for', 'needed', 'team needs'], drop: ['\\bcv\\b', 'selling', 'looking for work'] }));
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
  const built = await buildSift({ sample: [], want: 'job postings', apiKey: 'x', model: 'm', baseUrl: 'https://nowhere', ask: saying('{}') });
  assert.match(built.reason, /no messages to learn from/);
});

// --- the second opinion, for what the patterns did not claim -------------------------------------

test('rows no pattern claimed are kept apart from rows a pattern refused', () => {
  const result = sift(CHANNEL, { keep: ['we are looking for', 'needed'], drop: ['selling', 'buying'] });

  const unclaimedText = result.unclaimed.map((row) => row.text).join(' | ');
  assert.ok(unclaimedText.includes('team needs an operator'), 'a posting worded differently is a question, not a refusal');
  assert.ok(!unclaimedText.includes('Selling an account'), 'what a rule refused outright is settled');
});

test('a model looks at the leftovers once per run, not once per message', async () => {
  const { judgeLeftovers } = await import('../src/sift.ts');
  const asked = [];
  const ask = async (prompt) => {
    asked.push(prompt);
    return '{"keep":[1]}';
  };

  const leftovers = [{ text: 'Our team needs an operator, remote' }, { text: 'anyone up for a walk' }];
  const second = await judgeLeftovers(leftovers, 'job postings', ask, 40);

  assert.equal(asked.length, 1, 'one call for the whole batch');
  assert.equal(second.rows.length, 1);
  assert.match(second.rows[0].text, /operator/);
  assert.match(asked[0], /1\. Our team needs an operator/, 'the messages went in numbered');
  assert.match(asked[0], /\{"keep":\[1,3\]\}/, 'and the form of the answer was asked for exactly');
});

test('the second opinion is bounded, so a busy day cannot become an expensive one', async () => {
  const { judgeLeftovers } = await import('../src/sift.ts');
  const many = Array.from({ length: 500 }, (_, index) => ({ text: `message ${index}` }));
  let shown = 0;
  const second = await judgeLeftovers(many, 'job postings', async (prompt) => {
    shown = (prompt.match(/^\d+\./gm) ?? []).length;
    return '{"keep":[]}';
  }, 40);

  assert.equal(second.asked, 40, 'forty, not five hundred');
  assert.equal(shown, 40);
  assert.deepEqual(second.rows, [], '"none" is an answer and it is respected');
});

test('the model can ask for a second opinion, and the platform sets its budget', async () => {
  const ask = saying(JSON.stringify({ keep: ['we are looking for', 'needed', 'team needs'], drop: ['\\bcv\\b', 'selling', 'looking for work'], judge: true }));
  const built = await build(ask);

  assert.ok(built.sift.judge, 'the model asked for it');
  assert.equal(built.sift.judge.maxRows, 40, 'and the platform said how much of it it may have');
  assert.match(built.sift.judge.want, /job postings/, 'the task travels with the rule, because a run has no other memory of it');
});

// --- and the other half: is what it kept actually what was asked? --------------------------------

test('a rule that keeps the wrong direction is refused, however much it keeps', async () => {
  // The failure a pattern cannot see on its own: "looking for designers" and "chatter looking for
  // work" are the same string to a regex, and one of them is a CV.
  const answers = [
    JSON.stringify({ keep: ['looking for'], drop: [] }),
    JSON.stringify({ keep: ['\\bwe are (looking|hiring)', 'buscamos'], drop: ['busco trabajo', '\\bcv\\b'] }),
  ];
  let audits = 0;
  const ask = async (messages) => {
    const last = messages[messages.length - 1].content;
    if (/should have been kept/.test(last)) return { content: 'none' }; // nothing good was thrown away
    if (/do NOT match/.test(last)) {
      audits++;
      // Numbered within what was kept, not within the sample: the first rule kept two CVs.
      return { content: audits === 1 ? '1, 2' : 'none' };
    }
    return { content: answers.shift() ?? '{}' };
  };

  // Deliberately not in English: people write in their own language, and a rule that only works when
  // they write in ours is a rule that works nowhere. The direction of the trade is the same either way.
  const sample = [
    { text: 'Buscamos modelo para el estudio, 60% de la caja' },
    { text: 'Busco trabajo de chat operator, looking for a job' },
    { text: 'CV: 24 años, looking for work' },
    { text: 'Se busca operador, sueldo desde 80 000' },
    { text: 'up' },
  ];
  const built = await buildSift({ sample, want: 'job postings, not CVs', apiKey: 'x', model: 'm', baseUrl: 'https://nowhere', ask });

  assert.equal(built.attempts[0].good, false, 'kept plenty, but kept the wrong things');
  assert.match(built.attempts[0].note, /were not what was asked/);
  assert.equal(built.attempts[0].wrong.wrong, 2);
  assert.ok(built.sift, 'and the corrected rule is accepted');
});

test('the second opinion is switched on by measurement, not by the model saying so', async () => {
  const sample = [
    { text: 'We are looking for a designer' },
    { text: 'Operator needed' },
    { text: 'need a chat operator, write in a direct message' },
    { text: 'up' },
    { text: 'anyone up for a walk' },
  ];

  // A rule that leaves a lot unclaimed gets a judge whether or not the model asked for one.
  const built = await buildSift({
    sample,
    want: 'job postings',
    apiKey: 'x',
    model: 'm',
    baseUrl: 'https://nowhere',
    ask: saying(JSON.stringify({ keep: ['we are looking for', 'needed'], drop: [] })),
  });

  assert.ok(built.sift.judge, 'two of five went unclaimed — that edge is what a model is for');
  assert.equal(built.sift.judge.maxRows, 40);
});

test('a model that explains itself is not misread as choosing', async () => {
  const { judgeLeftovers } = await import('../src/sift.ts');
  const leftovers = [{ text: 'I am an experienced designer looking for a job' }, { text: 'We are hiring designers' }];

  // The failure this exists for: reading every digit in the reply keeps message 1 because the model
  // mentioned message 1 while explaining that it does not fit.
  const explaining = await judgeLeftovers(leftovers, 'job postings', async () => 'Message 1 is a CV, so it does not fit the task.', 40);
  assert.deepEqual(explaining.rows, [], 'an explanation is not a choice');

  const proper = await judgeLeftovers(leftovers, 'job postings', async () => '{"keep":[2]}', 40);
  assert.equal(proper.rows.length, 1);
  assert.match(proper.rows[0].text, /hiring/);

  const bare = await judgeLeftovers(leftovers, 'job postings', async () => ' 2 ', 40);
  assert.equal(bare.rows.length, 1, 'a bare list of numbers is still an answer');

  const none = await judgeLeftovers(leftovers, 'job postings', async () => '{"keep":[]}', 40);
  assert.deepEqual(none.rows, []);
});

/**
 * The other half of correctness, and the half that hides. A rule that keeps eleven perfect postings
 * and throws away thirty more passes a precision check with full marks while losing most of what was
 * asked for — silently, which is the failure this whole project exists to prevent.
 */
test('a rule that throws away what was asked for is refused, however right the rest of it is', async () => {
  const sample = [
    { text: 'We are looking for a chat operator, evening shift' },
    { text: 'Urgently need operators, night shifts, no experience' },
    { text: 'Vacancy: team lead, remote' },
    { text: 'Agency opening a new intake of operators' },
    { text: 'Selling traffic, daily posting' },
    { text: 'up' },
  ];

  // The first rule matches one wording and misses the other three postings. The second is wider.
  const answers = [
    JSON.stringify({ keep: ['we are looking for'], drop: [] }),
    JSON.stringify({ keep: ['looking for', 'need operators', 'vacancy', 'intake of'], drop: ['selling'] }),
  ];
  let asked = 0;
  const ask = async (messages) => {
    const last = messages[messages.length - 1].content;
    if (/should have been kept/.test(last)) {
      asked++;
      // The first rule threw away three real postings out of the five it was shown.
      return { content: asked === 1 ? '1, 2, 3' : 'none' };
    }
    if (/do NOT match/.test(last)) return { content: 'none' };
    return { content: answers.shift() ?? '{}' };
  };

  const built = await buildSift({ sample, want: 'job postings', apiKey: 'x', model: 'm', baseUrl: 'https://nowhere', ask });

  assert.equal(built.attempts[0].good, false, 'keeping only what it understood is not keeping what was asked');
  assert.match(built.attempts[0].note, /threw away/);
  assert.equal(built.attempts[0].missed.wrong, 3);
  assert.ok(built.sift, 'and the wider rule is accepted');
  assert.ok(built.sift.keep.length > 1);
});

/**
 * The shape a channel that is mostly what you want needs: keep everything, drop the noise. It was
 * being refused by the collisions check — with no keeps to disagree with, every drop looked like a
 * keep and a drop fighting over a row, and a rule was punished for doing exactly what it said.
 */
test('a rule that keeps everything except the noise is a rule', () => {
  const stream = [
    { text: 'We are hiring a chat operator, evening shifts' },
    { text: 'Vacancy: team lead, remote, paid twice a month' },
    { text: 'Agency opening an intake of operators' },
    { text: 'REDDIT TRAFFIC — our traffic turns posts into money, daily posting' },
    { text: 'anyone up for a walk' },
  ];

  const result = sift(stream, { keep: [], drop: ['our traffic', 'up for a walk'] });
  assert.equal(result.kept, 3);
  assert.deepEqual(result.collisions, [], 'nothing was fought over: there were no keeps to fight');
  assert.equal(judgeSift(result, stream.length).good, true, 'and the rule stands');
});

test('a guarded drop spares what merely mentions the noise', () => {
  const stream = [
    { text: 'We have traffic and we are hiring a chatter, shifts 8-16' },
    { text: 'REDDIT TRAFFIC — our traffic turns posts into money' },
  ];

  // The guard: fire only where nothing in the message suggests hiring.
  const result = sift(stream, { keep: [], drop: ['^(?![\\s\\S]*(hiring|shifts))[\\s\\S]*traffic'] });
  assert.equal(result.kept, 1);
  assert.match(result.rows[0].text, /hiring a chatter/, 'a posting that mentions traffic is a posting');
});

/**
 * "You lost some postings" is a complaint. "This drop ate this posting" is a thing to fix. The
 * difference decides whether the next attempt is a repair or a guess.
 */
test('the complaint names the drop that ate the posting', async () => {
  const sample = [
    { text: 'We have traffic and we are hiring a chatter, shifts 8-16' },
    { text: 'REDDIT TRAFFIC — our traffic turns posts into money' },
    { text: 'Vacancy: operator, evening shift' },
  ];

  const answers = [
    JSON.stringify({ keep: [], drop: ['traffic'] }), // eats the posting that merely mentions it
    JSON.stringify({ keep: [], drop: ['^(?![\\s\\S]*(hiring|vacancy))[\\s\\S]*traffic'] }),
  ];
  let asked = 0;
  const said = [];
  const ask = async (messages) => {
    const last = messages[messages.length - 1].content;
    said.push(last);
    if (/should have been kept/.test(last)) return { content: asked++ === 0 ? '1' : 'none' };
    if (/do NOT match/.test(last)) return { content: 'none' };
    return { content: answers.shift() ?? '{}' };
  };

  const built = await buildSift({ sample, want: 'job postings', apiKey: 'x', model: 'm', baseUrl: 'https://nowhere', ask });

  const complaint = said.find((message) => /threw away:/.test(message));
  assert.ok(complaint, 'the model has to be told which pattern did it');
  assert.match(complaint, /drop "traffic" threw away/);
  assert.match(complaint, /needs a guard/);
  assert.ok(built.sift, 'and the guarded rule is accepted');
});
