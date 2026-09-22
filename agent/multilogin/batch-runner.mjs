import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createInterface } from 'node:readline';
import { PilotError, errorCode, requireThat } from './src/core.mjs';
import { Multilogin } from './src/multilogin.mjs';
import { createChooser } from './src/model.mjs';
import { loadAccountIndex } from './src/accounts.mjs';
import { validateConfig } from './src/runner.mjs';
import { runJobBatch, validateJobs, summaryLines, inspectJobPlan, CancelToken } from './src/jobs.mjs';

// node batch-runner.mjs jobs.json --concurrency 2
// Jobs reference accounts by `accountRef`; credentials stay in the private
// store and never appear in arguments, logs or reports.
const valueFlags = ['--config', '--data', '--accounts', '--accounts-dir', '--concurrency',
  '--human-checkpoint-seconds', '--seed-sites', '--provider', '--model'];
const switchFlags = ['--dry-run', '--stdin-secrets', '--preserve-on-checkpoint', '--help'];

export function parseArguments(argv) {
  const options = { positional: [] };
  for (let index = 0; index < argv.length; index++) {
    const token = argv[index];
    if (valueFlags.includes(token)) {
      const value = argv[index + 1];
      requireThat(typeof value === 'string' && !value.startsWith('--'), 'invalid_command_arguments');
      options[token.slice(2)] = value; index++;
    } else if (switchFlags.includes(token)) options[token.slice(2)] = true;
    else if (token.startsWith('--')) throw new PilotError('unknown_command_argument');
    else options.positional.push(token);
  }
  return options;
}

const usage = 'Usage: node batch-runner.mjs jobs.json --concurrency 2 [--config config.vps.json] '
  + '[--data private/state] [--accounts private/accounts.json | --accounts-dir private/accounts] '
  + '[--human-checkpoint-seconds 600] [--seed-sites none|config] [--provider typesafe|fireworks] [--model ID] '
  + '[--preserve-on-checkpoint] [--stdin-secrets] [--dry-run]';

async function readStdinSecrets() {
  const input = createInterface({ input: process.stdin, terminal: false });
  const line = await new Promise(resolve => input.once('line', resolve));
  input.close();
  try { return JSON.parse(line); } catch { throw new PilotError('invalid_stdin_secrets'); }
}
async function readJsonFile(path, code) {
  let text;
  try { text = await readFile(path, 'utf8'); } catch { throw new PilotError(code); }
  try { return JSON.parse(text); } catch { throw new PilotError(code); }
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArguments(argv);
  if (options.help || !options.positional.length) { console.log(usage); return; }
  const directory = resolve(options.data || 'private/state');
  const jobs = validateJobs(await readJsonFile(resolve(options.positional[0]), 'invalid_jobs_file'));
  const accountIndex = await loadAccountIndex({
    path: options.accounts !== undefined ? resolve(options.accounts) : 'private/accounts.json',
    directory: options['accounts-dir'] ? resolve(options['accounts-dir']) : undefined });
  const supplied = await readJsonFile(resolve(options.config || 'config.vps.json'), 'invalid_config_file');
  const concurrency = options.concurrency === undefined ? 2 : Number(options.concurrency);
  // The Studio workflow is login and session verification, so merchant visits
  // stay off unless the config explicitly keeps them.
  const keepSeedSites = options['seed-sites'] === 'config';
  const config = validateConfig({ ...supplied,
    ...(keepSeedSites ? {} : { seedSites: [] }),
    ...(options['human-checkpoint-seconds']
      ? { humanCheckpointSeconds: Number(options['human-checkpoint-seconds']) } : {}) });
  if (options['dry-run']) {
    const plan = await inspectJobPlan({ jobs, accountIndex, directory });
    console.log(JSON.stringify({ mode: 'dry_run', data: directory, concurrency, config: {
      folderId: config.folderId, launcherUrl: config.launcherUrl, proxyMode: config.proxyMode,
      proxyCountry: config.proxyCountry, verifyRestart: config.verifyRestart, maxAccounts: config.maxAccounts,
      humanCheckpointSeconds: config.humanCheckpointSeconds, seedSites: config.seedSites,
      headless: config.headless, osType: config.osType }, ...plan }, null, 2));
    if (plan.status !== 'ok') process.exitCode = 2;
    return;
  }
  const secrets = options['stdin-secrets'] ? await readStdinSecrets() : {};
  const token = secrets.multiloginToken || process.env.MULTILOGIN_AUTOMATION_TOKEN || process.env.MULTILOGIN_TOKEN;
  requireThat(typeof token === 'string' && token.length > 10, 'missing_multilogin_token');
  const provider = options.provider || process.env.BROWSER_MODEL_PROVIDER || 'typesafe';
  const apiKey = provider === 'typesafe'
    ? (secrets.typesafeKey || process.env.TYPESAFE_API_KEY)
    : (secrets.fireworksKey || process.env.FIREWORKS_API_KEY);
  const api = new Multilogin({ token, launcherUrl: config.launcherUrl });
  const cancel = new CancelToken();
  const requestCancel = () => {
    cancel.abort('cancelled_by_signal');
    console.error(JSON.stringify({ event: 'cancel_requested', detail: 'finishing the current browser step first' }));
  };
  process.once('SIGINT', requestCancel); process.once('SIGTERM', requestCancel);
  const result = await runJobBatch({ jobs, accountIndex, config, directory, concurrency, api, cancel,
    guideFactory: () => createChooser({ provider, apiKey, model: options.model }),
    preserveOnCheckpoint: options['preserve-on-checkpoint'] === true,
    onJobState: state => console.log(JSON.stringify({ event: 'job_state', id: state.jobId, state: state.state,
      reason: state.reason || null, elapsedMs: state.elapsedMs })) });
  console.log(summaryLines(result.summary).join('\n'));
  console.log(JSON.stringify({ status: 'finished', concurrency, peakWorkers: result.summary.peakWorkers,
    modelProvider: provider, reportPath: result.reportPath, summaryPath: result.summaryPath,
    jobLogRoot: resolve(directory, 'jobs') }));
  if (result.summary.jobs.some(job => job.state !== 'success')) process.exitCode = 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { console.error(JSON.stringify({ status: 'stopped', reason: errorCode(error) })); process.exitCode = 1; });
}
