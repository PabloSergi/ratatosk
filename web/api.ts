import type { AgentResult } from '../src/agent.js';
import type { DraftResult } from '../src/draft.js';
import type { RepairResult } from '../src/repair.js';
import type { RunResult } from '../src/run.js';
import type { Run, Standing } from '../src/history.js';
import type { KeyView } from '../src/keys.js';
import type { RuleRepair } from '../src/rule-repair.js';
import type { SiftAttempt } from '../src/sift-agent.js';
import type { Sift } from '../src/sift.js';
import type { TelegramRobot, TelegramState } from '../src/telegram.js';

export type TelegramAccount = TelegramState & { id: string };

/**
 * The browser half of the platform, typed against the engine itself: `RunResult` here is the very
 * type `runScenario` returns. Rename a field in the engine and this stops compiling, which is the
 * whole reason the front-end is TypeScript rather than a string of JavaScript in a server file.
 */
export interface Account {
  id: string;
  email: string;
}

import type { ProxyView } from '../src/proxies.js';
import type { RobotSummary } from '../src/robots.js';

export type { RobotSummary, ProxyView };

/** What an account may see about its own alerts: everything except the token. */
export interface AlertState {
  on: boolean;
  chatId?: string;
  after: number;
  tokenHint?: string;
}

import type { ConnectionView, ModelList, ProviderId } from '../src/settings.js';

export type { ConnectionView, ModelList, ProviderId };

export interface Provider {
  label: string;
  baseUrl: string;
  keysAt?: string;
  note?: string;
}

export type { TelegramState };
export type { Run, Standing };
export type { KeyView };
export type { SiftAttempt };
export type { Sift };

export class ApiError extends Error {
  constructor(message: string, readonly unauthorised: boolean) {
    super(message);
  }
}

let token = localStorage.getItem('ratatosk.token') ?? '';

export function currentToken(): string {
  return token;
}

export function rememberToken(value: string): void {
  token = value;
  localStorage.setItem('ratatosk.token', value);
}

export function forgetToken(): void {
  token = '';
  localStorage.removeItem('ratatosk.token');
}

async function post<T>(path: string, body: Record<string, unknown> = {}): Promise<T> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (token) headers['authorization'] = `Bearer ${token}`;

  const response = await fetch(path, { method: 'POST', headers, body: JSON.stringify(body) });
  const data = (await response.json()) as T & { error?: string };
  if (!response.ok) throw new ApiError(data.error ?? 'request failed', response.status === 401);
  return data;
}

