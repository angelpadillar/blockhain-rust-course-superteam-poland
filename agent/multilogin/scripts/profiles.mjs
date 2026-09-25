import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Operator entry point:
//
//   npm run browser:profiles                       # local data dir
//   npm run browser:profiles -- --youtube         # YouTube profiles only
//   npm run browser:profiles -- --remote          # read the live VPS store
//   npm run browser:profiles -- --remote --apply-labels
//
// Remote runs use the existing worker image with this branch's src bind-mounted;
// `--apply-labels` needs the Multilogin automation token, which stays a mode-600
// private file and is never printed.
const here = dirname(fileURLToPath(import.meta.url));
const packageDirectory = resolve(here, '..');
const passthrough = new Set(['--youtube', '--json', '--data', '--config', '--token-file']);

export function parseArguments(argv = []) {
  const options = { passthrough: [] };
  for (let index = 0; index < argv.length; index++) {
    const token = argv[index];
    if (token === '--remote') {
      const next = argv[index + 1];
      if (next && !next.startsWith('--')) { options.remote = next; index++; } else options.remote = true;
    } else if (token === '--local') options.local = true;
    else if (token === '--apply-labels') options['apply-labels'] = true;
    else if (passthrough.has(token)) {
      options.passthrough.push(token);
      if (argv[index + 1] !== undefined && !argv[index + 1].startsWith('--')) { options.passthrough.push(argv[index + 1]); index++; }
    }
  }
  return options;
}

export function remoteProfileCommands({ host, directory, extra = [], tokenFile = null } = {}) {
  const flags = ['--data', '/data/account-pilot', ...extra];
  return [
    `ssh ${host} "mkdir -p ${directory} && test -d ${directory}/private"`,
    `ssh ${host} "cd ${directory} && docker compose run --rm --no-deps -T`
    + ` -v ${directory}-orchestrator/src:/app/src:ro -v ${directory}-orchestrator/profile-health-cli.mjs:/app/profile-health-cli.mjs:ro`
    + ` --entrypoint node worker profile-health-cli.mjs ${flags.join(' ')}${tokenFile ? ` --token-file ${tokenFile}` : ''}"`,
  ];
}

const remoteDataDirectory = () => process.env.BROWSER_JOB_DATA || '/data/account-pilot';

export async function main(argv = process.argv.slice(2)) {
  const options = parseArguments(argv);
  const remote = options.local ? null
    : (typeof options.remote === 'string' ? options.remote
      : options.remote === true || process.env.BROWSER_PROFILES_REMOTE === '1'
        ? process.env.BROWSER_JOB_HOST || 'root@100.121.5.10' : null);
  if (!remote) {
    const args = [resolve(packageDirectory, 'profile-health-cli.mjs'), ...options.passthrough];
    if (options['apply-labels']) args.push('--apply-labels');
    const child = spawn(process.execPath, args, { stdio: 'inherit', cwd: packageDirectory });
    const code = await new Promise(resolvePromise => child.once('exit', value => resolvePromise(value ?? 1)));
    process.exitCode = code; return code;
  }
  const host = remote;
  const directory = process.env.BROWSER_JOB_DIR || '/opt/buena-multilogin';
  const extra = [...options.passthrough];
  const tokenFile = options['apply-labels']
    ? (process.env.BROWSER_TOKEN_FILE || '/data/automation-token') : null;
  const command = `cd ${directory} && docker compose run --rm --no-deps -T`
    + ` -v ${directory}-orchestrator/src:/app/src:ro -v ${directory}-orchestrator/profile-health-cli.mjs:/app/profile-health-cli.mjs:ro`
    + ` --entrypoint node worker profile-health-cli.mjs --data ${remoteDataDirectory()} ${extra.join(' ')}`
    + `${options['apply-labels'] ? ` --apply-labels --token-file ${tokenFile}` : ''}`;
  const child = spawn('ssh', [host, command], { stdio: 'inherit' });
  const code = await new Promise(resolvePromise => child.once('exit', value => resolvePromise(value ?? 1)));
  process.exitCode = code; return code;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { console.error(JSON.stringify({ status: 'stopped', reason: error?.code || error?.message || 'error' }));
    process.exitCode = 1; });
}
