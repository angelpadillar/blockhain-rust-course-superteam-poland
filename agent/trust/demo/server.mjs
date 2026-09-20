import { createServer } from 'node:http';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { createDemo, transition, publicState, SCENARIOS } from './model.mjs';

const directory = dirname(fileURLToPath(import.meta.url));
const assets = new Map([['/', ['index.html', 'text/html; charset=utf-8']], ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/style.css', ['style.css', 'text/css; charset=utf-8']]]);

export async function startDemo({ port = 4317, receiptDirectory = join(directory, 'receipts'), clock = Date.now } = {}) {
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('invalid_port');
  const sessions = new Map();
  await mkdir(receiptDirectory, { recursive: true, mode: 0o700 });
  const persist = async state => {
    const path = join(receiptDirectory, `${state.sessionId}.json`), temporary = `${path}.tmp`;
    await writeFile(temporary, JSON.stringify(publicState(state, clock()), null, 2) + '\n', { mode: 0o600 });
    await rename(temporary, path);
  };
  const server = createServer(async (request, response) => {
    const send = (status, body, contentType = 'application/json; charset=utf-8') => {
      response.writeHead(status, { 'Content-Type': contentType, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'" });
      response.end(typeof body === 'string' ? body : JSON.stringify(body));
    };
    try {
      const path = new URL(request.url, 'http://127.0.0.1').pathname;
      if (request.method === 'GET' && assets.has(path)) {
        const [file, type] = assets.get(path); return send(200, await readFile(join(directory, file), 'utf8'), type);
      }
      const allowedHost = `127.0.0.1:${server.address().port}`;
      if (request.headers.host !== allowedHost) return send(403, { error: 'invalid_host' });
      if (request.headers.origin && request.headers.origin !== `http://${allowedHost}`) return send(403, { error: 'cross_origin_request' });
      const cookie = request.headers.cookie?.match(/(?:^|;\s*)demo_session=([a-f0-9]{48})(?:;|$)/)?.[1];
      let session = sessions.get(cookie);
      if (!session) {
        if (request.method !== 'GET' || path !== '/api/state') return send(403, { error: 'session_required' });
        const token = randomBytes(24).toString('hex');
        session = { state: createDemo({ now: clock() }), tail: Promise.resolve() };
        await persist(session.state); sessions.set(token, session);
        response.setHeader('Set-Cookie', `demo_session=${token}; HttpOnly; SameSite=Strict; Path=/`);
      }
      if (request.method === 'GET' && ['/api/state', '/api/evidence'].includes(path)) {
        await session.tail;
        if (path === '/api/evidence') response.setHeader('Content-Disposition', 'attachment; filename="local-trust-receipt.json"');
        return send(200, publicState(session.state, clock()));
      }
      if (request.method !== 'POST' || !['/api/reset', '/api/approve', '/api/execute'].includes(path)) return send(404, { error: 'not_found' });
      if (!request.headers['content-type']?.startsWith('application/json')) return send(415, { error: 'json_required' });
      let body = '', size = 0;
      for await (const chunk of request) { size += chunk.length; if (size > 4096) return send(413, { error: 'body_too_large' }); body += chunk; }
      let payload;
      try { payload = JSON.parse(body); } catch { return send(400, { error: 'invalid_json' }); }
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return send(400, { error: 'invalid_body' });
      const operation = session.tail.then(async () => {
        if (path === '/api/reset') {
          if (!SCENARIOS.includes(payload.scenario)) return { status: 400, data: { error: 'invalid_scenario' } };
          const next = createDemo({ scenario: payload.scenario, now: clock() }); await persist(next); session.state = next;
          return { status: 200, data: { ok: true, state: publicState(next, clock()) } };
        }
        const result = transition(session.state, path.slice('/api/'.length), payload, clock());
        await persist(result.state); session.state = result.state;
        return { status: result.ok ? 200 : 409, data: { ok: result.ok, code: result.code, state: publicState(result.state, clock()) } };
      });
      session.tail = operation.then(() => {}, () => {});
      const result = await operation; return send(result.status, result.data);
    } catch { return send(500, { error: 'receipt_write_or_server_failure' }); }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  return { server, url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())) };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const app = await startDemo({ port: process.env.TRUST_DEMO_PORT ? Number(process.env.TRUST_DEMO_PORT) : 4317 });
  process.stdout.write(`${app.url}\nLocal simulation only. No payment, signing or blockchain connection.\n`);
}
