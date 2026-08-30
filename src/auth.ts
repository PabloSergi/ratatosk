import { createHmac, randomBytes, randomUUID, scrypt, timingSafeEqual } from 'node:crypto';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';

/**
 * Accounts, kept deliberately small: an email, a password nobody can read back, and a signed token.
 *
 * No email confirmation yet — that is a decision, not an oversight, and it is written down here so the
 * next person knows it was chosen rather than forgotten. What is NOT skipped: passwords are stored as
 * salted scrypt hashes, comparisons are constant-time, the signing secret is generated once and kept
 * out of the repository, and every account gets its own robots and its own Telegram session. Sharing
 * those would not be a feature to add later — it would be a leak shipped today.
 */
const scryptAsync = promisify(scrypt);

export interface User {
  id: string;
  email: string;
  createdAt: string;
}

interface StoredUser extends User {
  salt: string;
  hash: string;
}

const USERS_FILE = process.env['RATATOSK_USERS'] ?? 'secrets/users.json';
const SECRET_FILE = process.env['RATATOSK_JWT_SECRET_FILE'] ?? 'secrets/jwt.key';
const TOKEN_TTL_SECONDS = Number(process.env['RATATOSK_TOKEN_TTL'] ?? 60 * 60 * 24 * 30);

export class AuthError extends Error {}

// --- accounts ---------------------------------------------------------------------------------

async function readUsers(): Promise<StoredUser[]> {
  try {
    return JSON.parse(await readFile(USERS_FILE, 'utf8')) as StoredUser[];
  } catch {
    return [];
  }
}

async function writeUsers(users: StoredUser[]): Promise<void> {
  await mkdir(dirname(USERS_FILE), { recursive: true });
  await writeFile(USERS_FILE, `${JSON.stringify(users, null, 2)}\n`, 'utf8');
  await chmod(USERS_FILE, 0o600);
}

async function hash(password: string, salt: string): Promise<string> {
  return ((await scryptAsync(password, salt, 64)) as Buffer).toString('hex');
}

export async function registerUser(email: string, password: string): Promise<User> {
  const address = email.trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(address)) throw new AuthError('that does not look like an email address');
  if (password.length < 8) throw new AuthError('the password needs at least 8 characters');

  const users = await readUsers();
  if (users.some((user) => user.email === address)) throw new AuthError('that email is already registered — sign in instead');

  const salt = randomBytes(16).toString('hex');
  const user: StoredUser = {
    id: randomUUID(),
    email: address,
    createdAt: new Date().toISOString(),
    salt,
    hash: await hash(password, salt),
  };
  await writeUsers([...users, user]);
  return { id: user.id, email: user.email, createdAt: user.createdAt };
}

export async function verifyUser(email: string, password: string): Promise<User> {
  const address = email.trim().toLowerCase();
  const users = await readUsers();
  const found = users.find((user) => user.email === address);

  // Same work and the same answer whether the account exists or not: a login form should not tell a
  // stranger which addresses are registered.
  const salt = found?.salt ?? 'no-such-user';
  const attempt = await hash(password, salt);
  const expected = found?.hash ?? attempt.replace(/./g, '0');
  const same = attempt.length === expected.length && timingSafeEqual(Buffer.from(attempt), Buffer.from(expected));

  if (!found || !same) throw new AuthError('wrong email or password');
  return { id: found.id, email: found.email, createdAt: found.createdAt };
}

export async function countUsers(): Promise<number> {
  return (await readUsers()).length;
}

/** Who exists, for the parts that hold a credential without an account attached to it. */
export async function userIds(): Promise<string[]> {
  return (await readUsers()).map((user) => user.id);
}

export async function findUser(id: string): Promise<User | undefined> {
  const stored = (await readUsers()).find((user) => user.id === id);
  return stored ? { id: stored.id, email: stored.email, createdAt: stored.createdAt } : undefined;
}

// --- tokens -----------------------------------------------------------------------------------

let cachedSecret: string | undefined;

async function secret(): Promise<string> {
  if (cachedSecret) return cachedSecret;
  if (process.env['RATATOSK_JWT_SECRET']) return (cachedSecret = process.env['RATATOSK_JWT_SECRET']);
  try {
    cachedSecret = (await readFile(SECRET_FILE, 'utf8')).trim();
  } catch {
    cachedSecret = randomBytes(48).toString('hex');
    await mkdir(dirname(SECRET_FILE), { recursive: true });
    await writeFile(SECRET_FILE, `${cachedSecret}\n`, 'utf8');
    await chmod(SECRET_FILE, 0o600);
  }
  return cachedSecret;
}

const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');

export async function issueToken(user: User): Promise<{ token: string; expiresAt: string }> {
  const issued = Math.floor(Date.now() / 1000);
  const payload = { sub: user.id, email: user.email, iat: issued, exp: issued + TOKEN_TTL_SECONDS };
  const body = `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode(payload)}`;
  const signature = createHmac('sha256', await secret()).update(body).digest('base64url');
  return { token: `${body}.${signature}`, expiresAt: new Date(payload.exp * 1000).toISOString() };
}

export async function verifyToken(token: string): Promise<{ id: string; email: string }> {
  const parts = token.split('.');
  if (parts.length !== 3) throw new AuthError('malformed token');

  const body = `${parts[0]}.${parts[1]}`;
  const expected = createHmac('sha256', await secret()).update(body).digest('base64url');
  const given = parts[2]!;
  if (given.length !== expected.length || !timingSafeEqual(Buffer.from(given), Buffer.from(expected))) {
    throw new AuthError('token signature does not match');
  }

  const payload = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf8')) as {
    sub: string;
    email: string;
    exp: number;
  };
  if (payload.exp * 1000 < Date.now()) throw new AuthError('token has expired — sign in again');
  return { id: payload.sub, email: payload.email };
}

// --- where a user's things live ---------------------------------------------------------------

/** Every account keeps its own robots and its own Telegram session. Nothing is shared by accident. */
export function robotsDirFor(userId: string): string {
  return join(process.env['RATATOSK_ROBOTS'] ?? 'robots', 'u', userId);
}

export function telegramFileFor(userId: string): string {
  return join('secrets', 'telegram', `${userId}.json`);
}
