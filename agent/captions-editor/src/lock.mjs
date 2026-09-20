import { mkdir, open, unlink } from 'node:fs/promises';
import path from 'node:path';
export async function acquireOwner(root) {
  await mkdir(root, { recursive: true, mode: 0o700 });
  const file = path.join(root, '.candidate-owner');
  let handle;
  try { handle = await open(file, 'wx', 0o600); }
  catch (error) { if (error.code === 'EEXIST') throw new Error('Candidate profile has an owner or an unreviewed stale lock'); throw error; }
  await handle.writeFile(JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
  await handle.close();
  let released = false;
  return async () => { if (!released) { released = true; await unlink(file); } };
}
