import { randomUUID } from 'node:crypto';
import { chmod, mkdir, readdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { Api, TelegramClient } from 'telegram';
import type { SiftRule } from './scenario.js';
import { StringSession } from 'telegram/sessions/index.js';

/**
 * Telegram as a source.
 *
 * Public channels have a web preview (t.me/s/…) and need nothing special — an ordinary robot reads
 * them. Groups do not: there is no page to open, so the only way in is a real Telegram client with a
 * real account behind it.
 *
 * That account is the user's own, and so is the login: this file gives the pieces a UI needs to walk
 * somebody through it — send a code, take the code, take the 2FA password if there is one — and never
 * asks anyone else to handle those. The session that comes out is stored on the user's own machine
 * with owner-only permissions, and can be deleted from the same UI.
 */
export interface TelegramRobot {
  name: string;
  version: 1;
  source: 'telegram';
  /** Which connected account reads these channels. Absent means the only one there is. */
  account?: string;
  /** Channel or group usernames, without the @. */
  channels: string[];
  /** How many recent messages to take from each. */
  limit: number;
  /** Optional case-insensitive substrings; a message must contain one of them to count. */
  contains?: string[];
  /** Which messages count, and what to read out of them. Built once by a model, run by regex. */
  sift?: SiftRule;
  /** Whether to hand back only what has not been seen before. A bot reposting is not news. */
  remember?: { by?: string; days?: number; mode?: 'new' | 'all' };
}

export function isTelegramRobot(value: unknown): value is TelegramRobot {
  return typeof value === 'object' && value !== null && (value as { source?: string }).source === 'telegram';
}

export function parseTelegramRobot(data: unknown): TelegramRobot {
  const robot = data as TelegramRobot;
  if (!Array.isArray(robot.channels) || robot.channels.length === 0) {
    throw new Error(`${robot.name ?? 'robot'}: a telegram robot needs at least one channel`);
  }
  return { ...robot, version: 1, source: 'telegram', limit: robot.limit ?? 100 };
}

// --- credentials and session ------------------------------------------------------------------

const DEFAULT_SESSION_FILE = process.env['RATATOSK_TG_SESSION'] ?? 'secrets/telegram.json';

/** Whose session this is. One file per connected Telegram account, inside that user's own directory. */
export type SessionFile = string;

export function telegramDirFor(userId: string): string {
  return join('secrets', 'telegram', userId);
}

export function telegramAccountFile(userId: string, accountId: string): string {
  return join(telegramDirFor(userId), `${accountId}.json`);
}

/**
 * Every account this user has connected. One used to be the limit — a single file per user — so a file
 * left over from then is moved in rather than forgotten.
 */
export async function listTelegramAccounts(userId: string): Promise<Array<TelegramState & { id: string }>> {
  const dir = telegramDirFor(userId);
  await mkdir(dir, { recursive: true });

  const legacy = join('secrets', 'telegram', `${userId}.json`);
  try {
    await readFile(legacy, 'utf8');
    await rename(legacy, join(dir, `${randomUUID().slice(0, 8)}.json`));
  } catch {
    // No leftover, which is the normal case.
  }

  const files = (await readdir(dir)).filter((file) => file.endsWith('.json'));
  const accounts = [];
  for (const file of files) {
    const id = file.replace(/\.json$/, '');
    const state = await telegramStatus(join(dir, file));
    if (state.connected) accounts.push({ ...state, id });
  }
  return accounts;
}

/** The session a robot should read with: the one it names, or the only one connected. */
export async function sessionForRobot(userId: string, accountId?: string): Promise<SessionFile | undefined> {
  const accounts = await listTelegramAccounts(userId);
  const chosen = accountId ? accounts.find((account) => account.id === accountId) : accounts[0];
  return chosen ? telegramAccountFile(userId, chosen.id) : undefined;
}

interface Stored {
  apiId: number;
  apiHash: string;
  session: string;
  account?: string;
  phone?: string;
  connectedAt?: string;
  lastCheck?: TelegramCheck;
}

/** What the operator view is allowed to know about a connection: enough to recognise it, no secrets. */
export interface TelegramState {
  connected: boolean;
  account?: string;
  phone?: string;
  connectedAt?: string;
  apiId?: number;
  /** Filled by an explicit check: the session was used just now and still works. */
  alive?: boolean;
  dialogs?: number;
  /** Whether this account can still read each channel its robots depend on. */
  access?: Array<{ channel: string; ok: boolean; note: string }>;
  /** What the last explicit check saw. Kept in the file, so pressing the button leaves a mark. */
  lastCheck?: TelegramCheck;
}

export interface TelegramCheck {
  at: string;
  ok: boolean;
  note: string;
  dialogs?: number;
  access?: Array<{ channel: string; ok: boolean; note: string }>;
}

async function readStored(file: SessionFile = DEFAULT_SESSION_FILE): Promise<Stored | undefined> {
  try {
    return JSON.parse(await readFile(file, 'utf8')) as Stored;
  } catch {
    return undefined;
  }
}

async function writeStored(stored: Stored, file: SessionFile = DEFAULT_SESSION_FILE): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(stored, null, 2)}\n`, 'utf8');
  await chmod(file, 0o600);
}

export async function telegramStatus(file?: SessionFile): Promise<TelegramState> {
  const stored = await readStored(file);
  if (!stored) return { connected: false };
  return {
    connected: true,
    account: stored.account,
    phone: stored.phone,
    connectedAt: stored.connectedAt,
    apiId: stored.apiId,
    ...(stored.lastCheck
      ? {
          lastCheck: stored.lastCheck,
          alive: stored.lastCheck.ok,
          ...(stored.lastCheck.dialogs === undefined ? {} : { dialogs: stored.lastCheck.dialogs }),
          ...(stored.lastCheck.access ? { access: stored.lastCheck.access } : {}),
        }
      : {}),
  };
}

/**
 * Write down what a check saw. A verdict that is only returned to the browser disappears on the next
 * render — the button then looks broken, because nothing on the page changes when it is pressed.
 */
export async function rememberTelegramCheck(file: SessionFile | undefined, check: TelegramCheck): Promise<void> {
  const stored = await readStored(file);
  if (!stored) return;
  await writeStored({ ...stored, lastCheck: check }, file);
}

/**
 * A stored session can stop working without anyone touching it — the account can log this device out
 * from another phone. So "connected" is only ever a claim until it is used: this uses it.
 */
export async function telegramCheck(file?: SessionFile, channels: string[] = []): Promise<TelegramState> {
  const stored = await readStored(file);
  if (!stored) return { connected: false };

  const client = new TelegramClient(new StringSession(stored.session), stored.apiId, stored.apiHash, {
    connectionRetries: 2,
  });
  try {
    await client.connect();
    const me = (await client.getMe()) as { username?: string; firstName?: string } | undefined;
    if (!me) throw new Error('the session is no longer signed in');
    const dialogs = await client.getDialogs({ limit: 100 });

    // Being signed in is not the same as still being in the group. Each channel a robot reads is
    // tried for real, because "connected" that cannot read anything is a lie a person acts on.
    const access = [];
    for (const channel of channels) {
      try {
        const entity = await client.getEntity(channel);
        const [message] = await client.getMessages(entity, { limit: 1 });
        access.push({
          channel,
          ok: true,
          note: message?.date
            ? `readable, last message ${new Date(message.date * 1000).toISOString().slice(0, 16).replace('T', ' ')}`
            : 'readable, no messages',
        });
      } catch (error) {
        access.push({
          channel,
          ok: false,
          note: error instanceof Error ? (error.message.split('\n')[0] ?? error.message).slice(0, 90) : 'not reachable',
        });
      }
    }

    const account = me.username ? `@${me.username}` : (me.firstName ?? stored.account);
    const unreadable = access.filter((entry) => !entry.ok).length;
    const check: TelegramCheck = {
      at: new Date().toISOString(),
      ok: unreadable === 0,
      note: `signed in as ${account ?? 'this account'}, ${dialogs.length} chats visible${
        unreadable ? `, ${unreadable} of ${access.length} channels unreadable` : ''
      }`,
      dialogs: dialogs.length,
      access,
    };
    await rememberTelegramCheck(file, check);

    return {
      ...(await telegramStatus(file)),
      ...(account ? { account } : {}),
      alive: true,
      dialogs: dialogs.length,
      access,
      lastCheck: check,
    };
  } catch (error) {
    const message = error instanceof Error ? (error.message.split('\n')[0] ?? error.message) : String(error);
    // A failed check is worth remembering too: that is the moment the account stopped working.
    await rememberTelegramCheck(file, { at: new Date().toISOString(), ok: false, note: message });
    throw new Error(`that connection no longer works — ${message}. Disconnect and connect again.`);
  } finally {
    await client.disconnect().catch(() => undefined);
  }
}

export async function telegramForget(file: SessionFile = DEFAULT_SESSION_FILE): Promise<void> {
  await unlink(file).catch(() => undefined);
}

// --- logging in -------------------------------------------------------------------------------

/** A login in progress: the client must stay alive between "send code" and "here is the code". */
const pending = new Map<string, { client: TelegramClient; apiId: number; apiHash: string; phoneCodeHash: string }>();

export async function telegramSendCode(input: {
  apiId: number;
  apiHash: string;
  phone: string;
  file?: SessionFile;
}): Promise<{ sent: true }> {
  const client = new TelegramClient(new StringSession(''), input.apiId, input.apiHash, { connectionRetries: 3 });
  await client.connect();
  const { phoneCodeHash } = await client.sendCode({ apiId: input.apiId, apiHash: input.apiHash }, input.phone);
  pending.set(`${input.file ?? DEFAULT_SESSION_FILE}|${input.phone}`, {
    client,
    apiId: input.apiId,
    apiHash: input.apiHash,
    phoneCodeHash,
  });
  return { sent: true };
}

export async function telegramSignIn(input: {
  phone: string;
  code: string;
  password?: string;
  file?: SessionFile;
}): Promise<{ account: string }> {
  const key = `${input.file ?? DEFAULT_SESSION_FILE}|${input.phone}`;
  const waiting = pending.get(key);
  if (!waiting) throw new Error('no login is in progress for that number — send the code again');

  const { client, apiId, apiHash, phoneCodeHash } = waiting;
  try {
    await client.invoke(
      new Api.auth.SignIn({ phoneNumber: input.phone, phoneCodeHash, phoneCode: input.code }),
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.includes('SESSION_PASSWORD_NEEDED')) throw error;
    if (!input.password) throw new Error('this account has two-step verification — the password is needed as well');
    await client.signInWithPassword(
      { apiId, apiHash },
      { password: async () => input.password!, onError: (e) => { throw e; } },
    );
  }

  const me = (await client.getMe()) as { username?: string; firstName?: string; phone?: string };
  const account = me.username ? `@${me.username}` : me.firstName ?? input.phone;
  await writeStored(
    {
      apiId,
      apiHash,
      session: (client.session as StringSession).save(),
      account,
      phone: input.phone,
      connectedAt: new Date().toISOString(),
    },
    input.file,
  );

  await client.disconnect();
  pending.delete(key);
  return { account };
}

// --- reading ----------------------------------------------------------------------------------

export interface TelegramRow extends Record<string, string | null> {
  channel: string;
  id: string;
  date: string;
  text: string;
  link: string;
}

/**
 * Read the recent messages of each channel. Groups included — that is the whole point of coming in
 * through a client instead of a page.
 */
export async function runTelegramRobot(
  robot: TelegramRobot,
  file?: SessionFile,
): Promise<{ rows: TelegramRow[]; reason?: string }> {
  const stored = await readStored(file);
  if (!stored) {
    return { rows: [], reason: 'no Telegram account is connected — connect one in the Telegram section first' };
  }

  const client = new TelegramClient(new StringSession(stored.session), stored.apiId, stored.apiHash, {
    connectionRetries: 3,
  });
  await client.connect();

  try {
    const rows: TelegramRow[] = [];
    const wanted = (robot.contains ?? []).map((word) => word.toLowerCase());

    for (const channel of robot.channels) {
      const entity = await client.getEntity(channel);
      for await (const message of client.iterMessages(entity, { limit: robot.limit })) {
        const text = (message.message ?? '').trim();
        if (!text) continue;
        if (wanted.length && !wanted.some((word) => text.toLowerCase().includes(word))) continue;
        rows.push({
          channel,
          id: String(message.id),
          date: new Date(message.date * 1000).toISOString(),
          text,
          link: `https://t.me/${channel.replace(/^@/, '')}/${message.id}`,
        });
      }
    }

    return { rows };
  } finally {
    await client.disconnect();
  }
}
