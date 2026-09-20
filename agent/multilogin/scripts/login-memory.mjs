import { createInterface } from 'node:readline';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseAccounts, errorCode, requireThat } from '../src/core.mjs';
import { Multilogin } from '../src/multilogin.mjs';
import { createGuide } from '../src/jev.mjs';
import { runConcurrentBatch } from '../src/batch.mjs';

// One-shot supplied-account test: API keys, password and TOTP seed stay in memory.
try {
  const input = createInterface({ input: process.stdin, terminal: false });
  const secrets = JSON.parse(await new Promise(resolve => input.once('line', resolve))); input.close();
  const config = JSON.parse(await readFile('config.vps.json', 'utf8'));
  config.seedSites = []; // This test is exclusively sign-in and session verification.
  const accounts = parseAccounts(JSON.stringify(secrets.accounts));
  const expiration = JSON.parse(Buffer.from(secrets.multiloginToken.split('.')[1], 'base64url').toString()).exp;
  requireThat(Number.isFinite(expiration) && expiration * 1000 - Date.now() > 8 * 60 * 1000, 'fresh_multilogin_token_required');
  const api = new Multilogin({ token: secrets.multiloginToken, launcherUrl: config.launcherUrl });
  const result = await runConcurrentBatch({ accounts, config, api, concurrency: secrets.concurrency || 1,
    onAccount: async event => console.log(JSON.stringify({ event: 'account_finished', ...event })),
    directory: resolve(process.argv[2] || '/data/account-pilot'),
    guideFactory: () => createGuide({ apiKey: secrets.typesafeKey }) });
  console.log(JSON.stringify({ reportPath: result.reportPath, completed: result.report.completed,
    concurrency: result.report.concurrency, peakWorkers: result.report.peakWorkers,
    peakStartedProfiles: result.report.peakStartedProfiles, durationMs: result.report.durationMs, jev: result.report.jev,
    accounts: result.report.accounts.map(({ accountId, profileId, status, reason, events, jev }) =>
      ({ accountId, profileId, status, reason, events, jev })) }, null, 2));
  if (result.report.completed !== accounts.length) process.exitCode = 2;
} catch (error) { console.error(JSON.stringify({ status: 'stopped', reason: errorCode(error) })); process.exitCode = 1; }
