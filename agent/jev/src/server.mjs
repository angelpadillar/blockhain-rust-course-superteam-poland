import { createServer } from 'node:http';
import { createHash, timingSafeEqual, randomUUID } from 'node:crypto';
import { validateJob, assert, Stop } from './config.mjs';
import { loadJobs } from './storage.mjs';
import { runShopping } from './runner.mjs';

const hash = text => createHash('sha256').update(text).digest();
export async function createService({ config, dataDir, token, open, decide, ready = async () => true }) {
  assert(typeof token === 'string' && token.length >= 32, 'service_token_must_have_32_characters');
  const { jobs, save } = await loadJobs(dataDir);
  const queue = []; let active = null, draining = null, closing = false;
  const send = (res, status, data) => {
    res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    res.end(JSON.stringify(data));
  };
  const publicJob = job => { const { requestHash, keyHash, ...safe } = job; return safe; };
  async function drain() {
    while (queue.length && !closing) {
      const job = queue.shift();
      if (job.status !== 'queued') continue;
      const controller = new AbortController(); active = { job, controller };
      job.status = 'running'; job.startedAt = new Date().toISOString(); await save(job);
      const result = await runShopping({ id: job.id, job: job.request, config, open, decide, signal: controller.signal,
        progress: async update => { Object.assign(job, update); await save(job); } });
      Object.assign(job, result, { finishedAt: new Date().toISOString() });
      await save(job); active = null;
    }
  }
  function schedule() {
    if (draining) return;
    draining = drain().catch(() => { closing = true; active?.controller.abort(); })
      .finally(() => { draining = null; });
  }
  async function body(req) {
    let data = '';
    for await (const chunk of req) {
      data += chunk; assert(Buffer.byteLength(data) <= 8192, 'request_too_large');
    }
    try { return JSON.parse(data); } catch { throw new Stop('invalid_json'); }
  }
  const server = createServer(async (req, res) => {
    try {
      const path = new URL(req.url, 'http://localhost').pathname;
      if (req.method === 'GET' && path === '/healthz') return send(res, closing ? 503 : 200, { ok: !closing, mode: 'prepare_only' });
      if (!timingSafeEqual(hash(req.headers.authorization || ''), hash(`Bearer ${token}`))) return send(res, 401, { error: 'unauthorized' });
      if (req.headers.origin) return send(res, 403, { error: 'browser_origin_not_supported' });
      if (req.method === 'GET' && path === '/v1/status') return send(res, 200, { mode: 'prepare_only',
        merchant: config.merchant, destinationLabel: config.destinationLabel, maxPln: config.maxPln,
        onboarded: await ready(), activeJobId: active?.job.id || null, queued: queue.filter(j => j.status === 'queued').length });
      if (req.method === 'GET' && path === '/v1/jobs') return send(res, 200, [...jobs.values()].slice(-50).map(publicJob));
      if (req.method === 'POST' && path === '/v1/jobs') {
        assert(!closing, 'service_stopping');
        assert(await ready(), 'account_onboarding_required');
        const request = validateJob(await body(req), config);
        const key = req.headers['idempotency-key'];
        assert(typeof key === 'string' && /^[a-zA-Z0-9_-]{8,100}$/.test(key), 'idempotency_key_required');
        const keyHash = hash(key).toString('hex'), requestHash = hash(JSON.stringify(request)).toString('hex');
        const existing = [...jobs.values()].find(job => job.keyHash === keyHash);
        if (existing) {
          if (existing.requestHash !== requestHash) return send(res, 409, { error: 'idempotency_conflict' });
          return send(res, 200, publicJob(existing));
        }
        // Admission is reserved synchronously before disk I/O so concurrent requests cannot race.
        assert([...jobs.values()].filter(j => ['queued', 'running'].includes(j.status)).length < 5, 'queue_full');
        const job = { id: randomUUID(), keyHash, requestHash, request, status: 'queued',
          createdAt: new Date().toISOString(), paymentExecuted: false };
        jobs.set(job.id, job);
        try { await save(job); } catch (error) { jobs.delete(job.id); throw error; }
        queue.push(job); schedule(); return send(res, 202, publicJob(job));
      }
      const match = path.match(/^\/v1\/jobs\/([a-f0-9-]{36})(\/cancel)?$/);
      if (match) {
        const job = jobs.get(match[1]);
        if (!job) return send(res, 404, { error: 'job_not_found' });
        if (req.method === 'GET' && !match[2]) return send(res, 200, publicJob(job));
        if (req.method === 'POST' && match[2]) {
          if (job.status === 'queued') { job.status = 'cancelled'; job.finishedAt = new Date().toISOString(); await save(job); }
          if (active?.job.id === job.id) active.controller.abort();
          return send(res, 202, publicJob(job));
        }
      }
      return send(res, 404, { error: 'not_found' });
    } catch (error) {
      const code = error instanceof Stop ? error.code : 'internal_error';
      return send(res, code === 'queue_full' ? 429 : code === 'account_onboarding_required' ? 409 : error instanceof Stop ? 400 : 500, { error: code });
    }
  });
  server.requestTimeout = 10000; server.headersTimeout = 10000;
  return { server, jobs, async close() {
    closing = true; active?.controller.abort();
    await new Promise(resolve => server.close(resolve));
    if (draining) await draining;
    for (const job of queue) if (job.status === 'queued') {
      job.status = 'needs_attention'; job.reason = 'server_stopped'; await save(job);
    }
  } };
}
