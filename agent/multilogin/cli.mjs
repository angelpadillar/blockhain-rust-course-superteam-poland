import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { PilotError, requireThat, parseAccounts, errorCode } from './src/core.mjs';
import { readPrivate } from './src/storage.mjs';
import { Multilogin } from './src/multilogin.mjs';
import { createGuide } from './src/jev.mjs';
import { defaults, validateConfig } from './src/runner.mjs';
import { runConcurrentBatch } from './src/batch.mjs';

function argumentsFor(args) {
  const [command = 'help', ...rest] = args; const options = {};
  for (let i = 0; i < rest.length; i += 2) {
    requireThat(['--config', '--accounts', '--platform', '--data', '--output', '--concurrency'].includes(rest[i])
      && rest[i + 1] && !rest[i + 1].startsWith('--'), 'invalid_command_arguments');
    options[rest[i].slice(2)] = rest[i + 1];
  }
  return { command, options };
}
export async function main(args = process.argv.slice(2)) {
  const { command, options } = argumentsFor(args);
  let supplied = {};
  if (options.config) {
    try { supplied = JSON.parse(await readFile(options.config, 'utf8')); } catch { throw new PilotError('invalid_config_file'); }
  }
  const config = validateConfig(supplied);
  const token = process.env.MULTILOGIN_AUTOMATION_TOKEN || process.env.MULTILOGIN_TOKEN;
  if (command === 'help') {
    console.log('Commands: doctor, folders, token, plan, run. Options: --config PATH --accounts PRIVATE_PATH --platform instagram|youtube --data PATH --output PATH.');
    return;
  }
  if (command === 'doctor') {
    let launcherStatus = 'unreachable';
    try {
      const response = await fetch(`${config.launcherUrl}/api/v1/version`, { redirect: 'error', signal: AbortSignal.timeout(5000) });
      launcherStatus = response.ok ? 'reachable' : `http_${response.status}`;
    } catch {}
    console.log(JSON.stringify({ launcher: launcherStatus, multiloginToken: token ? 'present' : 'missing',
      jevKey: process.env.TYPESAFE_API_KEY ? 'present' : 'missing', cloudStorage: config.cloudStorage,
      proxyMode: config.proxyMode, proxyCountry: config.proxyCountry || 'per-account or missing' }, null, 2)); return;
  }
  if (command === 'folders') {
    const data = await new Multilogin({ token, launcherUrl: config.launcherUrl }).folders();
    console.log(JSON.stringify(data, null, 2)); return;
  }
  if (command === 'token') {
    requireThat(options.output, 'token_output_path_required');
    const api = new Multilogin({ token, launcherUrl: config.launcherUrl });
    const data = await api.automationToken(); requireThat(typeof data?.token === 'string', 'automation_token_missing');
    const path = resolve(options.output); await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await writeFile(path, data.token + '\n', { mode: 0o600, flag: 'wx' });
    console.log(JSON.stringify({ status: 'saved', path, secretPrinted: false })); return;
  }
  requireThat(['plan', 'run'].includes(command), 'unknown_command');
  requireThat(options.accounts, 'accounts_path_required');
  const accounts = parseAccounts(await readPrivate(options.accounts), options.platform);
  requireThat(accounts.length <= config.maxAccounts, 'too_many_accounts');
  if (command === 'plan') {
    console.log(JSON.stringify({ mode: 'offline_plan', count: accounts.length,
      accounts: accounts.map(account => ({ id: account.id, platform: account.platform, totp: !!account.totp,
        recoveryEmail: !!account.recoveryEmail, proxyCountry: account.proxyCountry || config.proxyCountry || 'required' })),
      cloudStorage: config.cloudStorage, proxyMode: config.proxyMode, seedSites: config.seedSites,
      verifyRestart: config.verifyRestart, maxProxySwitches: config.maxProxySwitches }, null, 2)); return;
  }
  requireThat(process.env.TYPESAFE_API_KEY, 'missing_typesafe_key');
  const api = new Multilogin({ token, launcherUrl: config.launcherUrl });
  const result = await runConcurrentBatch({ accounts, config, api, concurrency: Number(options.concurrency || 1),
    guideFactory: () => createGuide({ apiKey: process.env.TYPESAFE_API_KEY }), directory: resolve(options.data || 'private/state') });
  console.log(JSON.stringify({ reportPath: result.reportPath, completed: result.report.completed,
    notStarted: result.report.notStarted,
    accounts: result.report.accounts.map(({ accountId, platform, profileId, status, reason, proxySwitches }) =>
      ({ accountId, platform, profileId, status, reason, proxySwitches })) }, null, 2));
  if (result.report.completed !== accounts.length) process.exitCode = 2;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { console.error(JSON.stringify({ status: 'stopped', reason: errorCode(error) })); process.exitCode = 1; });
}
