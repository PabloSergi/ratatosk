import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { connect, createServer as createTcpServer } from 'node:net';
import { once } from 'node:events';
import { afterAll, test } from 'vitest';

import { closeBridges, startBridge } from '../src/socks-bridge.ts';

/**
 * A SOCKS5 server that wants a password, so the bridge is tested against the thing it exists for.
 * It records every login it was offered, and refuses the wrong one exactly as a real proxy would.
 */
function fakeSocks({ user, password }) {
  const attempts = [];
  const server = createTcpServer(async (client) => {
    client.on('error', () => undefined);
    try {
      const [greeting] = await once(client, 'data');
      const methods = [...greeting.subarray(2, 2 + greeting[1])];
      client.write(Buffer.from([0x05, methods.includes(0x02) ? 0x02 : 0xff]));

      const [login] = await once(client, 'data');
      const userLength = login[1];
      const offered = {
        user: login.subarray(2, 2 + userLength).toString(),
        password: login.subarray(3 + userLength, 3 + userLength + login[2 + userLength]).toString(),
      };
      attempts.push(offered);
      if (offered.user !== user || offered.password !== password) {
        client.write(Buffer.from([0x01, 0x01]));
        client.end();
        return;
      }
      client.write(Buffer.from([0x01, 0x00]));

      // A CONNECT request: reply with success, then be the wire between the caller and the real host.
      const [request] = await once(client, 'data');
      const host = request.subarray(5, 5 + request[4]).toString();
      const port = request.readUInt16BE(request.length - 2);

      // Nothing must be read here by hand any more, or the first bytes of the tunnel get eaten.
      client.pause();
      const upstream = connect({ host, port });
      upstream.on('error', () => client.destroy());
      await once(upstream, 'connect');
      client.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
      upstream.pipe(client);
      client.pipe(upstream);
      client.resume();
    } catch {
      client.destroy();
    }
  });

  server.listen(0, '127.0.0.1');
  return once(server, 'listening').then(() => ({ server, attempts, port: server.address().port }));
}

function fakeSite(body) {
  const server = createServer((_request, response) => response.end(body));
  server.listen(0, '127.0.0.1');
  return once(server, 'listening').then(() => ({ server, port: server.address().port }));
}

const open = [];
afterAll(async () => {
  await closeBridges();
  for (const server of open) server.close();
});

test('carries an http request through socks5 with a username and password', async () => {
  const socks = await fakeSocks({ user: 'bob', password: 'placeholder' });
  const site = await fakeSite('hello from the far side');
  const bridge = await startBridge({ host: '127.0.0.1', port: socks.port, username: 'bob', password: 'placeholder' });
  open.push(socks.server, site.server);

  // Absolute-form, which is how a client asks a proxy for a plain http page.
  const text = await through(bridge.port, `GET http://127.0.0.1:${site.port}/ HTTP/1.1\r\nhost: 127.0.0.1:${site.port}\r\nconnection: close\r\n\r\n`);
  assert.match(text, /hello from the far side/);
  assert.deepEqual(socks.attempts.at(-1), { user: 'bob', password: 'placeholder' });

  await bridge.close();
});

test('opens a tunnel for CONNECT, which is what a browser uses for https', async () => {
  const socks = await fakeSocks({ user: 'bob', password: 'placeholder' });
  const site = await fakeSite('through the tunnel');
  const bridge = await startBridge({ host: '127.0.0.1', port: socks.port, username: 'bob', password: 'placeholder' });
  open.push(socks.server, site.server);

  const socket = connect({ host: '127.0.0.1', port: bridge.port });
  await once(socket, 'connect');
  socket.write(`CONNECT 127.0.0.1:${site.port} HTTP/1.1\r\nhost: 127.0.0.1:${site.port}\r\n\r\n`);

  const established = await readSome(socket);
  assert.match(established, /^HTTP\/1\.1 200/);

  socket.write(`GET / HTTP/1.1\r\nhost: 127.0.0.1:${site.port}\r\nconnection: close\r\n\r\n`);
  assert.match(await readSome(socket), /through the tunnel/);
  socket.destroy();

  await bridge.close();
});

test('says plainly when the proxy refuses the password', async () => {
  const socks = await fakeSocks({ user: 'bob', password: 'placeholder' });
  const bridge = await startBridge({ host: '127.0.0.1', port: socks.port, username: 'bob', password: 'not-the-one' });
  open.push(socks.server);

  const answer = await through(bridge.port, 'GET http://example.com/ HTTP/1.1\r\nhost: example.com\r\nconnection: close\r\n\r\n');
  assert.match(answer, /502/);
  assert.match(answer, /refused that username and password/);

  await bridge.close();
});

/** Send one raw request to the bridge and read everything that comes back. */
async function through(port, request) {
  const socket = connect({ host: '127.0.0.1', port });
  await once(socket, 'connect');
  socket.write(request);
  const chunks = [];
  socket.on('data', (chunk) => chunks.push(chunk));
  await once(socket, 'close');
  return Buffer.concat(chunks).toString();
}

async function readSome(socket) {
  const [chunk] = await once(socket, 'data');
  return chunk.toString();
}
