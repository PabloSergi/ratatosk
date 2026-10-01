export class ApiError extends Error {
    unauthorised;
    constructor(message, unauthorised) {
        super(message);
        this.unauthorised = unauthorised;
    }
}
let token = localStorage.getItem('ratatosk.token') ?? '';
export function currentToken() {
    return token;
}
export function rememberToken(value) {
    token = value;
    localStorage.setItem('ratatosk.token', value);
}
export function forgetToken() {
    token = '';
    localStorage.removeItem('ratatosk.token');
}
async function post(path, body = {}) {
    const headers = { 'content-type': 'application/json' };
    if (token)
        headers['authorization'] = `Bearer ${token}`;
    const response = await fetch(path, { method: 'POST', headers, body: JSON.stringify(body) });
    const data = (await response.json());
    if (!response.ok)
        throw new ApiError(data.error ?? 'request failed', response.status === 401);
    return data;
}
export const api = {
    register: (email, password) => post('/api/auth/register', { email, password }),
    login: (email, password) => post('/api/auth/login', { email, password }),
    me: () => post('/api/auth/me'),
    /**
     * The wire still says "robots" — that is the name on disk and in the HTTP API, and renaming a
     * storage format to match a word on a screen is how installations lose their data. The screen's
     * vocabulary is settled here, at the boundary, and nowhere else.
     */
    scrapers: async () => ({ scrapers: (await post('/api/robots')).robots }),
    run: (name, maxPages) => post('/api/run', { name, maxPages }),
    repair: (name) => post('/api/repair', { name }),
    agent: (url, want, name, proxy) => post('/api/agent', { url, want, name, proxy }),
    draft: (url, name, proxy) => post('/api/draft', { url, name, proxy }),
    models: () => post('/api/models'),
    catalogue: (provider, key, baseUrl, refresh = false) => post('/api/models/catalogue', { provider, key, baseUrl, refresh }),
    /** The catalogue for a connection that already exists — the server knows its key, the browser does not. */
    catalogueFor: (id, refresh = false) => post('/api/models/catalogue', { id, refresh }),
    addConnection: (provider, key, model, label, baseUrl) => post('/api/models/add', { provider, key, model, label, baseUrl }),
    removeConnection: (id) => post('/api/models/remove', { id }),
    runWithConnection: (id) => post('/api/models/runs', { id }),
    useConnection: (id) => post('/api/models/use', { id }),
    setConnectionModel: (id, model) => post('/api/models/model', { id, model }),
    checkConnection: (id) => post('/api/models/check', { id }),
    proxies: () => post('/api/proxies'),
    addProxy: (url, label) => post('/api/proxies/add', { url, label }),
    /** The form asks for parts; the address is put together here so nobody has to type a URL by hand. */
    addProxyParts: (parts) => {
        const credentials = parts.user ? `${encodeURIComponent(parts.user)}:${encodeURIComponent(parts.pass)}@` : '';
        return post('/api/proxies/add', {
            url: `${parts.scheme}://${credentials}${parts.host}:${parts.port}`,
            label: parts.label,
        });
    },
    removeProxy: (id) => post('/api/proxies/remove', { id }),
    checkProxy: (id) => post('/api/proxies/check', { id }),
    /** One page, no model, nothing remembered: is this scraper still getting rows out of that site? */
    deletedScrapers: () => post('/api/robot/deleted'),
    restoreScraper: (file) => post('/api/robot/restore', { file }),
    schedules: () => post('/api/schedules'),
    setSchedule: (name, everyMinutes) => post('/api/schedule/set', { name, everyMinutes }),
    runNow: (name) => post('/api/schedule/now', { name }),
    keptRuns: (name) => post('/api/results', { name }),
    keptResult: (name, at) => post('/api/results/get', { name, at }),
    renameScraper: (name, to) => post('/api/robot/rename', { name, to }),
    checkScraper: (name) => post('/api/robot/check', { name }),
    /** Open the scraper's own browser on a screen this account can reach, and hand it to the person. */
    takeover: (url, proxy, scraper) => post('/api/browser/takeover', {
        url,
        ...(scraper ? { scraper } : {}),
        proxy,
    }),
    releaseBrowser: () => post('/api/browser/release', {}),
    history: (scraper) => post('/api/history', { robot: scraper }),
    keys: () => post('/api/keys', {}),
    createKey: (label) => post('/api/keys/create', { label }),
    revokeKey: (id) => post('/api/keys/revoke', { id }),
    rule: (name) => post('/api/robot/rule', { name }),
    saveRule: (name, sift, remember, dedupe) => post('/api/robot/rule/save', {
        name,
        sift,
        remember,
        dedupe,
    }),
    testRule: (name, sift) => post('/api/robot/rule/test', { name, sift }),
    rebuildRule: (name, want) => post('/api/robot/rule/rebuild', { name, want }),
    deleteRobot: (name) => post('/api/robot/delete', { name }),
    forgetSite: (url, proxy) => post('/api/browser/forget-site', { url, proxy }),
    setRobotProxy: (name, proxy) => post('/api/robot/proxy', { name, proxy }),
    alerts: () => post('/api/alerts'),
    saveAlerts: (botToken, chatId, after) => post('/api/alerts/save', { botToken, chatId, after }),
    testAlerts: () => post('/api/alerts/test'),
    alertsOff: () => post('/api/alerts/off'),
    telegramAccounts: () => post('/api/telegram'),
    telegramCheck: (id) => post('/api/telegram/check', { id }),
    telegramSendCode: (apiId, apiHash, phone) => post('/api/telegram/send-code', { apiId, apiHash, phone }),
    telegramSignIn: (phone, code, password) => post('/api/telegram/sign-in', { phone, code, password }),
    telegramForget: (id) => post('/api/telegram/forget', { id }),
    telegramRobot: (input) => post('/api/telegram/robot', input),
};
