import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { InputError } from './errors.js';
import type { Standing } from './history.js';

/**
 * Being told when a scraper stops working.
 *
 * The product's claim is that a scraper says when it breaks. Until now it said so on a screen, which
 * means it says so to whoever happens to open that screen — and a scraper on a schedule breaks at four
 * in the morning on a Tuesday and is discovered on Friday, by which point the table downstream has
 * been quietly wrong for three days.
 *
 * So a run can tell somebody. Three decisions matter and all three are about not becoming noise:
 *
 * - **One bad run is not a breakage.** A site hiccups, a proxy blinks, a page takes too long. Only a
 *   streak counts, and how long a streak has to be is the owner's to set.
 * - **One message per breakage, not per run.** A scraper running every half hour must not send forty
 *   eight messages a day about the same dead selector. The streak length that triggered it is written
 *   down, and nothing more is said until the state changes.
 * - **Recovery is worth exactly one message too.** Otherwise the only way to learn that something is
 *   fine again is to go and look, which is the problem this exists to solve.
 */
export interface Alerts {
  /** A bot token from @BotFather. Stored owner-only and never handed back whole. */
  botToken?: string;
  /** Who the bot writes to: a chat id, from @userinfobot or the bot's own getUpdates. */
  chatId?: string;
  /** How many runs in a row have to go wrong before it counts as broken. */
  after?: number;
  /** What was last said about each scraper, so the same thing is not said twice. */
  told?: Record<string, { status: string; inARow: number; at: string }>;
}

export const DEFAULT_AFTER = 3;

export function alertsFileFor(userId: string): string {
  return join('secrets', 'alerts', `${userId}.json`);
}

export async function readAlerts(file: string): Promise<Alerts> {
  try {
    return JSON.parse(await readFile(file, 'utf8')) as Alerts;
  } catch {
    return {};
  }
}

export async function writeAlerts(file: string, alerts: Alerts): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  const temporary = `${file}.writing`;
  await writeFile(temporary, `${JSON.stringify(alerts, null, 2)}\n`, 'utf8');
  await chmod(temporary, 0o600);
  await rename(temporary, file);
}

/** What an account may see about its own alerts: everything except the token itself. */
export function viewAlerts(alerts: Alerts): { on: boolean; chatId?: string; after: number; tokenHint?: string } {
  return {
    on: Boolean(alerts.botToken && alerts.chatId),
    ...(alerts.chatId ? { chatId: alerts.chatId } : {}),
    after: alerts.after ?? DEFAULT_AFTER,
    ...(alerts.botToken ? { tokenHint: `…${alerts.botToken.slice(-4)}` } : {}),
  };
}

export type Telling = { say: string; about: string; kind: 'broken' | 'recovered' } | undefined;

/**
 * Is there anything to say about this scraper, and has it been said already?
 *
 * Pure, and separate from the sending, because this is the part that can be wrong in a way nobody
 * notices: sending too often is a feature people turn off, and sending too rarely is a feature that
 * does not exist.
 */
export function whatToSay(now: Standing, alerts: Alerts): Telling {
  const after = alerts.after ?? DEFAULT_AFTER;
  const told = alerts.told?.[now.robot];

  if (now.status === 'ok') {
    // Only worth saying if somebody was told it was broken; a scraper that has always been fine is not
    // news every half hour.
    if (!told || told.status === 'ok') return undefined;
    return {
      kind: 'recovered',
      about: now.robot,
      say: `✅ ${now.robot} is working again — ${now.rows} rows at ${when(now.at)}.`,
    };
  }

  if (now.inARow < after) return undefined; // one bad run is weather, not a verdict
  if (told && told.status === now.status) return undefined; // already said, and nothing has changed since

  const trouble = now.door
    ? 'the page is a check meant for a person'
    : (now.why ?? (now.status === 'empty' ? 'it came back with nothing' : 'it could not read the page'));

  return {
    kind: 'broken',
    about: now.robot,
    say:
      `⚠️ ${now.robot} — ${now.status} ${now.inARow} runs in a row.\n${trouble}\n` +
      (now.door ? 'Open it yourself from the scrapers view and pass the door once.' : 'Repair rebuilds it and shows what changed.'),
  };
}

/** Sending it. Nothing here decides anything; the deciding is above and is tested without a network. */
export async function tell(alerts: Alerts, text: string, fetcher = fetch): Promise<void> {
  if (!alerts.botToken || !alerts.chatId) throw new InputError('no bot token or chat id — set them up first');

  const answer = await fetcher(`https://api.telegram.org/bot${alerts.botToken}/sendMessage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chat_id: alerts.chatId, text, disable_web_page_preview: true }),
  });

  if (!answer.ok) {
    const body = (await answer.json().catch(() => ({}))) as { description?: string };
    // Telegram's own words are more useful than ours: "chat not found", "bot was blocked by the user".
    throw new InputError(`Telegram refused: ${body.description ?? answer.status}`);
  }
}

function when(at: string): string {
  return new Date(at).toISOString().replace('T', ' ').slice(0, 16);
}
