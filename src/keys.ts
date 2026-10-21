import { randomBytes, timingSafeEqual, createHash } from 'node:crypto';
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { InputError } from './errors.js';
import { projectName } from './projects.js';

/**
 * Keys for the machines.
 *
 * A person signs in and gets a token that expires, which is right for a person and wrong for a
 * schedule: an automation set up today should not stop working in a month because a login aged out.
 * So a machine gets its own credential — long-lived, named, revocable one at a time, and never the
 * same secret as the account's password.
 *
 * Stored as a hash, like a password, because a file of working keys is a file worth stealing. The key
 * itself is shown once, at the moment it is made, and never again.
 */
export interface KeyView {
  id: string;
  label: string;
  createdAt: string;
  lastUsedAt?: string;
  /** The first characters, so a key in a list can be recognised without being usable. */
  hint: string;
  /**
   * The one project this key may see. A key without one sees the whole account, as keys always did; a
   * key with one is what a product's own automation should carry, so that it can ask for "all of mine"
   * and never needs to know, or be able to learn, what else this account is scraping.
   */
  project?: string;
}

interface StoredKey extends KeyView {
  hash: string;
}

const PREFIX = 'rtk_';

export function keysFileFor(userId: string): string {
  return join('secrets', 'keys', `${userId}.json`);
}

async function read(file: string): Promise<StoredKey[]> {
  try {
    return JSON.parse(await readFile(file, 'utf8')) as StoredKey[];
  } catch {
    return [];
  }
}

/**
 * Written whole into a file beside it and moved over it, so a reader never meets half a list — a
 * half-written keys file reads as no keys at all, and every machine is locked out until the next write.
 */
async function write(file: string, keys: StoredKey[]): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  const fresh = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  await writeFile(fresh, `${JSON.stringify(keys, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  await chmod(fresh, 0o600);
  await rename(fresh, file);
}

/**
 * One change to a keys file at a time.
 *
 * Every request carrying a key also writes when it was last used, and that write is a read, a change
 * and a write back. Two of them overlapping is how a key made in between disappears: the slower one
 * writes back the list it read before the key existed. So every change waits for the one before it,
 * and reads the file only once it is its turn.
 */
const turns = new Map<string, Promise<unknown>>();

function change<T>(file: string, work: (keys: StoredKey[]) => Promise<T>): Promise<T> {
  const mine = (turns.get(file) ?? Promise.resolve()).then(async () => work(await read(file)));
  const settled = mine.catch(() => undefined);
  turns.set(file, settled);
  void settled.then(() => {
    if (turns.get(file) === settled) turns.delete(file);
  });
  return mine;
}

/** How stale "last used" may get. A schedule calling every minute does not need a write every minute. */
const USED_EVERY_MS = 60_000;

/**
 * A plain hash, not scrypt.
 *
 * A password is short and guessable and must be expensive to test; this is thirty-two random bytes,
 * and nobody guesses those. What matters here instead is that a lookup stays fast — every scheduled
 * request carries one — and that the comparison does not leak by timing.
 */
function fingerprint(key: string): string {
  return createHash('sha256').update(key).digest('hex');
}

export async function listKeys(file: string): Promise<KeyView[]> {
  return (await read(file)).map(({ hash: _hash, ...view }) => view);
}

/** The only moment the key exists in readable form. */
export async function createKey(
  file: string,
  label: string,
  project?: string,
): Promise<{ key: string; view: KeyView }> {
  const name = label.trim() || 'unnamed';
  if (name.length > 60) throw new InputError('give the key a shorter name');
  const bound = project ? projectName(project) : undefined;

  const key = PREFIX + randomBytes(24).toString('base64url');
  const view: KeyView = {
    id: randomBytes(6).toString('hex'),
    label: name,
    createdAt: new Date().toISOString(),
    hint: `${key.slice(0, PREFIX.length + 4)}…`,
    ...(bound ? { project: bound } : {}),
  };

  await change(file, async (keys) => {
    keys.push({ ...view, hash: fingerprint(key) });
    await write(file, keys);
  });
  return { key, view };
}

export async function revokeKey(file: string, id: string): Promise<void> {
  await change(file, async (keys) => {
    const left = keys.filter((key) => key.id !== id);
    if (left.length === keys.length) throw new InputError('no such key');
    await write(file, left);
  });
}

/**
 * Bind a key that already exists to one project, or set it free again.
 *
 * So that narrowing what an automation can see does not mean issuing it a new secret and editing it into
 * every workflow that carries the old one: the key stays the same string, and from the next request on
 * it simply sees less.
 */
export async function bindKey(file: string, id: string, project?: string): Promise<KeyView> {
  const bound = project ? projectName(project) : undefined;
  return change(file, async (keys) => {
    const key = keys.find((one) => one.id === id);
    if (!key) throw new InputError('no such key');
    if (bound) key.project = bound;
    else delete key.project;
    await write(file, keys);
    const { hash: _hash, ...view } = key;
    return view;
  });
}

export function looksLikeKey(value: string): boolean {
  return value.startsWith(PREFIX);
}

/**
 * Whose key is this, and what may it see? Every account's keys are checked, because a key carries no
 * account in it — which is deliberate: a credential that announces whose it is tells a stranger who to
 * go after.
 */
export async function whichKey(
  key: string,
  userIds: string[],
  fileFor: (userId: string) => string = keysFileFor,
): Promise<{ userId: string; project?: string } | undefined> {
  const wanted = Buffer.from(fingerprint(key), 'hex');

  for (const userId of userIds) {
    const file = fileFor(userId);
    for (const stored of await read(file)) {
      const held = Buffer.from(stored.hash, 'hex');
      if (held.length === wanted.length && timingSafeEqual(held, wanted)) {
        await noteUse(file, stored.id).catch(() => undefined);
        return { userId, ...(stored.project ? { project: stored.project } : {}) };
      }
    }
  }
  return undefined;
}

/** Whose key is this — for callers that need only the account. */
export async function whoseKey(
  key: string,
  userIds: string[],
  fileFor: (userId: string) => string = keysFileFor,
): Promise<string | undefined> {
  return (await whichKey(key, userIds, fileFor))?.userId;
}

/** Worth knowing which key is still in use and which was set up once and forgotten. */
async function noteUse(file: string, id: string): Promise<void> {
  await change(file, async (keys) => {
    const key = keys.find((one) => one.id === id);
    const now = Date.now();
    if (!key || (key.lastUsedAt && now - Date.parse(key.lastUsedAt) < USED_EVERY_MS)) return;
    key.lastUsedAt = new Date(now).toISOString();
    await write(file, keys);
  });
}
