import type { Remember } from './memory.js';
import type { SiftRule } from './scenario.js';
import { direct, type Get } from './through.js';

/**
 * A source that publishes a feed: Atom or RSS.
 *
 * Worth having on its own, next to JSON and a browser, because it is the door a site leaves open when
 * it has closed the others. Reddit is the measured case: its JSON needs no login and is answered with
 * 403 to every address and every User-Agent tried, old.reddit redirects to a sign-in, and the same
 * posts come out of `/new.rss` with a 200 — body, author and time included. A board that publishes a
 * feed is also saying how it wants to be read, which is a better footing than a selector.
 *
 * The row shape is fixed, the way a Telegram robot's is, and for the same reason: a feed decided what
 * an entry is long before we got here, so there is nothing to configure and nothing to rot.
 */
export interface FeedRobot {
  name: string;
  version: 1;
  source: 'feed';
  /** The feed's address. */
  url: string;
  /** How many of the newest entries to take. */
  limit?: number;
  /** Sent with the request: what the source insists on being told. */
  headers?: Record<string, string>;
  /** Which proxy to go out through, if any. */
  proxy?: string;
  /** Which entries count, and what to read out of them. */
  sift?: SiftRule;
  remember?: Remember;
}

export type Row = Record<string, string | null>;

export function isFeedRobot(value: unknown): value is FeedRobot {
  return typeof value === 'object' && value !== null && (value as { source?: string }).source === 'feed';
}

export function parseFeedRobot(data: unknown): FeedRobot {
  const robot = data as FeedRobot;
  if (!/^https?:\/\//.test(robot?.url ?? '')) throw new Error(`${robot?.name ?? 'robot'}: url must be http(s)`);
  return { ...robot, version: 1, source: 'feed', limit: robot.limit ?? 100 };
}

/** `&lt;` and friends, including the numeric ones a feed uses for apostrophes. */
function unescaped(text: string): string {
  return text
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code: string) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');
}

/** The text of one element, CDATA or not. The first one: a feed puts the entry's own title first. */
function tag(entry: string, name: string): string | null {
  const found = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'i').exec(entry);
  if (!found) return null;
  const raw = found[1]!.replace(/^<!\[CDATA\[([\s\S]*)\]\]>$/, '$1');
  const text = unescaped(raw).trim();
  return text === '' ? null : text;
}

/** A post's body as words rather than markup, because that is what a rule reads and a person reads. */
function words(html: string | null): string | null {
  if (html === null) return null;
  const text = unescaped(html)
    .replace(/<br\s*\/?>|<\/p>|<\/li>|<\/h\d>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return text === '' ? null : text;
}

/**
 * The entries of a feed, newest first, as rows.
 *
 * Atom and RSS are both read, because which one a board publishes is not a choice anybody made for
 * our benefit: Atom calls an entry `entry` and its body `content`, RSS calls them `item` and
 * `description`, and underneath they say the same six things.
 */
export function readFeed(xml: string, limit = 100): Row[] {
  const atom = xml.includes('<entry');
  const blocks = [...xml.matchAll(atom ? /<entry[\s>][\s\S]*?<\/entry>/g : /<item[\s>][\s\S]*?<\/item>/g)];

  return blocks.slice(0, limit).map((block) => {
    const entry = block[0];
    const href = /<link[^>]*href="([^"]+)"/i.exec(entry);
    return {
      title: tag(entry, 'title'),
      link: href ? unescaped(href[1]!) : tag(entry, 'link'),
      author: tag(entry, 'name') ?? tag(entry, 'dc:creator') ?? tag(entry, 'author'),
      posted: tag(entry, 'updated') ?? tag(entry, 'published') ?? tag(entry, 'pubDate'),
      text: words(tag(entry, 'content') ?? tag(entry, 'description') ?? tag(entry, 'summary')),
    };
  });
}

export interface FeedRun {
  rows: Row[];
  reason?: string;
}

export async function runFeedRobot(robot: FeedRobot, get: Get = direct()): Promise<FeedRun> {
  const answer = await get(robot.url, { accept: 'application/atom+xml, application/rss+xml, application/xml', ...robot.headers });
  if (answer.status < 200 || answer.status >= 300) {
    throw new Error(`${answer.status} ${answer.statusText}`.trim());
  }

  const rows = readFeed(answer.body, robot.limit ?? 100);
  if (rows.length === 0) {
    return { rows, reason: 'the feed answered, and had no entries in it' };
  }
  return { rows };
}
