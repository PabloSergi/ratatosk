import type { PageDriver } from './driver.js';

/**
 * Asking a source whether what it once held is still there.
 *
 * A walk answers "here is what is on the list now", and on a board that pages through everything in
 * one pass that is enough: what a pass did not meet is gone. On a feed it is not enough and not even
 * close — a pass reaches the first few hundred of thousands, so "not met" describes our patience
 * rather than the source, and reporting it as gone would bury a catalogue in a day. Measured on a live
 * one: of the postings unseen for three days, every single one checked was still up.
 *
 * So the postings are asked about one at a time, in the scraper's own browser, from a page of the same
 * site — which is what carries the session and makes the answer the one a visitor would get. What is
 * still there has its sighting refreshed; what is not is simply left, and the catalogue's own boundary
 * then says it is gone.
 */
export interface AliveRule {
  /** Where one row lives. `{id}` is the catalogue's id for it. */
  url: string;
  /** What a page that no longer holds it says. A pattern, matched against the answer. */
  gone: string;
  /** Between questions, in milliseconds. A revision is not an emergency. */
  pace?: number;
}

export interface Revision {
  alive: string[];
  gone: string[];
  /** Asked and not answered: a timeout, a network that blinked. Neither alive nor gone — ask again. */
  unclear: string[];
}

/**
 * The question, asked from inside the page.
 *
 * A navigation costs five seconds and a request costs less than one, and the difference is the whole
 * feasibility of doing this daily: half an hour against four hours on a catalogue of a few thousand.
 * It has to run in a page of the same site — a request from anywhere else carries no session and
 * every answer comes back as "sign in", which reads as "gone" for everything at once.
 */
const ASK = `(what) => fetch(what.url, { credentials: 'include' })
  .then((answer) => answer.text().then((body) => ({
    ok: answer.status < 400,
    gone: new RegExp(what.gone, 'i').test(body),
  })))
  .catch(() => ({ ok: false, gone: false }))`;

export async function revise(page: PageDriver, rule: AliveRule, ids: string[]): Promise<Revision> {
  const revision: Revision = { alive: [], gone: [], unclear: [] };

  for (const id of ids) {
    const url = rule.url.replace('{id}', encodeURIComponent(id));
    const answer = await page
      .evaluate<{ ok: boolean; gone: boolean }>(ASK, { url, gone: rule.gone })
      .catch(() => undefined);

    if (!answer || !answer.ok) revision.unclear.push(id);
    else if (answer.gone) revision.gone.push(id);
    else revision.alive.push(id);

    if (rule.pace) await page.waitMs(rule.pace);
  }

  return revision;
}
