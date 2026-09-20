import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const agentDir = fileURLToPath(new URL('../../', import.meta.url));
const source = JSON.parse(await readFile(join(agentDir, 'config.local.json'), 'utf8'));
if (source.adapter !== 'glovo' || !source.items?.length || source.selection) throw new Error('This adapter needs a Glovo config with exact items.');
const origin = process.env.JEV_SERVICE_URL || 'http://127.0.0.1:8787';
const token = process.env.JEV_SERVICE_TOKEN;
if (!token) throw new Error('Set JEV_SERVICE_TOKEN. This command does not load the legacy payment environment.');
const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
const statusResponse = await fetch(`${origin}/v1/status`, { headers });
if (!statusResponse.ok) throw new Error(`Service unavailable: HTTP ${statusResponse.status}`);
const status = await statusResponse.json();
if (status.destinationLabel !== source.venue_label) throw new Error('Service destinationLabel must match the existing config venue_label. Verify its exact address during onboarding.');
const idempotencyKey = process.env.JEV_IDEMPOTENCY_KEY || randomUUID();
const response = await fetch(`${origin}/v1/jobs`, { method: 'POST',
  headers: { ...headers, 'Idempotency-Key': idempotencyKey },
  body: JSON.stringify({ items: source.items, maxPln: source.max_pln }) });
let job = await response.json();
if (!response.ok) throw new Error(job.error);
console.log(`Job ${job.id}; idempotency key ${idempotencyKey}. Purchase disabled.`);
const deadline = Date.now() + 15 * 60000;
while (['queued', 'running'].includes(job.status) && Date.now() < deadline) {
  await new Promise(resolve => setTimeout(resolve, 1000));
  const poll = await fetch(`${origin}/v1/jobs/${job.id}`, { headers });
  if (!poll.ok) throw new Error(`Status failed: ${poll.status}; retry GET /v1/jobs/${job.id}`);
  job = await poll.json();
}
const directory = join(agentDir, 'out', 'jev'); await mkdir(directory, { recursive: true, mode: 0o700 });
await writeFile(join(directory, `${job.id}.json`), JSON.stringify(job, null, 2), { mode: 0o600 });
console.log(JSON.stringify({ id: job.id, status: job.status, reason: job.reason,
  metrics: job.metrics, intent: job.intent }, null, 2));
if (job.status !== 'ready_for_review') process.exitCode = 1;
