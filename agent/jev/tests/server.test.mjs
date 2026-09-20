import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createService } from '../src/server.mjs';
import { saveJson, loadJobs, acquireProfileLock } from '../src/storage.mjs';
import { config, job, temp } from './helpers.mjs';

test('API authenticates, deduplicates jobs, rejects changed retries and supports cancellation', async t => {
  const token = 'x'.repeat(32), dataDir = await temp(t);
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  const service = await createService({ config, token, dataDir, open: async () => {
    await pending; throw new Error('test-stop');
  }, decide: async () => {} });
  await new Promise(resolve => service.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { release(); await service.close(); });
  const url = `http://127.0.0.1:${service.server.address().port}`;
  assert.equal((await fetch(url + '/healthz')).status, 200);
  assert.equal((await fetch(url + '/v1/jobs')).status, 401);
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'Idempotency-Key': 'test-key-123' };
  const first = await fetch(url + '/v1/jobs', { method: 'POST', headers, body: JSON.stringify(job) });
  assert.equal(first.status, 202); const saved = await first.json();
  const again = await (await fetch(url + '/v1/jobs', { method: 'POST', headers, body: JSON.stringify(job) })).json();
  assert.equal(again.id, saved.id); assert.ok(!Object.hasOwn(saved, 'keyHash'));
  assert.equal((await fetch(url + '/v1/jobs', { method: 'POST', headers, body: JSON.stringify({ ...job, maxPln: 20 }) })).status, 409);
  const second = await (await fetch(url + '/v1/jobs', { method: 'POST', headers: { ...headers, 'Idempotency-Key': 'second-key-123' }, body: JSON.stringify(job) })).json();
  const cancel = await (await fetch(`${url}/v1/jobs/${second.id}/cancel`, { method: 'POST', headers })).json();
  assert.equal(cancel.status, 'cancelled');
  assert.equal((await fetch(url + '/v1/jobs', { headers: { ...headers, Origin: 'https://evil.test' } })).status, 403);
});
test('restart marks unfinished work for attention, never silently repeats shopping', async t => {
  const dataDir = await temp(t), { save } = await loadJobs(dataDir), id = randomUUID();
  await save({ id, status: 'running', request: job });
  const recovered = await loadJobs(dataDir);
  assert.equal(recovered.jobs.get(id).status, 'needs_attention');
  assert.equal(recovered.jobs.get(id).reason, 'server_restarted');
});
test('onboarding and service cannot use the same account simultaneously', async t => {
  const dataDir = await temp(t), release = await acquireProfileLock(dataDir);
  await assert.rejects(acquireProfileLock(dataDir), /profile_in_use/);
  await release(); const releaseAgain = await acquireProfileLock(dataDir); await releaseAgain();
});
