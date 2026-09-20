import http from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { pngBytes, structured } from './mcp.mjs';
import { INTERNAL_PORT, SESSION_ID } from './config.mjs';
import { GuardError } from './automation.mjs';
export function authorized(value, token) {
  const expected = Buffer.from(`Bearer ${token}`); const actual = Buffer.from(value || '');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
export function createObserver({ client, token, getStatus, bridge = null }) {
  if (typeof token !== 'string' || token.length < 32) throw new Error('Private observation token must be at least 32 characters');
  return http.createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store'); res.setHeader('X-Content-Type-Options', 'nosniff');
    const json = (status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
    if (!authorized(req.headers.authorization, token)) return json(401, { error: 'Unauthorized' });
    const read = req.method === 'GET' && ['/status', '/snapshot', '/screenshot', ...(bridge ? ['/jobs', '/network'] : [])].includes(req.url);
    const action = bridge && req.method === 'POST' && ['/actions', '/select', '/select-ready', '/cancel', '/reconcile', '/recover-toggle', '/reconcile-navigation'].includes(req.url);
    if (!read && !action) return json(404, { error: 'Unknown bounded operation' });
    try {
      if (action) {
        if (!/^application\/json(?:;|$)/i.test(req.headers['content-type'] || '')) throw new GuardError('json_required');
        const parts = []; let size = 0;
        for await (const chunk of req) { size += chunk.length; if (size > 8192) throw new GuardError('request_too_large'); parts.push(chunk); }
        let input; try { input = JSON.parse(Buffer.concat(parts).toString('utf8')); } catch { throw new GuardError('invalid_json'); }
        if (req.url === '/actions') return json(200, await bridge.act(input));
        if (req.url === '/select') return json(200, await bridge.select(input));
        if (req.url === '/select-ready') return json(200, await bridge.selectReady(input));
        if (req.url === '/recover-toggle') return json(200, await bridge.recoverToggle(input));
        if (req.url === '/reconcile-navigation') return json(200, await bridge.reconcileNavigation(input));
        if (req.url === '/reconcile') return json(200, await bridge.reconcile(input));
        if (!input || Object.keys(input).some(key => key !== 'jobId')) throw new GuardError('unexpected_field');
        return json(200, await bridge.cancel(input.jobId));
      }
      if (req.url === '/status') {
        const status = getStatus();
        const healthy = status.runtimeAlive === true && !['failed', 'needs_attention'].includes(status.status);
        return json(healthy ? 200 : 503, { ...status, healthy });
      }
      if (req.url === '/network') return json(200, await bridge.network());
      if (req.url === '/jobs') return json(200, { jobs: await bridge.jobs() });
      if (req.url === '/snapshot') return json(200, bridge ? await bridge.observe() : structured(await client.call('browser_snapshot', { session_id: SESSION_ID, interactive_only: true, include_values: false, max_elements: 200 })));
      const png = pngBytes(await client.call('browser_screenshot', { session_id: SESSION_ID, full_page: false }));
      res.writeHead(200, { 'Content-Type': 'image/png' }); res.end(png);
    } catch (error) { json(error instanceof GuardError ? 409 : 503, { error: error instanceof GuardError ? error.code : 'Operation unavailable; inspect private job status' }); }
  });
}
export async function listenObserver(server) {
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(INTERNAL_PORT, '127.0.0.1', resolve); });
}
