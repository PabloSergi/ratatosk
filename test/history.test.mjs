import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'vitest';

import { recent, remember, renameInHistory, standing } from '../src/history.ts';

/**
 * The product's claim is that a scraper says when it breaks, and a claim like that needs a memory:
 * one run returning eleven rows means nothing, eleven where yesterday there were four hundred means
 * the site changed under it.
 */
async function logbook() {
  return join(await mkdtemp(join(tmpdir(), 'ratatosk-history-')), 'runs.jsonl');
}

const run = (over = {}) => ({
  at: '2026-08-27T10:00:00.000Z',
  robot: 'city-jobs',
  kind: 'run',
  status: 'ok',
  rows: 173,
  pages: 5,
  ms: 4200,
  ...over,
});

test('runs come back newest first', async () => {
  const file = await logbook();
  await remember(file, run({ at: '2026-08-27T10:00:00.000Z', rows: 173 }));
  await remember(file, run({ at: '2026-08-27T11:00:00.000Z', rows: 12 }));

  const runs = await recent(file);
  assert.equal(runs.length, 2);
  assert.equal(runs[0].rows, 12, 'the latest is the one you came to see');
  assert.equal(runs[1].rows, 173);
});

test('one robot can be asked about on its own', async () => {
  const file = await logbook();
  await remember(file, run({ robot: 'city-jobs' }));
  await remember(file, run({ robot: 'erosjobs', rows: 12 }));

  const mine = await recent(file, { robot: 'erosjobs' });
  assert.equal(mine.length, 1);
  assert.equal(mine[0].robot, 'erosjobs');
});

test('a logbook nobody has written to is empty, not an error', async () => {
  assert.deepEqual(await recent(join(await mkdtemp(join(tmpdir(), 'r-')), 'nothing.jsonl')), []);
});

test('a line that got mangled does not take the rest of the story with it', async () => {
  const file = await logbook();
  await remember(file, run({ rows: 173 }));
  await writeFile(file, (await readFile(file, 'utf8')) + 'half a line, no newline, no JSON\n');
  await remember(file, run({ at: '2026-08-27T12:00:00.000Z', rows: 12 }));

  const runs = await recent(file);
  assert.equal(runs.length, 2, 'both real runs survive');
});

test('standing says how each robot is now, and for how long', async () => {
  const file = await logbook();
  // Oldest first, as they happened: fine, fine, then the site changed.
  await remember(file, run({ at: '2026-08-27T08:00:00.000Z', status: 'ok', rows: 173 }));
  await remember(file, run({ at: '2026-08-27T09:00:00.000Z', status: 'broken', rows: 0, why: 'page never rendered' }));
  await remember(file, run({ at: '2026-08-27T10:00:00.000Z', status: 'broken', rows: 0, why: 'page never rendered' }));
  await remember(file, run({ robot: 'erosjobs', at: '2026-08-27T10:30:00.000Z', status: 'ok', rows: 12 }));

  const now = await standing(file);
  const cityJobs = now.find((entry) => entry.robot === 'city-jobs');
  assert.equal(cityJobs.status, 'broken');
  assert.equal(cityJobs.inARow, 2, 'two in a row is a verdict; one would be noise');
  assert.match(cityJobs.why, /never rendered/);

  const erosjobs = now.find((entry) => entry.robot === 'erosjobs');
  assert.equal(erosjobs.status, 'ok');
  assert.equal(erosjobs.inARow, 1);
});

test('a run that recovered ends the streak of the ones before it', async () => {
  const file = await logbook();
  await remember(file, run({ at: '2026-08-27T08:00:00.000Z', status: 'broken', rows: 0 }));
  await remember(file, run({ at: '2026-08-27T09:00:00.000Z', status: 'broken', rows: 0 }));
  await remember(file, run({ at: '2026-08-27T10:00:00.000Z', status: 'ok', rows: 173 }));

  const [cityJobs] = await standing(file);
  assert.equal(cityJobs.status, 'ok');
  assert.equal(cityJobs.inARow, 1, 'it is fine now, and it has been fine for exactly one run');
});

test('a build is not how a robot is doing', async () => {
  const file = await logbook();
  await remember(file, run({ kind: 'build', status: 'ok', rows: 12, at: '2026-08-27T11:00:00.000Z' }));
  assert.deepEqual(await standing(file), [], 'building it says nothing about whether it still works');
});

test('a renamed scraper keeps its past, under the new name', async () => {
  const file = join(await mkdtemp(join(tmpdir(), 'ratatosk-history-')), 'runs.jsonl');
  await remember(file, run({ robot: 'before', rows: 40 }));
  await remember(file, run({ robot: 'somebody-else', rows: 7 }));
  await remember(file, run({ robot: 'before', rows: 41 }));

  const moved = await renameInHistory(file, 'before', 'after');
  assert.equal(moved, 2, 'both of its runs, and only its own');

  const now = await recent(file);
  assert.equal(now.filter((entry) => entry.robot === 'after').length, 2);
  assert.equal(now.filter((entry) => entry.robot === 'before').length, 0, 'nothing is left behind the old name');
  assert.equal(now.filter((entry) => entry.robot === 'somebody-else').length, 1, "and nobody else's story moved");
});

test('renaming in a history that does not exist yet is not an error', async () => {
  const file = join(await mkdtemp(join(tmpdir(), 'ratatosk-history-')), 'nothing.jsonl');
  assert.equal(await renameInHistory(file, 'a', 'b'), 0, 'a scraper that never ran has nothing to carry');
});

/**
 * A scraper that remembers spends most of its life finding rows it has already handed over. Judged as
 * "empty" that reads as a problem, and a streak of quiet days reads as broken — so every morning would
 * start with fifteen false alarms, and by the end of the week nobody reads them.
 */
