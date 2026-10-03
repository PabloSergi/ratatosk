import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { test } from 'vitest';

import { through } from '../src/through.ts';

/**
 * Что здесь проверяется: что запрос фидового робота действительно уходит ЧЕРЕЗ прокси.
 *
 * Reddit отдаёт свой JSON без логина и отвечает 403 на каждый User-Agent с адреса сервера. Поэтому
 * важно не «запрос ушёл», а «запрос ушёл туда, куда велели»: прокси обязан увидеть CONNECT с нужным
 * хостом и портом. Если транспорт тихо свалится на прямой `fetch`, прокси не увидит ничего — и тест
 * упадёт, а не притворится зелёным.
 */
function fakeProxy() {
  const seen = [];
  const server = createServer();
  server.on('connect', (request, socket) => {
    seen.push(request.url);
    socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
  });
  return { server, seen };
}

test('фидовый запрос идёт через прокси, с правильным адресом в CONNECT', async () => {
  const { server, seen } = fakeProxy();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();

  const get = await through(`http://127.0.0.1:${port}`);
  await assert.rejects(
    () => get('https://www.reddit.com/r/gameDevClassifieds/new.json?limit=100', { accept: 'application/json' }),
    /the proxy refused the tunnel: 403/,
  );

  assert.deepEqual(seen, ['www.reddit.com:443'], 'прокси увидел ровно тот хост, который просили');
  await new Promise((done) => server.close(done));
});
