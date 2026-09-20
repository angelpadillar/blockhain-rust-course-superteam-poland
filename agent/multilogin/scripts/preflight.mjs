import { createInterface } from 'node:readline';
import { Multilogin } from '../src/multilogin.mjs';
import { errorCode } from '../src/core.mjs';
try {
  const input = createInterface({ input: process.stdin, terminal: false });
  const token = await new Promise(resolve => input.once('line', resolve)); input.close();
  const api = new Multilogin({ token: token.trim() });
  const folders = await api.folders();
  console.log(JSON.stringify({ status: 'authenticated', folders }, null, 2));
} catch (error) { console.error(JSON.stringify({ status: 'stopped', reason: errorCode(error) })); process.exitCode = 1; }