test('a quiet day is a working scraper, not an empty one', async () => {
  const file = join(await mkdtemp(join(tmpdir(), 'ratatosk-history-')), 'runs.jsonl');

  await remember(file, run({ robot: 'daily', status: 'ok', rows: 178 }));
  for (const nothing of [1, 2, 3]) {
    void nothing;
    await remember(file, run({ robot: 'daily', status: 'empty', rows: 0, quiet: true, why: '178 of 178 had been seen before' }));
  }

  const [now] = await standing(file);
  assert.equal(now.status, 'ok', 'the source answered and the memory did its job');
  assert.equal(now.quiet, true, 'and the card can say which kind of ok this is');
  assert.equal(now.inARow, 4, 'a run that found rows and three quiet ones are one healthy streak');
  assert.match(now.why, /seen before/);
});

test('an empty run that is not quiet is still a thing to look at', async () => {
  const file = join(await mkdtemp(join(tmpdir(), 'ratatosk-history-')), 'runs.jsonl');
  await remember(file, run({ robot: 'gone', status: 'empty', rows: 0, why: 'page rendered but matched nothing' }));

  const [now] = await standing(file);
  assert.equal(now.status, 'empty', 'nothing came from the source at all, which is different');
  assert.equal(now.quiet, undefined);
});

/**
 * Две сотни источников опрашиваются круглосуточно, и у большинства в каждый отдельный час просто нет
 * ничего нового. Если каждый такой прогон красить как «посмотри на меня», страница превращается в
 * стену красного, и человек перестаёт различать цвет — именно это Павел и увидел.
 */
test('источник, который сегодня ничего не нашёл, не притворяется сломанным', async () => {
  const file = join(await mkdtemp(join(tmpdir(), 'ratatosk-silence-')), 'history.jsonl');
  const hours = (n) => new Date(Date.now() - n * 3600000).toISOString();

  await remember(file, { at: hours(30), robot: 'tg-desk', kind: 'run', status: 'ok', rows: 4, pages: 1, ms: 10 });
  await remember(file, { at: hours(2), robot: 'tg-desk', kind: 'run', status: 'empty', rows: 0, pages: 1, ms: 10, why: 'сито не взяло ничего' });

  // Второй источник молчит неделю — вот это уже вопрос к правилу, а не к сегодняшнему дню.
  await remember(file, { at: hours(24 * 9), robot: 'tg-dead', kind: 'run', status: 'ok', rows: 2, pages: 1, ms: 10 });
  await remember(file, { at: hours(1), robot: 'tg-dead', kind: 'run', status: 'empty', rows: 0, pages: 1, ms: 10, why: 'сито не взяло ничего' });

  const now = await standing(file);
  const desk = now.find((one) => one.robot === 'tg-desk');
  const dead = now.find((one) => one.robot === 'tg-dead');

  assert.equal(desk.status, 'ok', 'вчера отдавал — значит сегодняшняя пустота это тишина, а не поломка');
  assert.equal(desk.quiet, true, 'и карточка скажет «нового нет», а не «0 строк»');
  assert.equal(dead.status, 'empty', 'а девять дней молчания — это к человеку');
});

/**
 * Один файл на весь аккаунт: при двухстах роботах плоский потолок в две тысячи строк съедался за час,
 * и робот, бегавший утром, пропадал из файла совсем — страница говорила «ни разу не запускался».
 */
test('у каждого робота своя история, а не доля общего потолка', async () => {
  const file = join(await mkdtemp(join(tmpdir(), 'ratatosk-keep-')), 'history.jsonl');
  const line = (robot, n) => ({ at: new Date(Date.now() - n * 60000).toISOString(), robot, kind: 'run', status: 'ok', rows: 1, pages: 1, ms: 5 });

  await remember(file, line('тихий', 5000));
  for (let n = 4000; n > 0; n--) await remember(file, line('болтливый', n));

  const mine = await recent(file, { robot: 'тихий' });
  assert.equal(mine.length, 1, 'редкий робот остаётся в файле, сколько бы ни бегал сосед');

  // Подрезка срабатывает с запасом, поэтому меряем то, что она гарантирует: файл не растёт без
  // предела, и место в нём делится по роботам, а не по частоте.
  const all = (await readFile(file, 'utf8')).split('\n').filter(Boolean).length;
  assert.ok(all < 4000, `файл остаётся обозримым: ${all}`);
  const { length: afterTrim } = await recent(file, { robot: 'болтливый', limit: 5000 });
  assert.ok(afterTrim > 60, 'между подрезками он, конечно, копит');
});

/**
 * Журнал подрезается, а сложенные результаты — нет: про источник, который отдал вчера, журнал может
 * уже не помнить ничего. Тогда ответ знает тот, кто хранит дольше.
 */
test('о последней отдаче можно сказать снаружи, если журнал её не застал', async () => {
  const file = join(await mkdtemp(join(tmpdir(), 'ratatosk-outside-')), 'history.jsonl');
  const at = new Date(Date.now() - 3600000).toISOString();
  await remember(file, { at, robot: 'ats-exogroup', kind: 'run', status: 'empty', rows: 0, pages: 1, ms: 9, why: 'лента ответила, а в ней пусто' });

  const alone = (await standing(file)).find((one) => one.robot === 'ats-exogroup');
  assert.equal(alone.status, 'empty', 'сам по себе журнал видит только сегодняшнюю пустоту');

  const told = new Map([['ats-exogroup', new Date(Date.now() - 26 * 3600000).toISOString()]]);
  const withMemory = (await standing(file, told)).find((one) => one.robot === 'ats-exogroup');
  assert.equal(withMemory.status, 'ok', 'а вчерашняя отдача делает её обычной тишиной');
  assert.equal(withMemory.quiet, true);
});
