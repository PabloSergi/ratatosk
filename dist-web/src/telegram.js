import { randomUUID } from 'node:crypto';
import { chmod, mkdir, readdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { Api, TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';
export function isTelegramRobot(value) {
    return typeof value === 'object' && value !== null && value.source === 'telegram';
}
export function parseTelegramRobot(data) {
    const robot = data;
    if (!Array.isArray(robot.channels) || robot.channels.length === 0) {
        throw new Error(`${robot.name ?? 'robot'}: a telegram robot needs at least one channel`);
    }
    return { ...robot, version: 1, source: 'telegram', limit: robot.limit ?? 100 };
}
// --- credentials and session ------------------------------------------------------------------
const DEFAULT_SESSION_FILE = process.env['RATATOSK_TG_SESSION'] ?? 'secrets/telegram.json';
export function telegramDirFor(userId) {
    return join('secrets', 'telegram', userId);
}
export function telegramAccountFile(userId, accountId) {
    return join(telegramDirFor(userId), `${accountId}.json`);
}
/**
 * Every account this user has connected. One used to be the limit — a single file per user — so a file
 * left over from then is moved in rather than forgotten.
 */
export async function listTelegramAccounts(userId) {
    const dir = telegramDirFor(userId);
    await mkdir(dir, { recursive: true });
    const legacy = join('secrets', 'telegram', `${userId}.json`);
    try {
        await readFile(legacy, 'utf8');
        await rename(legacy, join(dir, `${randomUUID().slice(0, 8)}.json`));
    }
    catch {
        // No leftover, which is the normal case.
    }
    const files = (await readdir(dir)).filter((file) => file.endsWith('.json'));
    const accounts = [];
    for (const file of files) {
        const id = file.replace(/\.json$/, '');
        const state = await telegramStatus(join(dir, file));
        if (state.connected)
            accounts.push({ ...state, id });
    }
    return accounts;
}
/** The session a robot should read with: the one it names, or the only one connected. */
export async function sessionForRobot(userId, accountId) {
    const accounts = await listTelegramAccounts(userId);
    const chosen = accountId ? accounts.find((account) => account.id === accountId) : accounts[0];
    return chosen ? telegramAccountFile(userId, chosen.id) : undefined;
}
async function readStored(file = DEFAULT_SESSION_FILE) {
    try {
        return JSON.parse(await readFile(file, 'utf8'));
    }
    catch {
        return undefined;
    }
}
async function writeStored(stored, file = DEFAULT_SESSION_FILE) {
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, `${JSON.stringify(stored, null, 2)}\n`, 'utf8');
    await chmod(file, 0o600);
}
export async function telegramStatus(file) {
    const stored = await readStored(file);
    if (!stored)
        return { connected: false };
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
export async function rememberTelegramCheck(file, check) {
    const stored = await readStored(file);
    if (!stored)
        return;
    await writeStored({ ...stored, lastCheck: check }, file);
}
/**
 * A stored session can stop working without anyone touching it — the account can log this device out
 * from another phone. So "connected" is only ever a claim until it is used: this uses it.
 */
export async function telegramCheck(file, channels = []) {
    const stored = await readStored(file);
    if (!stored)
        return { connected: false };
    const client = new TelegramClient(new StringSession(stored.session), stored.apiId, stored.apiHash, {
        connectionRetries: 2,
    });
    try {
        await client.connect();
        const me = (await client.getMe());
        if (!me)
            throw new Error('the session is no longer signed in');
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
            }
            catch (error) {
                access.push({
                    channel,
                    ok: false,
                    note: error instanceof Error ? (error.message.split('\n')[0] ?? error.message).slice(0, 90) : 'not reachable',
                });
            }
        }
        const account = me.username ? `@${me.username}` : (me.firstName ?? stored.account);
        const unreadable = access.filter((entry) => !entry.ok).length;
        const check = {
            at: new Date().toISOString(),
            ok: unreadable === 0,
            note: `signed in as ${account ?? 'this account'}, ${dialogs.length} chats visible${unreadable ? `, ${unreadable} of ${access.length} channels unreadable` : ''}`,
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
    }
    catch (error) {
        const message = error instanceof Error ? (error.message.split('\n')[0] ?? error.message) : String(error);
        // A failed check is worth remembering too: that is the moment the account stopped working.
        await rememberTelegramCheck(file, { at: new Date().toISOString(), ok: false, note: message });
        throw new Error(`that connection no longer works — ${message}. Disconnect and connect again.`);
    }
    finally {
        await client.disconnect().catch(() => undefined);
    }
}
export async function telegramForget(file = DEFAULT_SESSION_FILE) {
    await unlink(file).catch(() => undefined);
}
// --- logging in -------------------------------------------------------------------------------
/** A login in progress: the client must stay alive between "send code" and "here is the code". */
const pending = new Map();
export async function telegramSendCode(input) {
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
export async function telegramSignIn(input) {
    const key = `${input.file ?? DEFAULT_SESSION_FILE}|${input.phone}`;
    const waiting = pending.get(key);
    if (!waiting)
        throw new Error('no login is in progress for that number — send the code again');
    const { client, apiId, apiHash, phoneCodeHash } = waiting;
    try {
        await client.invoke(new Api.auth.SignIn({ phoneNumber: input.phone, phoneCodeHash, phoneCode: input.code }));
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!message.includes('SESSION_PASSWORD_NEEDED'))
            throw error;
        if (!input.password)
            throw new Error('this account has two-step verification — the password is needed as well');
        await client.signInWithPassword({ apiId, apiHash }, { password: async () => input.password, onError: (e) => { throw e; } });
    }
    const me = (await client.getMe());
    const account = me.username ? `@${me.username}` : me.firstName ?? input.phone;
    await writeStored({
        apiId,
        apiHash,
        session: client.session.save(),
        account,
        phone: input.phone,
        connectedAt: new Date().toISOString(),
    }, input.file);
    await client.disconnect();
    pending.delete(key);
    return { account };
}
/**
 * Read the recent messages of each channel. Groups included — that is the whole point of coming in
 * through a client instead of a page.
 */
export async function runTelegramRobot(robot, file) {
    const stored = await readStored(file);
    if (!stored) {
        return { rows: [], reason: 'no Telegram account is connected — connect one in the Telegram section first' };
    }
    const client = new TelegramClient(new StringSession(stored.session), stored.apiId, stored.apiHash, {
        connectionRetries: 3,
    });
    await client.connect();
    try {
        const rows = [];
        const wanted = (robot.contains ?? []).map((word) => word.toLowerCase());
        for (const channel of robot.channels) {
            const entity = await client.getEntity(channel);
            for await (const message of client.iterMessages(entity, { limit: robot.limit })) {
                const text = (message.message ?? '').trim();
                if (!text)
                    continue;
                if (wanted.length && !wanted.some((word) => text.toLowerCase().includes(word)))
                    continue;
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
    }
    finally {
        await client.disconnect();
    }
}
