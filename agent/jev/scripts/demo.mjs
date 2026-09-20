import { randomUUID } from 'node:crypto';
const origin = process.env.JEV_SERVICE_URL || 'http://127.0.0.1:8787';
const token = process.env.JEV_SERVICE_TOKEN;
if (!token) throw new Error('Set JEV_SERVICE_TOKEN');
const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
const request = { maxPln: 26, items: [
  { query: 'Hortex Tropical Duo Napój wieloowocowy czerwone winogrono gujawa 1 L', qty: 1 },
  { query: 'Hortex Tropical Duo Napój wieloowocowy kiwi limonka 1 L', qty: 1 },
  { query: 'Tymbark Napój owocowy jabłko mięta 1 l', qty: 1 },
] };
const response = await fetch(`${origin}/v1/jobs`, { method: 'POST', headers: { ...headers, 'Idempotency-Key': randomUUID() }, body: JSON.stringify(request) });
let job = await response.json();
if (!response.ok) throw new Error(job.error);
console.log(`Job ${job.id} submitted. No purchase will be made.`);
while (['queued', 'running'].includes(job.status)) {
  await new Promise(resolve => setTimeout(resolve, 1000));
  const status = await fetch(`${origin}/v1/jobs/${job.id}`, { headers });
  if (!status.ok) throw new Error(`Status request failed: ${status.status}`);
  job = await status.json();
}
console.log(JSON.stringify(job, null, 2));
