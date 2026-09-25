import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { PilotError, errorCode, requireThat } from './src/core.mjs';
import { readPrivate } from './src/storage.mjs';
import { Multilogin } from './src/multilogin.mjs';
import { createChooser } from './src/model.mjs';
import { loadAccountIndex } from './src/accounts.mjs';
import { validateConfig } from './src/runner.mjs';
import { validateJobs, CancelToken, inspectJobPlan } from './src/jobs.mjs';
import { createTelegramNotifier } from './src/human-checkpoint.mjs';
import { createRecoveryMemory } from './src/recovery-memory.mjs';
import { runSingleJob, inspectOrchestratorResume, orchestrationExitCode } from './src/orchestrator.mjs';

// ONE command for ONE job:
//
//   npm run browser:job -- jobs/yt-live-05.json
//   node job-runner.mjs jobs/yt-live-05.json --data private/state
//
// The whole lifecycle belongs to this process: profile resolution/creation,
// proxy check, launcher start, CDP attachment, authenticated-state inspection,
// deterministic login or resume, bounded JEV recovery, human-checkpoint
// detection + Telegram announcement, Studio verification, restart persistence
// and a structured result.json. A genuine security checkpoint ends the run in
// WAITING_FOR_HUMAN and the same command resumes the same profile later.
const here = dirname(fileURLToPath(import.meta.url));
const valueFlags = ['--config', '--data', '--accounts', '--accounts-dir', '--concurrency',
  '--human-checkpoint-seconds', '--seed-sites', '--provider', '--model', '--token-file', '--key-file',
  '--mode', '--telegram-poll-ms', '--checkpoint-poll-ms'];
const switchFlags = ['--dry-run', '--stdin-secrets', '--no-notify', '--no-telegram', '--no-memory',
  '--preserve-on-checkpoint', '--json', '--help'];

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

const usage = 'Usage: node job-runner.mjs <job.json> [--mode live|fake] [--data private/state] '
  + '[--config config.vps.json] [--accounts private/accounts.json | --accounts-dir private/accounts] '
  + '[--token-file private/multilogin-token] [--key-file private/typesafe-key] [--provider typesafe|fireworks] '
  + '[--model ID] [--human-checkpoint-seconds 600] [--stdin-secrets] [--no-notify] [--no-telegram] '
  + '[--no-memory] [--preserve-on-checkpoint] [--dry-run] [--json]';

// Defaults resolve beside this package so `npm run browser:job` works from the
// repository root as well as from the worker image.
export const defaultPaths = (cwd = process.cwd()) => {
  const local = flag => existsSync(resolve(cwd, flag));
  return {
    config: local('config.vps.json') ? resolve(cwd, 'config.vps.json') : resolve(here, 'config.vps.json'),
    accounts: local('private/accounts.json') ? resolve(cwd, 'private/accounts.json') : resolve(here, 'private/accounts.json'),
    data: local('private/state') ? resolve(cwd, 'private/state') : resolve(here, 'private/state'),
    tokenFile: resolve(here, 'private/multilogin-token'),
    keyFile: resolve(here, 'private/typesafe-key'),
  };
};

