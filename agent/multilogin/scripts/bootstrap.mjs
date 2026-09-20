import { createInterface } from 'node:readline';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { Multilogin } from '../src/multilogin.mjs';
import { requireThat, errorCode } from '../src/core.mjs';

try {
  const path = resolve(process.argv[2] || 'private/credentials.env');
  const input = createInterface({ input: process.stdin, terminal: false });
  const token = await new Promise(resolve => input.once('line', resolve)); input.close();
  const api = new Multilogin({ token: token.trim() });
  const data = await api.automationToken();
  requireThat(typeof data?.token === 'string', 'automation_token_missing');
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, `MULTILOGIN_AUTOMATION_TOKEN=${data.token}\n`, { mode: 0o600, flag: 'wx' });
  const folders = await new Multilogin({ token: data.token }).folders();
  console.log(JSON.stringify({ status: 'automation_token_saved', path, folders }, null, 2));
} catch (error) { console.error(JSON.stringify({ status: 'stopped', reason: errorCode(error) })); process.exitCode = 1; }
