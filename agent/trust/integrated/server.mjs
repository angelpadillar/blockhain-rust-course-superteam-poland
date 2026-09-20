import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GiftingRun, SCENARIOS } from './workflow.mjs';
import { escapeHtml } from './fixture.mjs';

const here = dirname(fileURLToPath(import.meta.url));
export async function startIntegrated({ port = 4318, directory = join(here, 'runs'), runOptions = {} } = {}) {
  const sessions = new Map(), runs = new Map();
  const assets = new Map([['/', ['index.html', 'text/html']], ['/app.js', ['app.js', 'text/javascript']], ['/style.css', ['style.css', 'text/css']]]);
  const server = createServer(async (req, res) => {
    const send = (status, data, type = 'application/json') => {
      res.writeHead(status, { 'Content-Type': `${type}; charset=utf-8`, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'" });
      res.end(Buffer.isBuffer(data) || typeof data === 'string' ? data : JSON.stringify(data));
    };
    const origin = `http://127.0.0.1:${server.address().port}`;
    if (req.headers.host !== new URL(origin).host || req.headers.origin && req.headers.origin !== origin) return send(403, { error: 'origin_rejected' });
    let session;
    try {
      const path = new URL(req.url, origin).pathname;
      if (req.method === 'GET' && assets.has(path)) { const [file, type] = assets.get(path); return send(200, await readFile(join(here, 'ui', file)), type); }
      const merchant = path.match(/^\/merchant\/([a-f0-9-]{36})\/(checkout|order|uncertain|orders\/(demo-[a-f0-9-]{36}))$/);
      if (merchant) {
        const run = runs.get(merchant[1]); if (!run) return send(404, { error: 'unknown_run' });
        if (req.method === 'GET' && merchant[2] === 'checkout') return send(200, run.fixture.render(), 'text/html');
        if (req.method === 'GET' && merchant[2] === 'uncertain') return send(200, '<h1>Simulated response loss</h1><p>The order may have been accepted. Reconcile before another action.</p>', 'text/html');
        if (req.method === 'GET' && merchant[3]) { const order = run.fixture.orders.get(merchant[3]); return order ? send(200, run.fixture.render(order), 'text/html') : send(404, { error: 'order_not_found' }); }
        if (req.method === 'POST' && merchant[2] === 'order') {
          const body = await readBody(req), attemptId = new URLSearchParams(body).get('attemptId');
          let submitted; try { submitted = run.fixture.submit(attemptId); } catch (error) { return send(403, { error: error.message }); }
          res.writeHead(303, { Location: submitted.responseLost ? `/merchant/${run.id}/uncertain` : `/merchant/${run.id}/orders/${submitted.order.orderId}` }); return res.end();
        }
        return send(405, { error: 'method_not_allowed' });
      }
      const view = path.match(/^\/evidence-view\/([a-f0-9-]{36})$/);
      if (view && req.method === 'GET') {
        const run = runs.get(view[1]); if (!run) return send(404, { error: 'unknown_run' });
        const s = run.public();
        return send(200, `<!doctype html><html><meta charset="utf-8"><title>Confirmed local Solana approval · Buena</title><style>body{font:18px system-ui;color:#183b2a;background:#f7f3ed;padding:50px}main{max-width:950px}code{overflow-wrap:anywhere}pre{white-space:pre-wrap;font:12px monospace;background:white;padding:20px}h1{font-size:38px}</style><main><p>LOCAL SOLANA · LITESVM · EPHEMERAL DEMO SIGNERS</p><h1>Gift authorization confirmed</h1><p>${escapeHtml(s.quote.item)} for ${escapeHtml(s.recipient.name)}</p><h2>PLN 129.00 · ${escapeHtml(s.authorization.status)}</h2><p>Exact terms: <code>${escapeHtml(s.quote.termsHash)}</code></p><p>Merchant: ${escapeHtml(s.quote.merchant)}</p><p>This is a rendered view of decoded program state and executed transaction evidence. No real wallet or payment.</p><pre>${escapeHtml(JSON.stringify(s.chain, null, 2))}</pre></main></html>`, 'text/html');
      }
      const cookie = req.headers.cookie?.match(/(?:^|;\s*)gifting_session=([a-f0-9]{48})(?:;|$)/)?.[1];
      session = sessions.get(cookie);
      if (!session) {
        if (req.method !== 'GET' || path !== '/api/state') return send(403, { error: 'session_required' });
        if (sessions.size >= 10) return send(429, { error: 'demo_session_limit' });
        const token = randomBytes(24).toString('hex'); session = { run: null, ownedRuns: new Set(), tail: Promise.resolve() }; sessions.set(token, session);
        res.setHeader('Set-Cookie', `gifting_session=${token}; HttpOnly; SameSite=Strict; Path=/`);
      }
      if (req.method === 'GET' && ['/api/state', '/api/evidence'].includes(path)) {
        await session.tail;
        if (path === '/api/evidence') res.setHeader('Content-Disposition', 'attachment; filename="buena-integrated-local-evidence.json"');
        return send(200, session.run?.public() || { runId: null });
      }
      const artifact = path.match(/^\/artifacts\/([a-f0-9-]{36})\/((quote|approval|confirmation)-[a-f0-9]{12}\.(png|json))$/);
      if (artifact && req.method === 'GET') {
        if (!session.ownedRuns.has(artifact[1])) return send(403, { error: 'artifact_not_owned' });
        return send(200, await readFile(join(directory, artifact[1], artifact[2])), artifact[4] === 'png' ? 'image/png' : 'application/json');
      }
      if (req.method !== 'POST' || !['/api/prepare', '/api/approve', '/api/execute', '/api/reconcile'].includes(path)) return send(404, { error: 'not_found' });
      if (!req.headers['content-type']?.startsWith('application/json')) return send(415, { error: 'json_required' });
      let payload; try { payload = JSON.parse(await readBody(req)); } catch { return send(400, { error: 'invalid_json' }); }
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return send(400, { error: 'invalid_body' });
      const operation = session.tail.then(async () => {
        if (path === '/api/prepare') {
          if (!SCENARIOS.includes(payload.scenario)) return { ok: false, code: 'invalid_scenario' };
          if (session.run?.state.phase === 'needs_reconciliation' || session.run?.state.execution.attemptId && !['completed'].includes(session.run.state.phase)) return { ok: false, code: 'reconcile_existing_run_first' };
          await session.run?.close();
          const run = new GiftingRun({ origin, directory, scenario: payload.scenario, ...runOptions });
          runs.set(run.id, run); session.ownedRuns.add(run.id); session.run = run; return run.prepare();
        }
        if (!session.run) return { ok: false, code: 'prepare_required' };
        if (path === '/api/approve') return session.run.approve(payload.termsHash);
        if (path === '/api/execute') return session.run.execute();
        return session.run.reconcile();
      });
      session.tail = operation.then(() => {}, () => {});
      const result = await operation;
      return send(result.ok ? 200 : 409, { ...result, state: session.run?.public() });
    } catch (error) {
      if (session?.run) {
        const run = session.run;
        run.state.phase = run.state.execution.attemptId ? 'needs_reconciliation' : 'blocked'; run.state.error = String(error.message).slice(0, 160);
        run.event('failure', 'Operation stopped; inspect the retained chain and browser evidence.');
        try { await run.persist(); } catch {}
      }
      return send(500, { ok: false, code: String(error.message).slice(0, 160), state: session?.run?.public() });
    }
  });
  server.requestTimeout = 30000; server.headersTimeout = 10000;
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  return { server, runs, url: `http://127.0.0.1:${server.address().port}`, directory,
    async close() { for (const run of runs.values()) await run.close(); await new Promise(resolve => server.close(resolve)); } };
}
async function readBody(req) { let body = ''; for await (const chunk of req) { body += chunk; if (Buffer.byteLength(body) > 8192) throw new Error('request_too_large'); } return body; }
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const app = await startIntegrated({ port: Number(process.env.GIFTING_PORT || 4318) });
  process.stdout.write(`${app.url}\nLocal Solana (LiteSVM), ephemeral demo signers, simulated merchant. No live purchases.\n`);
  const close = async () => { await app.close(); process.exit(0); }; process.on('SIGINT', close); process.on('SIGTERM', close);
}
