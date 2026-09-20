import { mkdir, readFile, open, rename, rm, stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { PilotError, requireThat } from './core.mjs';

export async function readPrivate(path) {
  const info = await stat(path);
  requireThat(info.isFile() && (info.mode & 0o077) === 0, 'private_file_requires_mode_600');
  return readFile(path, 'utf8');
}
export async function readJson(path, fallback) {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT' && fallback !== undefined) return fallback; throw new PilotError('invalid_state_file'); }
}
export async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${randomUUID()}.tmp`;
  const file = await open(temp, 'wx', 0o600);
  try { await file.writeFile(JSON.stringify(value, null, 2) + '\n'); await file.sync(); } finally { await file.close(); }
  await rename(temp, path);
  const directory = await open(dirname(path), 'r');
  try { await directory.sync(); } finally { await directory.close(); }
}
export async function lock(directory) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = resolve(directory, 'run.lock');
  try { await mkdir(path, { mode: 0o700 }); }
  catch { throw new PilotError('worker_locked_or_stale_lock'); }
  await writeJson(resolve(path, 'owner.json'), { pid: process.pid, startedAt: new Date().toISOString() });
  return () => rm(path, { recursive: true });
}
