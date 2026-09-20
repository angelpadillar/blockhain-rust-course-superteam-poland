import { mkdir, writeFile, readFile, rename, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Stop } from './config.mjs';

export async function saveJson(path, value) {
  const tmp = `${path}.${randomUUID()}.tmp`;
  await writeFile(tmp, JSON.stringify(value, null, 2), { mode: 0o600, flush: true });
  await rename(tmp, path);
}
export async function acquireProfileLock(dataDir) {
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  const lock = join(dataDir, 'profile.lock');
  try { await mkdir(lock, { mode: 0o700 }); }
  catch (error) { if (error.code === 'EEXIST') throw new Stop('profile_in_use_or_stale_lock'); throw error; }
  await saveJson(join(lock, 'owner.json'), { pid: process.pid, createdAt: new Date().toISOString() });
  return () => rm(lock, { recursive: true });
}
export async function loadJobs(dataDir) {
  const directory = join(dataDir, 'jobs');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const jobs = new Map();
  for (const file of await readdir(directory)) {
    if (!/^[a-f0-9-]{36}\.json$/.test(file)) continue;
    const job = JSON.parse(await readFile(join(directory, file), 'utf8'));
    if (['running', 'queued'].includes(job.status)) {
      job.status = 'needs_attention'; job.reason = 'server_restarted';
      job.finishedAt = new Date().toISOString();
      await saveJson(join(directory, file), job);
    }
    jobs.set(job.id, job);
  }
  return { jobs, save: job => saveJson(join(directory, `${job.id}.json`), job) };
}