export const api = {
  register: (email: string, password: string) => post<{ user: Account; token: string }>('/api/auth/register', { email, password }),
  login: (email: string, password: string) => post<{ user: Account; token: string }>('/api/auth/login', { email, password }),
  me: () => post<{ user: Account }>('/api/auth/me'),

  /**
   * The wire still says "robots" — that is the name on disk and in the HTTP API, and renaming a
   * storage format to match a word on a screen is how installations lose their data. The screen's
   * vocabulary is settled here, at the boundary, and nowhere else.
   */
  scrapers: async () => ({ scrapers: (await post<{ robots: RobotSummary[] }>('/api/robots')).robots }),
  run: (name: string, maxPages?: number) => post<RunResult>('/api/run', { name, maxPages }),
  repair: (name: string) => post<Partial<RepairResult> & { rule?: RuleRepair }>('/api/repair', { name }),
  agent: (url: string, want: string, name: string, proxy?: string) =>
    post<AgentResult>('/api/agent', { url, want, name, proxy }),
  draft: (url: string, name: string, proxy?: string) => post<DraftResult>('/api/draft', { url, name, proxy }),

  models: () => post<{ connections: ConnectionView[]; providers: Record<ProviderId, Provider> }>('/api/models'),
  catalogue: (provider: ProviderId, key?: string, baseUrl?: string, refresh = false) =>
    post<ModelList>('/api/models/catalogue', { provider, key, baseUrl, refresh }),
  /** The catalogue for a connection that already exists — the server knows its key, the browser does not. */
  catalogueFor: (id: string, refresh = false) => post<ModelList>('/api/models/catalogue', { id, refresh }),
  addConnection: (provider: ProviderId, key: string, model: string, label: string, baseUrl?: string) =>
    post<ConnectionView>('/api/models/add', { provider, key, model, label, baseUrl }),
  removeConnection: (id: string) => post<{ connections: ConnectionView[] }>('/api/models/remove', { id }),
  runWithConnection: (id: string) => post<{ connections: ConnectionView[] }>('/api/models/runs', { id }),
  useConnection: (id: string) => post<{ connections: ConnectionView[] }>('/api/models/use', { id }),
  setConnectionModel: (id: string, model: string) => post<{ connections: ConnectionView[] }>('/api/models/model', { id, model }),
  checkConnection: (id: string) =>
    post<{ ok: boolean; note: string; connections: ConnectionView[] }>('/api/models/check', { id }),

  proxies: () => post<{ proxies: ProxyView[] }>('/api/proxies'),
  addProxy: (url: string, label: string) => post<ProxyView>('/api/proxies/add', { url, label }),
  /** The form asks for parts; the address is put together here so nobody has to type a URL by hand. */
  addProxyParts: (parts: { scheme: string; host: string; port: string; user: string; pass: string; label: string }) => {
    const credentials = parts.user ? `${encodeURIComponent(parts.user)}:${encodeURIComponent(parts.pass)}@` : '';
    return post<ProxyView>('/api/proxies/add', {
      url: `${parts.scheme}://${credentials}${parts.host}:${parts.port}`,
      label: parts.label,
    });
  },
  removeProxy: (id: string) => post<{ proxies: ProxyView[] }>('/api/proxies/remove', { id }),
  checkProxy: (id: string) => post<ProxyView & { exitIp: string; latencyMs: number }>('/api/proxies/check', { id }),
  /** One page, no model, nothing remembered: is this scraper still getting rows out of that site? */
  deletedScrapers: () =>
    post<{ deleted: Array<{ file: string; name: string; kind: string; at: string }> }>('/api/robot/deleted'),
  restoreScraper: (file: string) => post<{ restored: string }>('/api/robot/restore', { file }),
  renameScraper: (name: string, to: string) =>
    post<{ name: string; was: string; runs: number }>('/api/robot/rename', { name, to }),
  checkScraper: (name: string) =>
    post<{ name: string; ok: boolean; status: string; rows: number; challenge: boolean; note: string; at: string }>(
      '/api/robot/check',
      { name },
    ),

  /** Open the scraper's own browser on a screen this account can reach, and hand it to the person. */
  takeover: (url: string, proxy?: string) =>
    post<{ view: string; desktop: string; vncPort: number; url: string; expiresAt: string }>('/api/browser/takeover', {
      url,
      proxy,
    }),
  releaseBrowser: () => post<{ released: true }>('/api/browser/release', {}),
  history: (scraper?: string) => post<{ runs: Run[]; standing: Standing[] }>('/api/history', { robot: scraper }),

  keys: () => post<{ keys: KeyView[] }>('/api/keys', {}),
  createKey: (label: string) => post<{ key: string; keys: KeyView[] }>('/api/keys/create', { label }),
  revokeKey: (id: string) => post<{ keys: KeyView[] }>('/api/keys/revoke', { id }),
  rule: (name: string) => post<{ name: string; sift: Sift | null; remember: boolean }>('/api/robot/rule', { name }),
  saveRule: (name: string, sift: Sift, remember: boolean) =>
    post<{ saved: string; sift: Sift | null; remember: boolean }>('/api/robot/rule/save', { name, sift, remember }),
  testRule: (name: string, sift?: Sift) =>
    post<{
      sampled: number;
      kept: number;
      dropped: number;
      unclaimed: number;
      collisions: number;
      good: boolean;
      note: string;
      examples: { kept: string[]; dropped: string[]; collisions: string[] };
    }>('/api/robot/rule/test', { name, sift }),
  rebuildRule: (name: string, want?: string) =>
    post<{ sampled: number; proposed: Sift | null; was: Sift | null; usage: { calls: number }; reason?: string }>(
      '/api/robot/rule/rebuild',
      { name, want },
    ),

  deleteRobot: (name: string) =>
    post<{ deleted: string; forgotten: number; host?: string; kept?: string }>('/api/robot/delete', { name }),
  forgetSite: (url: string, proxy?: string) =>
    post<{ host: string; forgotten: number }>('/api/browser/forget-site', { url, proxy }),
  setRobotProxy: (name: string, proxy?: string) => post<{ name: string; proxy: string | null }>('/api/robot/proxy', { name, proxy }),

  alerts: () => post<AlertState>('/api/alerts'),
  saveAlerts: (botToken: string, chatId: string, after: number) =>
    post<AlertState>('/api/alerts/save', { botToken, chatId, after }),
  testAlerts: () => post<{ sent: boolean }>('/api/alerts/test'),
  alertsOff: () => post<AlertState>('/api/alerts/off'),

  telegramAccounts: () => post<{ accounts: TelegramAccount[] }>('/api/telegram'),
  telegramCheck: (id: string) => post<TelegramState>('/api/telegram/check', { id }),
  telegramSendCode: (apiId: string, apiHash: string, phone: string) =>
    post<{ sent: true }>('/api/telegram/send-code', { apiId, apiHash, phone }),
  telegramSignIn: (phone: string, code: string, password: string) =>
    post<{ account: string; id: string; accounts: TelegramAccount[] }>('/api/telegram/sign-in', { phone, code, password }),
  telegramForget: (id: string) => post<{ accounts: TelegramAccount[] }>('/api/telegram/forget', { id }),
  telegramRobot: (input: { channels: string; name: string; limit: number; contains: string; want: string; account?: string }) =>
    post<{
      saved: string[];
      /** One per channel: several groups behind one scraper hide each other's silence. */
      robots: TelegramRobot[];
      sift?: { built: boolean; attempts: SiftAttempt[]; usage: { calls: number }; reason?: string };
    }>('/api/telegram/robot', input),
};
