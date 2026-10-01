import { createServer as createHttpServer } from 'node:http';
import { connect } from 'node:net';
import { once } from 'node:events';
export async function startBridge(target) {
    const server = createHttpServer();
    // https, and anything else a browser tunnels: CONNECT host:port, then raw bytes both ways.
    server.on('connect', (request, clientSocket, head) => {
        const [host, port] = splitAuthority(request.url ?? '');
        dial(target, host, port).then((upstream) => {
            clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
            if (head?.length)
                upstream.write(head);
            upstream.pipe(clientSocket);
            clientSocket.pipe(upstream);
            const drop = () => {
                upstream.destroy();
                clientSocket.destroy();
            };
            upstream.on('error', drop);
            clientSocket.on('error', drop);
        }, (error) => {
            clientSocket.end(`HTTP/1.1 502 Bad Gateway\r\n\r\n${error.message}`);
        });
    });
    // plain http through a proxy arrives as an absolute URL on an ordinary request.
    server.on('request', (request, response) => {
        let target_;
        try {
            target_ = new URL(request.url ?? '');
        }
        catch {
            response.writeHead(400).end('this bridge only forwards absolute URLs');
            return;
        }
        dial(target, target_.hostname, Number(target_.port || 80)).then((upstream) => {
            const headers = Object.entries(request.headers)
                .filter(([name]) => !name.startsWith('proxy-'))
                .map(([name, value]) => `${name}: ${Array.isArray(value) ? value.join(', ') : value}\r\n`)
                .join('');
            upstream.write(`${request.method} ${target_.pathname}${target_.search} HTTP/1.1\r\n${headers}\r\n`);
            // end: false, or a request without a body closes the connection the moment it is forwarded —
            // and the answer, which is the entire point, arrives to a socket that is already gone.
            request.pipe(upstream, { end: false });
            upstream.pipe(response.socket);
            upstream.on('error', () => response.socket?.destroy());
        }, (error) => {
            response.writeHead(502).end(error.message);
        });
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const port = server.address().port;
    return {
        port,
        url: `http://127.0.0.1:${port}`,
        close: async () => {
            server.close();
            server.closeAllConnections?.();
        },
    };
}
function splitAuthority(authority) {
    const index = authority.lastIndexOf(':');
    return index === -1 ? [authority, 443] : [authority.slice(0, index), Number(authority.slice(index + 1)) || 443];
}
/**
 * One SOCKS5 conversation, by the book: greet, authenticate if asked (RFC 1929), then ask for the host
 * by name so the proxy resolves it — resolving it here would leak which sites are being visited.
 */
async function dial(proxy, host, port) {
    const socket = connect({ host: proxy.host, port: proxy.port });
    socket.setNoDelay(true);
    await once(socket, 'connect');
    const methods = proxy.username ? [0x00, 0x02] : [0x00];
    socket.write(Buffer.from([0x05, methods.length, ...methods]));
    const greeting = await read(socket, 2);
    if (greeting[0] !== 0x05)
        throw new Error('that address does not answer like a SOCKS5 proxy');
    if (greeting[1] === 0x02) {
        if (!proxy.username)
            throw new Error('the proxy wants a username and password, and none were given');
        const user = Buffer.from(proxy.username);
        const password = Buffer.from(proxy.password ?? '');
        socket.write(Buffer.concat([Buffer.from([0x01, user.length]), user, Buffer.from([password.length]), password]));
        const answer = await read(socket, 2);
        if (answer[1] !== 0x00)
            throw new Error('the proxy refused that username and password');
    }
    else if (greeting[1] !== 0x00) {
        throw new Error(`the proxy asked for an authentication method we do not have (0x${greeting[1].toString(16)})`);
    }
    const name = Buffer.from(host);
    socket.write(Buffer.concat([
        Buffer.from([0x05, 0x01, 0x00, 0x03, name.length]),
        name,
        Buffer.from([(port >> 8) & 0xff, port & 0xff]),
    ]));
    const reply = await read(socket, 4);
    if (reply[1] !== 0x00)
        throw new Error(`the proxy would not connect to ${host}:${port} (${socksError(reply[1])})`);
    // The bound address that follows varies in length and is of no use to us; it just has to be consumed.
    const type = reply[3];
    if (type === 0x01)
        await read(socket, 4 + 2);
    else if (type === 0x04)
        await read(socket, 16 + 2);
    else if (type === 0x03) {
        const [length] = await read(socket, 1);
        await read(socket, length + 2);
    }
    return socket;
}
function socksError(code) {
    const reasons = {
        1: 'general failure',
        2: 'not allowed by its rules',
        3: 'network unreachable',
        4: 'host unreachable',
        5: 'connection refused',
        6: 'time to live expired',
        7: 'command not supported',
        8: 'address type not supported',
    };
    return reasons[code] ?? `code ${code}`;
}
/**
 * Read exactly this many bytes, waiting for them rather than hoping they already arrived — and take
 * every listener back off the socket afterwards. That last part is the whole reason this is written by
 * hand: a 'readable' listener left behind holds the stream in paused mode, and the pipes set up once the
 * handshake is over then carry nothing at all.
 */
function read(socket, length) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        let have = 0;
        const finish = (error) => {
            socket.off('readable', onReadable);
            socket.off('error', onError);
            socket.off('end', onEnd);
            if (error)
                reject(error);
            else
                resolve(Buffer.concat(chunks));
        };
        const onReadable = () => {
            while (have < length) {
                if (socket.readableLength === 0)
                    return;
                const chunk = socket.read(Math.min(length - have, socket.readableLength));
                if (!chunk)
                    return;
                chunks.push(chunk);
                have += chunk.length;
            }
            finish();
        };
        const onError = (error) => finish(error);
        const onEnd = () => finish(new Error('the proxy closed the connection'));
        socket.on('readable', onReadable);
        socket.on('error', onError);
        socket.on('end', onEnd);
        onReadable();
    });
}
// --- one bridge per proxy -------------------------------------------------------------------------
const bridges = new Map();
/**
 * Bridges are shared by proxy address: a browser opens dozens of connections and each is a fresh SOCKS5
 * conversation anyway, so one listener serves them all. They live as long as the process — a listener on
 * loopback costs nothing, and starting one per page load would waste a port every time.
 */
export function sharedBridge(key, target) {
    const existing = bridges.get(key);
    if (existing)
        return existing;
    const started = startBridge(target);
    bridges.set(key, started);
    started.catch(() => bridges.delete(key));
    return started;
}
export async function closeBridges() {
    const all = [...bridges.values()];
    bridges.clear();
    await Promise.all(all.map((bridge) => bridge.then((one) => one.close()).catch(() => undefined)));
}
