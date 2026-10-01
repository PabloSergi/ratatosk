import { randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { InputError } from './errors.js';
import { sharedBridge } from './socks-bridge.js';
export function proxiesFileFor(userId) {
    return join('secrets', 'proxies', `${userId}.json`);
}
export async function listProxies(file) {
    try {
        return JSON.parse(await readFile(file, 'utf8'));
    }
    catch {
        return [];
    }
}
async function write(file, proxies) {
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, `${JSON.stringify(proxies, null, 2)}\n`, 'utf8');
    await chmod(file, 0o600);
}
/** What the browser is allowed to know: enough to recognise a proxy, never enough to use it elsewhere. */
export function view(proxy) {
    const parsed = parse(proxy.url);
    return {
        id: proxy.id,
        label: proxy.label,
        scheme: parsed.scheme,
        host: parsed.host,
        user: parsed.username ? `${parsed.username.slice(0, 2)}…` : undefined,
        exitIp: proxy.exitIp,
        checkedAt: proxy.checkedAt,
    };
}
export function parse(url) {
    let parsed;
    try {
        parsed = new URL(url.includes('://') ? url : `http://${url}`);
    }
    catch {
        throw new InputError(`that is not a proxy address: ${url}`);
    }
    const scheme = parsed.protocol.replace(':', '');
    if (!['http', 'https', 'socks5', 'socks4'].includes(scheme)) {
        throw new InputError(`unsupported proxy scheme "${scheme}" — use http, https or socks5`);
    }
    if (!parsed.hostname || !parsed.port)
        throw new InputError('a proxy needs a host and a port, like host:8080');
    // socks4 has no notion of a password at all — better to say that now than to fail at the first page.
    if (scheme === 'socks4' && parsed.username)
        throw new InputError('socks4 cannot carry a username and password — ask for socks5');
    return {
        scheme,
        host: `${parsed.hostname}:${parsed.port}`,
        username: parsed.username ? decodeURIComponent(parsed.username) : undefined,
        password: parsed.password ? decodeURIComponent(parsed.password) : undefined,
    };
}
/** The shape a browser wants: server without credentials, credentials beside it. */
export function toBrowser(proxy) {
    const parsed = parse(proxy.url);
    return {
        server: `${parsed.scheme}://${parsed.host}`,
        ...(parsed.username ? { username: parsed.username } : {}),
        ...(parsed.password ? { password: parsed.password } : {}),
    };
}
/**
 * The same, but for a browser that will actually be started.
 *
 * Chromium refuses to launch at all when a SOCKS5 proxy comes with a username — the message is
 * "Browser does not support socks5 proxy authentication" — and that is most of what providers sell.
 * So such a proxy is not handed over directly: a local bridge takes the browser's plain HTTP CONNECT
 * and does the SOCKS5 handshake, password and all, on the far side. Everything else goes straight
 * through, as before.
 */
export async function toRunningBrowser(proxy) {
    return toRunningBrowserUrl(proxy.url);
}
/**
 * The same from the address alone.
 *
 * Which matters because the bridge is a local listener, and "local" is a different machine depending
 * on who starts the browser. When the browsers live in a container of their own, the bridge has to be
 * raised beside them — so what travels between the two is the proxy as configured, and each side turns
 * it into something its own Chromium can dial.
 */
export async function toRunningBrowserUrl(url) {
    const parsed = parse(url);
    const plain = () => ({
        server: `${parsed.scheme}://${parsed.host}`,
        ...(parsed.username ? { username: parsed.username } : {}),
        ...(parsed.password ? { password: parsed.password } : {}),
    });
    if (parsed.scheme !== 'socks5' || !parsed.username)
        return plain();
    const colon = parsed.host.lastIndexOf(':');
    const bridge = await sharedBridge(url, {
        host: parsed.host.slice(0, colon),
        port: Number(parsed.host.slice(colon + 1)),
        username: parsed.username,
        ...(parsed.password ? { password: parsed.password } : {}),
    });
    return { server: bridge.url };
}
export async function addProxy(file, input) {
    const parsed = parse(input.url);
    const proxies = await listProxies(file);
    const proxy = {
        id: randomUUID().slice(0, 8),
        label: input.label?.trim() || `${parsed.scheme}://${parsed.host}`,
        url: input.url.trim(),
        addedAt: new Date().toISOString(),
    };
    await write(file, [...proxies, proxy]);
    return proxy;
}
export async function removeProxy(file, id) {
    await write(file, (await listProxies(file)).filter((proxy) => proxy.id !== id));
}
export async function findProxy(file, id) {
    if (!id)
        return undefined;
    return (await listProxies(file)).find((proxy) => proxy.id === id);
}
export async function rememberCheck(file, id, exitIp) {
    const proxies = await listProxies(file);
    const proxy = proxies.find((entry) => entry.id === id);
    if (!proxy)
        return undefined;
    proxy.exitIp = exitIp;
    proxy.checkedAt = new Date().toISOString();
    await write(file, proxies);
    return proxy;
}
