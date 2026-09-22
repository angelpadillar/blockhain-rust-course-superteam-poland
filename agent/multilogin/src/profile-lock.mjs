import { mkdir, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { PilotError, requireThat } from './core.mjs';
import { writeJson } from './storage.mjs';

const namePattern = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;

// mkdir is atomic across processes, so two workers can never hold the same
// name. A stale lock is never cleared automatically: it requires inspecting the
// real profile first, exactly like the existing registry lock.
export async function acquireNamedLock(directory, name, details = {}) {
  requireThat(typeof name === 'string' && namePattern.test(name), 'invalid_lock_name');
  const root = resolve(directory, 'locks');
  await mkdir(root, { recursive: true, mode: 0o700 });
  const path = resolve(root, `${name}.lock`);
  try { await mkdir(path, { mode: 0o700 }); }
  catch { throw new PilotError('profile_locked_or_stale_lock'); }
  await writeJson(resolve(path, 'owner.json'), { name, pid: process.pid, startedAt: new Date().toISOString(), ...details });
  return () => rm(path, { recursive: true, force: true });
}

// One lock per Multilogin profile. Two workers must never control the same
// profile at the same time, in this process or in another one.
export function acquireProfileLock(directory, profileRef, details = {}) {
  return acquireNamedLock(directory, `profile-${profileRef}`, { profileRef, ...details });
}
