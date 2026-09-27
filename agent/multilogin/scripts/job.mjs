import { existsSync } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import { spawn, spawnSync } from 'node:child_process';
import { basename, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname } from 'node:path';

// The operator entry point. ONE command owns the whole job:
//
//   npm run browser:job -- jobs/yt-live-05.json                 # local/worker host
//   npm run browser:job -- jobs/yt-live-05.json --remote        # run on the VPS over SSH
//   npm run browser:job -- jobs/yt-live-05.json --fake          # offline lifecycle proof
//   npm run browser:job -- jobs/yt-live-05.json --dry-run       # plan only, no browser
//
// Remote mode syncs the job file to the worker host, runs `job-runner.mjs`
// inside the existing `buena-multilogin` Compose project (same launcher network
// namespace), streams the NDJSON progress, and mirrors the job evidence back to
// .browser-jobs/<job-id>/ on this machine. No second terminal is required: the
// same process announces a human checkpoint on Telegram and accepts /status,
// /done and /cancel while it waits.
const here = dirname(fileURLToPath(import.meta.url));
const packageDirectory = resolve(here, '..');
const passthrough = new Set(['--data', '--config', '--accounts', '--accounts-dir', '--provider', '--model',
  '--human-checkpoint-seconds', '--token-file', '--key-file', '--checkpoint-poll-ms', '--telegram-poll-ms',
  '--no-notify', '--no-telegram', '--no-memory', '--preserve-on-checkpoint', '--stdin-secrets', '--json',
  '--reuse-existing-proxy', '--load-media', '--discord-webhook-file', '--challenge-settle-ms', '--resume-command']);

export function parseArguments(argv) {
  const options = { positional: [], passthrough: [] };
  for (let index = 0; index < argv.length; index++) {
    const token = argv[index];
    if (token === '--remote') {
      const next = argv[index + 1];
      if (next && !next.startsWith('--')) { options.remote = next; index++; } else options.remote = true;
    } else if (token === '--local') options.local = true;
    else if (token === '--fake') options.fake = true;
    else if (token === '--dry-run') options['dry-run'] = true;
    else if (token === '--dry-run-remote') options['dry-run-remote'] = true;
    else if (token === '--build') options.build = true;
    else if (passthrough.has(token)) {
      options.passthrough.push(token);
      const next = argv[index + 1];
      if (next !== undefined && !next.startsWith('--')) { options.passthrough.push(next); index++; }
    } else options.positional.push(token);
  }
  return options;
}

export function hostArtifactDirectory({ directory, dataDirectory } = {}) {
  const data = dataDirectory || '/data/account-pilot';
  // The worker mounts `${directory}/private` at /data, so the container's data
  // path maps onto the host filesystem differently from the run flag.
  if (data.startsWith('/data/')) return `${directory}/private/${data.slice('/data/'.length)}`;
  return data;
}

