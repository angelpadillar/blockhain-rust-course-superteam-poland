import { readFile } from 'node:fs/promises';
const operation = process.argv[2] || 'status';
if (!['status', 'snapshot', 'screenshot', 'network'].includes(operation)) throw new Error('Only status, snapshot, screenshot, or network is supported');
const token = (await readFile(process.env.CANDIDATE_TOKEN_FILE || '/run/secrets/service_token', 'utf8')).trim();
const result = await fetch(`http://127.0.0.1:8793/${operation}`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(operation === 'status' ? 5000 : 60000) });
if (!result.ok) throw new Error(`Observation failed: ${result.status}`);
process.stdout.write(Buffer.from(await result.arrayBuffer()));
