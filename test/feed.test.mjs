import assert from 'node:assert/strict';
import { test } from 'vitest';

import { readFeed, runFeedRobot } from '../src/feed.ts';

/** Атом в том виде, в каком его отдаёт reddit: тело запаковано в HTML и экранировано дважды. */
const ATOM = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>gameDevClassifieds</title>
  <entry>
    <author><name>/u/someone</name></author>
    <category term="gameDevClassifieds" label="r/gameDevClassifieds"/>
    <content type="html">&lt;div class=&quot;md&quot;&gt;&lt;p&gt;Looking for a 3D artist&lt;/p&gt;&lt;p&gt;Budget: 500&amp;#39;ish USD &amp;amp; credit&lt;/p&gt;&lt;/div&gt;</content>
    <id>t3_abc123</id>
    <link href="https://www.reddit.com/r/gameDevClassifieds/comments/abc123/hiring_3d_artist/"/>
    <updated>2026-10-03T05:00:00+00:00</updated>
    <title>[HIRING] 3D artist for an adult visual novel</title>
  </entry>
  <entry>
    <author><name>/u/another</name></author>
    <content type="html">&lt;p&gt;Available for work&lt;/p&gt;</content>
    <link href="https://www.reddit.com/r/gameDevClassifieds/comments/def456/for_hire/"/>
    <updated>2026-10-03T04:00:00+00:00</updated>
    <title>[FOR HIRE] Unity developer</title>
  </entry>
</feed>`;

/** И RSS 2.0, потому что какой из двух публикует доска — решали не для нашего удобства. */
const RSS = `<?xml version="1.0"?>
<rss version="2.0"><channel>
  <title>jobs</title>
  <item>
    <title><![CDATA[Senior Artist — remote]]></title>
    <link>https://board.test/jobs/1</link>
    <description><![CDATA[<p>We need an artist.</p><p>Pay: 3000 EUR</p>]]></description>
    <pubDate>Fri, 03 Oct 2026 05:00:00 GMT</pubDate>
    <dc:creator>Studio X</dc:creator>
  </item>
</channel></rss>`;

test('атом читается: заголовок, ссылка, автор, время и тело словами', () => {
  const rows = readFeed(ATOM);

  assert.equal(rows.length, 2);
  assert.equal(rows[0].title, '[HIRING] 3D artist for an adult visual novel');
  assert.equal(rows[0].link, 'https://www.reddit.com/r/gameDevClassifieds/comments/abc123/hiring_3d_artist/');
  assert.equal(rows[0].author, '/u/someone');
  assert.equal(rows[0].posted, '2026-10-03T05:00:00+00:00');
  assert.ok(!rows[0].text.includes('<'), 'разметки в тексте не осталось');
  assert.ok(rows[0].text.includes("500'ish USD & credit"), 'и мягкие сущности раскрыты, а не оставлены как &amp;#39;');
});

test('rss читается тем же кодом', () => {
  const rows = readFeed(RSS);

  assert.equal(rows.length, 1);
  assert.equal(rows[0].title, 'Senior Artist — remote');
  assert.equal(rows[0].link, 'https://board.test/jobs/1');
  assert.equal(rows[0].author, 'Studio X');
  assert.ok(rows[0].text.includes('Pay: 3000 EUR'));
});

test('правило читает тело и заголовок, так что резюме отсекается', async () => {
  const { runRobot } = await import('../src/run-robot.ts');

  const robot = {
    name: 'board', version: 1, source: 'feed',
    url: 'https://www.reddit.com/r/gameDevClassifieds/new.rss',
    sift: { keep: ['\\[hiring\\]', '\\[paid\\]'], drop: ['\\[for hire\\]'] },
  };

  const run = await runRobot(robot, {
    page: async () => { throw new Error('браузер тут не нужен'); },
    get: async () => ({ status: 200, statusText: 'OK', body: ATOM }),
  });

  assert.equal(run.status, 'ok');
  assert.equal(run.rows.length, 1, 'осталась только вакансия');
  assert.ok(run.rows[0].title.startsWith('[HIRING]'));
});

test('отказ источника — это поломка, а не пустой прогон', async () => {
  await assert.rejects(
    () => runFeedRobot({ name: 'x', version: 1, source: 'feed', url: 'https://x.test/f.rss' }, async () => ({ status: 429, statusText: 'Too Many Requests', body: '' })),
    /429 Too Many Requests/,
  );
});
