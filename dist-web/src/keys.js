import { randomBytes, timingSafeEqual, createHash } from 'node:crypto';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { InputError } from './errors.js';
const PREFIX = 'rtk_';
export function keysFileFor(userId) {
    return join('secrets', 'keys', `${userId}.json`);
}
async function read(file) {
    try {
        return JSON.parse(await readFile(file, 'utf8'));
    }
    catch {
        return [];
    }
}
async function write(file, keys) {
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, `${JSON.stringify(keys, null, 2)}\n`, 'utf8');
    await chmod(file, 0o600);
}
/**
 * A plain hash, not scrypt.
 *
 * A password is short and guessable and must be expensive to test; this is thirty-two random bytes,
 * and nobody guesses those. What matters here instead is that a lookup stays fast — every scheduled
 * request carries one — and that the comparison does not leak by timing.
 */
function fingerprint(key) {
    return createHash('sha256').update(key).digest('hex');
}
export async function listKeys(file) {
    return (await read(file)).map(({ hash: _hash, ...view }) => view);
}
/** The only moment the key exists in readable form. */
export async function createKey(file, label) {
    const name = label.trim() || 'unnamed';
    if (name.length > 60)
        throw new InputError('give the key a shorter name');
    const key = PREFIX + randomBytes(24).toString('base64url');
    const view = {
        id: randomBytes(6).toString('hex'),
        label: name,
        createdAt: new Date().toISOString(),
        hint: `${key.slice(0, PREFIX.length + 4)}…`,
    };
    const keys = await read(file);
    keys.push({ ...view, hash: fingerprint(key) });
    await write(file, keys);
    return { key, view };
}
export async function revokeKey(file, id) {
    const keys = await read(file);
    const left = keys.filter((key) => key.id !== id);
    if (left.length === keys.length)
        throw new InputError('no such key');
    await write(file, left);
}
export function looksLikeKey(value) {
    return value.startsWith(PREFIX);
}
/**
 * Whose key is this? Every account's keys are checked, because a key carries no account in it — which
 * is deliberate: a credential that announces whose it is tells a stranger who to go after.
 */
export async function whoseKey(key, userIds, fileFor = keysFileFor) {
    const wanted = Buffer.from(fingerprint(key), 'hex');
    for (const userId of userIds) {
        const file = fileFor(userId);
        const keys = await read(file);
        for (const stored of keys) {
            const held = Buffer.from(stored.hash, 'hex');
            if (held.length === wanted.length && timingSafeEqual(held, wanted)) {
                // Worth knowing which key is still in use and which was set up once and forgotten.
                stored.lastUsedAt = new Date().toISOString();
                await write(file, keys).catch(() => undefined);
                return userId;
            }
        }
    }
    return undefined;
}
