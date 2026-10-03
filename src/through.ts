import { request as askOverHttp } from 'node:http';
import { request as askOverHttps } from 'node:https';
import { Agent } from 'node:https';
import type { Socket } from 'node:net';
import { connect as wrapInTls } from 'node:tls';
import { gunzipSync } from 'node:zlib';
import { parse } from './proxies.js';
import { sharedBridge } from './socks-bridge.js';

/**
 * Reading a JSON feed from somewhere other than this server's own address.
 *
 * A browser robot has had a proxy for a long time: the page is opened by a Chromium that was started
 * pointing at one. A feed robot had none, because it asks with `fetch`, and `fetch` has no way to be
 * told to go through a proxy — so a source that refuses datacentre addresses was simply unreadable
 * that way. Reddit is exactly that source: its JSON needs no login and answers a laptop instantly,
 * and from here it answers 403 to every User-Agent there is.
 *
 * So the transport is named rather than assumed. `direct()` is what every feed robot has always used.
 * `through(proxyUrl)` tunnels instead: CONNECT to the proxy, TLS inside the tunnel, and from the
 * source's side the request arrives from the proxy's address.
 *
 * SOCKS5 with a password — which is what residential providers sell — is not dialled here at all.
 * The bridge that already exists for Chromium turns it into a plain local HTTP proxy, and this uses
 * the same one: one place that knows the SOCKS handshake, not two.
 */
export interface Answer {
  status: number;
  statusText: string;
  body: string;
}

export type Get = (url: string, headers: Record<string, string>) => Promise<Answer>;

export function direct(): Get {
  return async (url, headers) => {
    const answer = await fetch(url, { headers: { 'accept-encoding': 'gzip', ...headers } });
    return { status: answer.status, statusText: answer.statusText, body: await answer.text() };
  };
}

export async function through(proxyUrl: string): Promise<Get> {
  const agent = new Agent({ keepAlive: true });
  const parsed = parse(proxyUrl);
  const colon = parsed.host.lastIndexOf(':');

  // Whatever was configured, what gets dialled is a plain HTTP proxy on an address this process can
  // reach: the provider's own when it speaks HTTP, the local bridge when it speaks SOCKS5.
  const door =
    parsed.scheme === 'socks5' || parsed.scheme === 'socks4'
      ? parse(
          (
            await sharedBridge(proxyUrl, {
              host: parsed.host.slice(0, colon),
              port: Number(parsed.host.slice(colon + 1)),
              ...(parsed.username ? { username: parsed.username } : {}),
              ...(parsed.password ? { password: parsed.password } : {}),
            })
          ).url,
        )
      : parsed;
  const doorColon = door.host.lastIndexOf(':');

  agent.createConnection = ((options: { host?: string; port?: number }, done: (error: Error | null, socket?: Socket) => void) => {
    const asking = askOverHttp({
      host: door.host.slice(0, doorColon),
      port: Number(door.host.slice(doorColon + 1)),
      method: 'CONNECT',
      path: `${options.host}:${options.port ?? 443}`,
      ...(door.username
        ? { headers: { 'proxy-authorization': `Basic ${Buffer.from(`${door.username}:${door.password ?? ''}`).toString('base64')}` } }
        : {}),
    });
    asking.once('connect', (answer, socket: Socket) => {
      if (answer.statusCode !== 200) {
        socket.destroy();
        done(new Error(`the proxy refused the tunnel: ${answer.statusCode} ${answer.statusMessage}`));
        return;
      }
      done(null, wrapInTls({ socket, servername: options.host }) as unknown as Socket);
    });
    asking.once('error', (error: Error) => done(error));
    asking.end();
    return undefined as unknown as Socket;
  }) as typeof agent.createConnection;

  return (url, headers) =>
    new Promise<Answer>((answered, failed) => {
      const asking = askOverHttps(url, { agent, headers: { 'accept-encoding': 'gzip', ...headers } }, (answer) => {
        const parts: Buffer[] = [];
        answer.on('data', (part: Buffer) => parts.push(part));
        answer.on('end', () => {
          const whole = Buffer.concat(parts);
          const body = answer.headers['content-encoding'] === 'gzip' ? gunzipSync(whole) : whole;
          answered({
            status: answer.statusCode ?? 0,
            statusText: answer.statusMessage ?? '',
            body: body.toString('utf8'),
          });
        });
        answer.on('error', failed);
      });
      asking.on('error', failed);
      asking.end();
    });
}

/**
 * Ask, and keep asking while the answer is "not now".
 *
 * A source answering a few hundred times a run will time out once or twice, and one timeout is not a
 * broken source — it is a timeout. Reddit makes the same point louder: its feed rate-limits hard, so
 * three robots started within a minute of each other turn the third one into a 429. Marking that
 * robot broken would wake somebody up over a source that is working.
 *
 * A refusal that is a verdict — 403, 404, a bad address — is not retried. Only being told to wait is.
 */
export function patiently(get: Get, tries = 5): Get {
  return async (url, headers) => {
    let waited = 400;
    let last: unknown;

    for (let attempt = 1; attempt <= tries; attempt++) {
      let answer: Answer | undefined;
      try {
        answer = await get(url, headers);
      } catch (error) {
        last = error;
      }

      if (answer) {
        if (answer.status >= 200 && answer.status < 300) return answer;
        last = new Error(`${answer.status} ${answer.statusText}`.trim());
        // Thrown out of the loop rather than inside the try, which would be caught here and asked
        // again: five goes at a 403 is five goes at being told no, and twenty seconds of them.
        if (answer.status < 500 && answer.status !== 429) break;
      }

      if (attempt < tries) {
        await new Promise((done) => setTimeout(done, waited));
        waited *= 2;
      }
    }

    throw last instanceof Error ? last : new Error(String(last));
  };
}
