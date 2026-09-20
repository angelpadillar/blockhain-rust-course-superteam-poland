import { createInterface } from 'node:readline';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { lock, readJson, writeJson } from '../src/storage.mjs';

// Operator-only reconciliation for the dedicated infrastructure test profile.
// Records no response bodies, bearer credentials, or browser/session contents.
const input = createInterface({ input: process.stdin, terminal: false });
const { multiloginToken } = JSON.parse(await new Promise(resolve => input.once('line', resolve))); input.close();
const config = JSON.parse(await readFile('config.vps.json', 'utf8'));
const directory = resolve(process.argv[2] || '/data/smoke');
const release = await lock(directory);
try {
  const path = resolve(directory, 'profile.json');
  const state = await readJson(path);
  if (!state.profileId || state.name !== 'jev-infrastructure-smoke-20260919') throw new Error('dedicated_smoke_profile_required');
  const response = await fetch(`${config.launcherUrl}/api/v1/profile/stop/p/${state.profileId}`, {
    headers: { Authorization: `Bearer ${multiloginToken}` }, redirect: 'error', signal: AbortSignal.timeout(90000),
  });
  const result = await response.json();
  console.log(JSON.stringify({ operation: 'stop_dedicated_smoke', http: response.status, code: result.status?.error_code || null }));
  if (response.ok && !result.status?.error_code) { state.pending = null; await writeJson(path, state); }
  else process.exitCode = 2;
} finally { await release(); }
