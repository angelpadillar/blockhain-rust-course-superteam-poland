import { createInterface } from 'node:readline';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseAccounts, errorCode, requireThat } from '../src/core.mjs';
import { readPrivate } from '../src/storage.mjs';
import { Multilogin } from '../src/multilogin.mjs';
import { createGuide } from '../src/jev.mjs';
import { runConcurrentBatch } from '../src/batch.mjs';

// A secret manager or trusted caller supplies one JSON line on stdin.
// API credentials remain in worker memory, outside Docker environment metadata.
try {
  const [accountsPath, platform, directory = '/data/state', configPath = 'config.vps.json'] = process.argv.slice(2);
  requireThat(accountsPath, 'accounts_path_required');
  const input = createInterface({ input: process.stdin, terminal: false });
  const secrets = JSON.parse(await new Promise(resolve => input.once('line', resolve))); input.close();
  requireThat(typeof secrets.typesafeKey === 'string', 'missing_typesafe_key');
  const config = JSON.parse(await readFile(configPath, 'utf8'));
  const accounts = parseAccounts(await readPrivate(accountsPath), platform);
  const api = new Multilogin({ token: secrets.multiloginToken, launcherUrl: config.launcherUrl });
  const result = await runConcurrentBatch({ accounts, config, api, concurrency: secrets.concurrency || 1, directory: resolve(directory),
    guideFactory: () => createGuide({ apiKey: secrets.typesafeKey }) });
  console.log(JSON.stringify({ reportPath: result.reportPath, completed: result.report.completed,
    notStarted: result.report.notStarted,
    accounts: result.report.accounts.map(({ accountId, profileId, status, reason }) => ({ accountId, profileId, status, reason })) }, null, 2));
  if (result.report.completed !== accounts.length) process.exitCode = 2;
} catch (error) { console.error(JSON.stringify({ status: 'stopped', reason: errorCode(error) })); process.exitCode = 1; }