async function readJsonFile(path, code) {
  let text;
  try { text = await readFile(path, 'utf8'); } catch { throw new PilotError(code); }
  try { return JSON.parse(text); } catch { throw new PilotError(code); }
}
function firstJob(input) {
  const jobs = validateJobs(input);
  requireThat(jobs.length === 1, 'single_job_required');
  return jobs[0];
}
async function readStdinSecrets() {
  const input = createInterface({ input: process.stdin, terminal: false });
  const line = await new Promise(resolve => input.once('line', resolve));
  input.close();
  try { return JSON.parse(line); } catch { throw new PilotError('invalid_stdin_secrets'); }
}
async function readSecretFile(path) {
  if (!path || !existsSync(path)) return null;
  try { return (await readPrivate(path)).trim(); } catch { return null; }
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArguments(argv);
  if (options.help || !options.positional.length) { console.log(usage); return 0; }
  const defaults = defaultPaths();
  const jobPath = resolve(options.positional[0]);
  const job = firstJob(await readJsonFile(jobPath, 'invalid_jobs_file'));
  const directory = resolve(options.data || defaults.data);
  const configPath = resolve(options.config || defaults.config);
  const supplied = await readJsonFile(configPath, 'invalid_config_file');
  const mode = options.mode || 'live';
  requireThat(['live', 'fake'].includes(mode), 'invalid_mode');

  // The Studio workflow is login and session verification; merchant visits stay
  // off unless the config explicitly keeps them.
  const keepSeedSites = options['seed-sites'] === 'config';
  const config = validateConfig({ ...supplied,
    ...(keepSeedSites ? {} : { seedSites: [] }),
    ...(options['human-checkpoint-seconds']
      ? { humanCheckpointSeconds: Number(options['human-checkpoint-seconds']) } : {}) });

  if (options['dry-run']) {
    if (mode === 'fake') {
      console.log(JSON.stringify({ mode: 'dry_run', runner: 'fake', job, data: directory, config: {
        folderId: config.folderId, proxyMode: config.proxyMode, verifyRestart: config.verifyRestart,
        humanCheckpointSeconds: config.humanCheckpointSeconds } }, null, 2));
      return 0;
    }
    const accountIndex = await loadAccountIndex({
      path: options.accounts !== undefined ? resolve(options.accounts) : defaults.accounts,
      directory: options['accounts-dir'] ? resolve(options['accounts-dir']) : undefined });
    const plan = await inspectJobPlan({ jobs: [job], accountIndex, directory });
    const resume = await inspectOrchestratorResume({ directory, job, accountIndex, jobs: [job] });
    console.log(JSON.stringify({ mode: 'dry_run', runner: 'live', data: directory, job,
      config: { folderId: config.folderId, launcherUrl: config.launcherUrl, proxyMode: config.proxyMode,
        proxyCountry: config.proxyCountry, verifyRestart: config.verifyRestart,
        humanCheckpointSeconds: config.humanCheckpointSeconds, seedSites: config.seedSites },
      resume: { resumable: resume.resumable, from: resume.from, checkpoint: resume.checkpoint,
        profileId: resume.profileId },
      plan }, null, 2));
    if (plan.status !== 'ok') process.exitCode = 2;
    return process.exitCode || 0;
  }

  const onEvent = options.json ? async () => {} : async entry => { console.log(JSON.stringify(entry)); };

  if (mode === 'fake') {
    // Offline lifecycle proof: the REAL login/recovery/checkpoint/Studio/restart
    // code paths against a local provider fixture. No account, no network, no
    // provider budget.
    const { createFakeBackend } = await import('./test/fixtures/fake-backend.mjs');
    const backend = await createFakeBackend({ humanCheckpointSeconds: Number(options['human-checkpoint-seconds'] || 30) });
    try {
      // The fixture owns its own account/profile refs; the requested job id and
      // platform are kept so the evidence lands under the operator's job id.
      requireThat((job.platform || 'youtube') === 'youtube', 'fake_mode_requires_youtube_job');
      const fixtureJob = { id: job.id, platform: 'youtube',
        accountRef: backend.job.accountRef, profileRef: `${backend.job.profileRef}-${job.id}`.slice(0, 64) };
      // In fake mode the "person" is simulated: once the job has announced its
      // checkpoint, the challenge is cleared in the same held browser. The real
      // orchestrator gate (live re-observation) is unchanged.
      let autoResolve = null;
      const waiting = new Promise(resolve => { autoResolve = resolve; });
      const simulatedPerson = (async () => {
        await waiting;
        const deadline = Date.now() + 20000;
        while (Date.now() < deadline) {
          for (const page of backend.pages()) {
            const count = await page.locator('#human').count().catch(() => 0);
            if (count > 0) { await page.locator('#human').click().catch(() => {}); return; }
          }
          await new Promise(resolve => setTimeout(resolve, 50));
        }
      })();
      const streaming = async entry => {
        await onEvent(entry);
        if (entry.event === 'job_state' && entry.lifecycleState === 'WAITING_FOR_HUMAN') autoResolve?.();
      };
      const result = await runSingleJob({ job: fixtureJob, accountIndex: backend.accountIndex,
        config: { ...backend.config, humanCheckpointSeconds: Number(options['human-checkpoint-seconds'] || 30) },
        directory, api: backend.api, guideFactory: backend.guideFactory,
        connectImpl: backend.connectImpl, studioImpl: backend.studioImpl, notifier: null, notify: false,
        telegram: false, memory: options['no-memory'] ? null : createRecoveryMemory({ directory: resolve(directory, 'memory') }),
        onEvent: streaming });
      await simulatedPerson.catch(() => {});
      console.log(JSON.stringify({ step: 'result', mode: 'fake', ...result.result }, null, 2));
      process.exitCode = orchestrationExitCode(result.result);
      return process.exitCode;
    } finally { await backend.close(); }
  }

  const secrets = options['stdin-secrets'] ? await readStdinSecrets() : {};
  const fileToken = await readSecretFile(options['token-file'] || defaults.tokenFile);
  const token = secrets.multiloginToken || process.env.MULTILOGIN_AUTOMATION_TOKEN
    || process.env.MULTILOGIN_TOKEN || fileToken;
  requireThat(typeof token === 'string' && token.length > 10, 'missing_multilogin_token');
  const provider = options.provider || process.env.BROWSER_MODEL_PROVIDER || 'typesafe';
  const fileKey = await readSecretFile(options['key-file'] || defaults.keyFile);
  const apiKey = provider === 'typesafe'
    ? (secrets.typesafeKey || process.env.TYPESAFE_API_KEY || fileKey)
    : (secrets.fireworksKey || process.env.FIREWORKS_API_KEY || fileKey);
  requireThat(typeof apiKey === 'string' && apiKey.length > 10, 'missing_provider_key');

  const accountIndex = await loadAccountIndex({
    path: options.accounts !== undefined ? resolve(options.accounts) : defaults.accounts,
    directory: options['accounts-dir'] ? resolve(options['accounts-dir']) : undefined });
  const api = new Multilogin({ token, launcherUrl: config.launcherUrl });
  const cancel = new CancelToken();
  const requestCancel = () => { cancel.abort('cancelled_by_signal');
    console.error(JSON.stringify({ event: 'cancel_requested', detail: 'finishing the current browser step first' })); };
  process.once('SIGINT', requestCancel); process.once('SIGTERM', requestCancel);
  const notifier = options['no-notify'] ? null : createTelegramNotifier();
  const memory = options['no-memory'] ? null : createRecoveryMemory({ directory: resolve(directory, 'memory') });
  const resume = await inspectOrchestratorResume({ directory, job, accountIndex, jobs: [job] });
  const { result } = await runSingleJob({ job, accountIndex, config, directory, api,
    guideFactory: () => createChooser({ provider, apiKey, model: options.model }),
    notifier, notify: !options['no-notify'], telegram: !options['no-telegram'],
    humanCheckpointPollMs: Number(options['checkpoint-poll-ms'] || 2000),
    telegramPollMs: Number(options['telegram-poll-ms'] || 2000),
    cancel, memory, resume, preserveOnCheckpoint: options['preserve-on-checkpoint'] === true, onEvent });
  console.log(JSON.stringify({ step: 'result', mode: 'live', ...result }, null, 2));
  process.exitCode = orchestrationExitCode(result);
  return process.exitCode;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { console.error(JSON.stringify({ status: 'stopped', reason: errorCode(error) }));
    process.exitCode = 1; });
}
