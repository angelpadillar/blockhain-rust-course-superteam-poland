// Adapted from Jev's profile ownership and atomic durable-job pattern; no original files changed.
import { mkdir, writeFile, readFile, rename, readdir, rm, appendFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { assert, Stop } from './policy.mjs';
export async function saveJson(path, value) {
  const tmp = `${path}.${randomUUID()}.tmp`;
  await writeFile(tmp, JSON.stringify(value, null, 2), { mode: 0o600, flush: true }); await rename(tmp, path);
}
export async function acquireProfileLock(dataDir, owner = 'service') {
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  const path = join(dataDir, 'profile.lock'), version = randomUUID();
  try { await mkdir(path, { mode: 0o700 }); } catch (e) { if (e.code === 'EEXIST') throw new Stop('profile_in_use_or_stale_lock'); throw e; }
  await saveJson(join(path, 'owner.json'), { pid: process.pid, owner, version, at: new Date().toISOString() });
  let released = false;
  return { version, async release() {
    if (released) return;
    const current = JSON.parse(await readFile(join(path, 'owner.json'), 'utf8'));
    assert(current.version === version, 'profile_owner_changed');
    released = true; await rm(path, { recursive: true });
  } };
}
export async function loadJobs(dataDir) {
  const dir = join(dataDir, 'jobs'); await mkdir(dir, { recursive: true, mode: 0o700 }); const jobs = new Map();
  for (const file of await readdir(dir)) {
    if (!/^[a-f0-9-]{36}\.json$/.test(file)) continue;
    const job = JSON.parse(await readFile(join(dir, file), 'utf8'));
    if (['running', 'queued'].includes(job.status)) { job.status = 'needs_attention'; job.reason = 'server_restarted_no_replay'; job.finishedAt = new Date().toISOString(); await saveJson(join(dir, file), job); }
    jobs.set(job.id, job);
  }
  return { jobs, save: job => saveJson(join(dir, `${job.id}.json`), job) };
}
export async function journal(directory, event) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await appendFile(join(directory, 'journal.jsonl'), JSON.stringify({ at: new Date().toISOString(), ...event }) + '\n', { mode: 0o600, flush: true });
}
export function transition(job, next) {
  const allowed = { queued: ['running', 'cancelled', 'needs_attention'], running: ['complete', 'cancelled', 'needs_attention'] };
  assert(allowed[job.status]?.includes(next), 'invalid_job_transition'); job.status = next;
}
