import { randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { InputError } from './errors.js';
import { dirname, join } from 'node:path';

/**
 * Model connections — plural, deliberately.
 *
 * The agent speaks one protocol: OpenAI-style chat completions with tool calls. OpenRouter is only an
 * address for it, and so are OpenAI, Groq, DeepSeek, Together and Anthropic's compatible layer. So a
 * connection is nothing more than "where, with which key, which model", and an account may keep
 * several — a cheap one for ordinary sites, a strong one for the awkward ones.
 *
 * Keys live in an owner-only file and are shown afterwards as their last four characters, never whole.
 */
export interface Connection {
  id: string;
  label: string;
  provider: ProviderId;
  baseUrl: string;
  key: string;
  model: string;
  addedAt: string;
  lastCheck?: { at: string; note: string; ok: boolean };
}

export interface ConnectionView {
  id: string;
  label: string;
  provider: ProviderId;
  baseUrl: string;
  model: string;
  keyHint: string;
  /** The one that builds robots and rules: a thinking job, done once. */
  active: boolean;
  /** The one that runs them: the second opinion on borderline rows, on every run. */
  runs: boolean;
  lastCheck?: Connection['lastCheck'];
}

export type ProviderId = 'openrouter' | 'openai' | 'anthropic' | 'groq' | 'custom';

/** Where each provider lives and what to call it. Adding one is a line here, not a code change. */
export const PROVIDERS: Record<ProviderId, { label: string; baseUrl: string; keysAt?: string; note?: string }> = {
  openrouter: {
    label: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    keysAt: 'https://openrouter.ai/keys',
    note: 'one key, every model, prices listed live',
  },
  openai: { label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', keysAt: 'https://platform.openai.com/api-keys' },
  anthropic: {
    label: 'Anthropic (Claude)',
    baseUrl: 'https://api.anthropic.com/v1',
    keysAt: 'https://console.anthropic.com/settings/keys',
    note: 'through their OpenAI-compatible endpoint',
  },
  groq: { label: 'Groq', baseUrl: 'https://api.groq.com/openai/v1', keysAt: 'https://console.groq.com/keys' },
  custom: { label: 'Anything OpenAI-compatible', baseUrl: '', note: 'give the base URL yourself' },
};

export const DEFAULT_MODEL = process.env['RATATOSK_MODEL'] ?? 'openai/gpt-5-nano';

interface Stored {
  connections: Connection[];
  activeId?: string;
  /**
   * The cheap one, for the work that happens on every run.
   *
   * Building a robot or a rule is a thinking job that happens once and is worth a good model. Judging
   * a handful of borderline rows happens on every single run, forever, and is worth the cheapest thing
   * that can read. One setting for both means choosing which of the two to do badly.
   */
  runId?: string;
  /** The shape this file had before connections were plural. Read once, then migrated. */
  openrouterKey?: string;
  model?: string;
}

export function settingsFileFor(userId: string): string {
  return join('secrets', 'settings', `${userId}.json`);
}

async function read(file: string): Promise<Stored> {
  let stored: Stored;
  try {
    stored = JSON.parse(await readFile(file, 'utf8')) as Stored;
  } catch {
    return { connections: [] };
  }

  if (stored.connections) {
    return {
      connections: stored.connections,
      ...(stored.activeId ? { activeId: stored.activeId } : {}),
      ...(stored.runId ? { runId: stored.runId } : {}),
    };
  }

  // A single OpenRouter key was all there used to be. Migrating it is not enough — it has to be
  // WRITTEN, or every read invents a new id and nothing the interface points at exists a moment later.
  if (!stored.openrouterKey) return { connections: [] };

  const migrated: Stored = {
    connections: [
      {
        id: randomUUID().slice(0, 8),
        label: 'OpenRouter',
        provider: 'openrouter',
        baseUrl: PROVIDERS.openrouter.baseUrl,
        key: stored.openrouterKey,
        model: stored.model ?? DEFAULT_MODEL,
        addedAt: new Date().toISOString(),
      },
    ],
  };
  migrated.activeId = migrated.connections[0]!.id;
  await write(file, migrated);
  return migrated;
}

async function write(file: string, stored: Stored): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(stored, null, 2)}\n`, 'utf8');
  await chmod(file, 0o600);
}

function activeOf(stored: Stored): Connection | undefined {
  return stored.connections.find((entry) => entry.id === stored.activeId) ?? stored.connections[0];
}

function view(stored: Stored, connection: Connection): ConnectionView {
  return {
    id: connection.id,
    label: connection.label,
    provider: connection.provider,
    baseUrl: connection.baseUrl,
    model: connection.model,
    keyHint: `…${connection.key.slice(-4)}`,
    active: activeOf(stored)?.id === connection.id,
    runs: (stored.runId ?? activeOf(stored)?.id) === connection.id,
    lastCheck: connection.lastCheck,
  };
}

export async function listConnections(file: string): Promise<ConnectionView[]> {
  const stored = await read(file);
  return stored.connections.map((connection) => view(stored, connection));
}

/** What a build should use: the chosen connection, or the only one, or nothing at all. */
export async function activeConnection(file: string): Promise<Connection | undefined> {
  return activeOf(await read(file));
}

/**
 * The connection for work that repeats: the second opinion on borderline rows, and anything else a
 * run does. Falls back to the one that builds, so an account that never chose has nothing broken.
 */
export async function runConnection(file: string): Promise<Connection | undefined> {
  const stored = await read(file);
  return stored.connections.find((entry) => entry.id === stored.runId) ?? activeOf(stored);
}

export async function setRunConnection(file: string, id: string | undefined): Promise<void> {
  const stored = await read(file);
  if (id && !stored.connections.some((connection) => connection.id === id)) throw new InputError('no such connection');
  if (id) stored.runId = id;
  else delete stored.runId;
  await write(file, stored);
}

/** The stored connection, key and all — for the server's own use, never for the browser. */
export async function activeConnectionById(file: string, id: string): Promise<Connection | undefined> {
  return (await read(file)).connections.find((connection) => connection.id === id);
}

export async function addConnection(
  file: string,
  input: { provider: ProviderId; key: string; model: string; label?: string; baseUrl?: string },
): Promise<ConnectionView> {
  const provider = PROVIDERS[input.provider];
  if (!provider) throw new InputError(`unknown provider ${input.provider}`);

  const baseUrl = (input.baseUrl || provider.baseUrl).replace(/\/+$/, '');
  if (!baseUrl) throw new InputError('this provider needs a base URL');
  if (!input.key.trim()) throw new InputError('a connection needs a key');
  if (!input.model.trim()) throw new InputError('a connection needs a model');

  const stored = await read(file);
  const connection: Connection = {
    id: randomUUID().slice(0, 8),
    label: input.label?.trim() || `${provider.label} · ${input.model}`,
    provider: input.provider,
    baseUrl,
    key: input.key.trim(),
    model: input.model.trim(),
    addedAt: new Date().toISOString(),
  };

  stored.connections.push(connection);
  stored.activeId ??= connection.id;
  await write(file, stored);
  return view(stored, connection);
}

export async function removeConnection(file: string, id: string): Promise<void> {
  const stored = await read(file);
  stored.connections = stored.connections.filter((connection) => connection.id !== id);
  if (stored.activeId === id) stored.activeId = stored.connections[0]?.id;
  if (stored.runId === id) delete stored.runId;
  await write(file, stored);
}

export async function setActiveConnection(file: string, id: string): Promise<void> {
  const stored = await read(file);
  if (!stored.connections.some((connection) => connection.id === id)) throw new InputError('no such connection');
  stored.activeId = id;
  await write(file, stored);
}

export async function setModel(file: string, id: string, model: string): Promise<void> {
  const stored = await read(file);
  const connection = stored.connections.find((entry) => entry.id === id);
  if (!connection) throw new InputError('no such connection');
  connection.model = model;
  await write(file, stored);
}

// --- checking ----------------------------------------------------------------------------------

/**
 * Two questions in one: does the key work, and does the chosen model actually answer? A key with money
 * on it can still meet a model that was renamed or withdrawn, and finding that out twenty steps into a
 * build helps nobody.
 */
export async function checkConnection(file: string, id: string): Promise<{ ok: boolean; note: string }> {
  const stored = await read(file);
  const connection = stored.connections.find((entry) => entry.id === id);
  if (!connection) throw new InputError('no such connection');

  const started = Date.now();
  let result: { ok: boolean; note: string };

  try {
    const response = await fetch(`${connection.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${connection.key}`, 'x-title': 'ratatosk' },
      body: JSON.stringify({ model: connection.model, messages: [{ role: 'user', content: 'ping' }], max_tokens: 1 }),
    });
    const latency = Date.now() - started;
    result = response.ok
      ? { ok: true, note: `${connection.model} answered in ${latency} ms` }
      : { ok: false, note: `${response.status}: ${(await response.text()).slice(0, 120)}` };
  } catch (error) {
    result = { ok: false, note: error instanceof Error ? (error.message.split('\n')[0] ?? '') : String(error) };
  }

  // OpenRouter also knows what is left on the key, which is the other thing people want to see.
  if (result.ok && connection.provider === 'openrouter') {
    const credit = await openrouterCredit(connection.key).catch(() => undefined);
    if (credit) result.note += ` · ${credit}`;
  }

  connection.lastCheck = { at: new Date().toISOString(), ...result };
  await write(file, stored);
  return result;
}

async function openrouterCredit(key: string): Promise<string | undefined> {
  const response = await fetch('https://openrouter.ai/api/v1/key', { headers: { authorization: `Bearer ${key}` } });
  if (!response.ok) return undefined;
  const body = (await response.json()) as { data?: { limit?: number | null; usage?: number } };
  const usage = body.data?.usage ?? 0;
  const limit = body.data?.limit;
  return limit === null || limit === undefined
    ? `spent $${usage.toFixed(2)}, no limit set`
    : `$${Math.max(0, limit - usage).toFixed(2)} left of $${limit.toFixed(2)}`;
}

// --- catalogues ---------------------------------------------------------------------------------

export interface ModelChoice {
  id: string;
  name: string;
  price: number;
  free: boolean;
}

export interface ModelList {
  models: ModelChoice[];
  fetchedAt: string;
  total: number;
  note?: string;
}

const TTL_MS = Number(process.env['RATATOSK_MODELS_TTL'] ?? 3_600_000);
const cache = new Map<string, { at: number; list: ModelList }>();

/**
 * What this provider offers, asked of the provider itself — nothing here is compiled in. OpenRouter
 * publishes prices and says which models can call tools, so the list is narrowed to the ones that can
 * actually drive a build; others simply list what they have.
 */
export async function listModels(input: {
  provider: ProviderId;
  baseUrl?: string;
  key?: string;
  force?: boolean;
}): Promise<ModelList> {
  const baseUrl = (input.baseUrl || PROVIDERS[input.provider]?.baseUrl || '').replace(/\/+$/, '');
  if (!baseUrl) throw new InputError('give a base URL first');

  const cached = cache.get(baseUrl);
  if (!input.force && cached && Date.now() - cached.at < TTL_MS) return cached.list;

  const response = await fetch(`${baseUrl}/models`, {
    headers: input.key ? { authorization: `Bearer ${input.key}` } : {},
  });
  if (!response.ok) throw new Error(`that provider did not give a model list: ${response.status}`);

  const body = (await response.json()) as {
    data: Array<{ id: string; name?: string; pricing?: { prompt?: string }; supported_parameters?: string[] }>;
  };

  const withTools = body.data.filter((model) => model.supported_parameters?.includes('tools'));
  const source = withTools.length > 0 ? withTools : body.data;

  const models = source
    .filter((model) => !model.id.includes(':batch'))
    .map((model) => {
      const price = Number(model.pricing?.prompt ?? 0) * 1_000_000;
      return { id: model.id, name: model.name ?? model.id, price, free: price === 0 };
    })
    .sort((left, right) => left.price - right.price || left.id.localeCompare(right.id));

  const list: ModelList = {
    models,
    fetchedAt: new Date().toISOString(),
    total: models.length,
    note: withTools.length > 0 ? 'models that can call tools' : 'this provider does not say which models call tools',
  };
  cache.set(baseUrl, { at: Date.now(), list });
  return list;
}