export function remoteCommands({ host, directory, jobFile, jobId, extra = [], dataDirectory = null } = {}) {
  const name = basename(jobFile);
  const remoteJob = `${directory}/private/jobs/${name}`;
  const data = dataDirectory || '/data/account-pilot';
  const flags = ['--data', data, '--config', 'config.vps.json', '--accounts', '/data/accounts.json',
    '--token-file', '/data/automation-token', '--provider', 'fireworks', '--key-file', '/data/fireworks-api-key'];
  const mounts = `-v ${directory}-orchestrator/src:/app/src:ro`
    + ` -v ${directory}-orchestrator/job-runner.mjs:/app/job-runner.mjs:ro`;
  return [
    `ssh ${host} "mkdir -p ${directory}/private/jobs ${directory}/private/state && chmod 700 ${directory}/private/jobs && chown 1000:1000 ${directory}/private/jobs"`,
    `cat ${jobFile} | ssh ${host} "cat > ${remoteJob} && chmod 600 ${remoteJob} && chown 1000:1000 ${remoteJob}"`,
    `ssh ${host} "cd ${directory} && docker compose run --rm --no-deps -T ${mounts} --entrypoint node worker job-runner.mjs /data/jobs/${name} ${flags.join(' ')} ${extra.join(' ')}"`,
    `ssh ${host} "cd ${directory} && tar -C ${hostArtifactDirectory({ directory, dataDirectory })}/jobs/${jobId} -czf - ." | tar -xzf - -C .browser-jobs/${jobId}`,
  ];
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArguments(argv);
  if (!options.positional.length) {
    console.log('Usage: npm run browser:job -- jobs/<job>.json [--remote [user@host]] [--fake] [--dry-run] [--build]');
    return 0;
  }
  const jobFile = resolve(options.positional[0]);
  if (!existsSync(jobFile)) { console.error(`job file not found: ${jobFile}`); process.exitCode = 1; return 1; }
  let jobDocument = null;
  try { jobDocument = JSON.parse(await readFile(jobFile, 'utf8')); } catch { /* job-runner validates */ }
  const jobs = Array.isArray(jobDocument) ? jobDocument : jobDocument?.jobs;
  const first = Array.isArray(jobs) ? jobs[0] : null;
  const jobId = (Array.isArray(jobs) && jobs.length === 1 && first?.id) ? first.id : null;

  const remote = options.fake || options.local ? null
    : (typeof options.remote === 'string' ? options.remote
      : options.remote === true || process.env.BROWSER_JOB_REMOTE === '1'
        ? process.env.BROWSER_JOB_HOST || 'root@100.121.5.10' : null);

  if (options['dry-run-remote']) {
    const commands = remoteCommands({ host: remote || process.env.BROWSER_JOB_HOST || 'root@100.121.5.10',
      directory: process.env.BROWSER_JOB_DIR || '/opt/buena-multilogin', jobFile, jobId: jobId || '<job-id>',
      extra: options.passthrough });
    console.log(JSON.stringify({ mode: 'dry_run_remote', commands }, null, 2));
    return 0;
  }

  const extra = [...options.passthrough];
  if (options['dry-run']) extra.push('--dry-run');

  if (!remote) {
    const args = [resolve(packageDirectory, 'job-runner.mjs'), jobFile, ...extra, ...(options.fake ? ['--mode', 'fake'] : [])];
    const child = spawn(process.execPath, args, { stdio: 'inherit', cwd: packageDirectory });
    const code = await new Promise(resolvePromise => child.once('exit', (value, signal) => resolvePromise(value ?? (signal ? 1 : 0))));
    process.exitCode = code;
    return code;
  }

  const host = remote;
  const directory = process.env.BROWSER_JOB_DIR || '/opt/buena-multilogin';
  const name = basename(jobFile);
  const remoteJob = `${directory}/private/jobs/${name}`;
  // 1. Ensure the remote job directory exists.
  const prepare = spawnSync('ssh', [host, `mkdir -p ${directory}/private/jobs ${directory}/private/state && chmod 700 ${directory}/private/jobs && chown 1000:1000 ${directory}/private/jobs`],
    { stdio: ['ignore', 'inherit', 'inherit'] });
  if (prepare.status !== 0) { console.error(JSON.stringify({ status: 'stopped', reason: 'remote_prepare_failed' })); process.exitCode = 1; return 1; }
  // 2. Copy the job file (mode 600 at the destination) and hand it to the
  //    container's uid so the worker can read it.
  const copy = spawnSync('ssh', [host, `cat > ${remoteJob} && chmod 600 ${remoteJob} && chown 1000:1000 ${remoteJob}`],
    { input: await readFile(jobFile), stdio: ['pipe', 'inherit', 'inherit'] });
  if (copy.status !== 0) { console.error(JSON.stringify({ status: 'stopped', reason: 'remote_job_copy_failed' })); process.exitCode = 1; return 1; }
  if (options.build) {
    const build = spawnSync('ssh', [host, `cd ${directory} && docker compose build worker`], { stdio: 'inherit' });
    if (build.status !== 0) { console.error(JSON.stringify({ status: 'stopped', reason: 'remote_build_failed' })); process.exitCode = 1; return 1; }
  }
  const dataDirectory = process.env.BROWSER_JOB_DATA || '/data/account-pilot';
  const mounts = `-v ${directory}-orchestrator/src:/app/src:ro`
    + ` -v ${directory}-orchestrator/job-runner.mjs:/app/job-runner.mjs:ro`;
  const flags = ['--data', dataDirectory, '--config', 'config.vps.json', '--accounts', '/data/accounts.json',
    '--token-file', process.env.BROWSER_TOKEN_FILE || '/data/automation-token',
    '--provider', process.env.BROWSER_MODEL_PROVIDER || 'fireworks',
    '--key-file', process.env.BROWSER_KEY_FILE || '/data/fireworks-api-key'];
  const command = `cd ${directory} && docker compose run --rm --no-deps -T ${mounts} --entrypoint node worker `
    + `job-runner.mjs /data/jobs/${name} ${flags.join(' ')} ${extra.join(' ')}`;
  const run = spawn('ssh', [host, command], { stdio: ['inherit', 'pipe', 'inherit'] });
  let captured = '';
  let pending = '';
  run.stdout.on('data', chunk => {
    const text = chunk.toString();
    process.stdout.write(text);
    pending += text;
    const lines = pending.split('\n');
    pending = lines.pop();
    for (const line of lines) if (line.includes('"step": "result"') || line.includes('"step":"result"')) captured = line;
  });
  const code = await new Promise(resolvePromise => run.once('exit', value => resolvePromise(value ?? 1)));
  // 4. Mirror the job evidence locally, even when the run ends waiting/failed.
  const result = (() => { try { return JSON.parse(captured); } catch { return null; } })();
  const mirrorId = result?.jobId || jobId;
  if (mirrorId) {
    const destination = resolve(process.cwd(), '.browser-jobs', mirrorId);
    await mkdir(destination, { recursive: true });
    const tar = spawn('ssh', [host, `cd ${directory} && tar -C ${hostArtifactDirectory({ directory, dataDirectory })}/jobs/${mirrorId} -czf - .`], { stdio: ['ignore', 'pipe', 'inherit'] });
    const extract = spawn('tar', ['-xzf', '-', '-C', destination], { stdio: ['pipe', 'inherit', 'inherit'] });
    tar.stdout.pipe(extract.stdin);
    const [tarCode, extractCode] = await Promise.all([
      new Promise(resolvePromise => tar.once('exit', resolvePromise)),
      new Promise(resolvePromise => extract.once('exit', resolvePromise)),
    ]);
    if (tarCode === 0 && extractCode === 0) console.log(JSON.stringify({ event: 'artifacts_mirrored', jobId: mirrorId, path: destination }));
    else console.error(JSON.stringify({ event: 'artifacts_mirror_failed', jobId: mirrorId, tarCode, extractCode }));
  }
  process.exitCode = code;
  return code;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { console.error(JSON.stringify({ status: 'stopped', reason: error?.code || error?.message || 'error' }));
    process.exitCode = 1; });
}
