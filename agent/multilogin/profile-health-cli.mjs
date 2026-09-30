import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { PilotError, errorCode, requireThat } from './src/core.mjs';
import { readPrivate } from './src/storage.mjs';
import { validateConfig } from './src/runner.mjs';
import { buildHealthReport, formatHealthTable } from './src/profile-health.mjs';
import { applyProfileLabels } from './src/profile-labels.mjs';
import { Multilogin } from './src/multilogin.mjs';

// npm run browser:profiles [-- --youtube] [--json] [--apply-labels]
//
// Read-only by default. `--apply-labels` renames the Multilogin profiles to the
// health label, preserving the profile's own parameters byte-identically and
// verifying afterwards that nothing but the name moved.
const here = dirname(fileURLToPath(import.meta.url));
const switchFlags = ['--youtube', '--json', '--apply-labels', '--help'];
const valueFlags = ['--data', '--config', '--token-file'];

export function parseArguments(argv = []) {
  const options = {};
  for (let index = 0; index < argv.length; index++) {
    const token = argv[index];
    if (switchFlags.includes(token)) options[token.slice(2)] = true;
    else if (valueFlags.includes(token)) {
      const value = argv[index + 1];
      requireThat(typeof value === 'string' && !value.startsWith('--'), 'invalid_command_arguments');
      options[token.slice(2)] = value; index++;
    } else if (token.startsWith('--')) throw new PilotError('unknown_command_argument');
  }
  return options;
}

const usage = 'Usage: node profile-health-cli.mjs [--data DIR] [--youtube] [--json] '
  + '[--apply-labels --token-file PATH --config config.vps.json]';

export async function main(argv = process.argv.slice(2)) {
  const options = parseArguments(argv);
  if (options.help) { console.log(usage); return 0; }
  const directory = resolve(options.data || resolve(here, 'private/state'));
  const platform = options.youtube ? 'youtube' : null;
  const report = await buildHealthReport({ directory, platform });
  if (options.json) console.log(JSON.stringify(report, null, 2));
  else console.log(formatHealthTable(report));
  if (!options['apply-labels']) return 0;
  requireThat(options['token-file'], 'token_file_required_for_label_apply');
  requireThat(existsSync(options['token-file']), 'token_file_missing');
  const token = (await readPrivate(resolve(options['token-file']))).trim();
  const configPath = options.config ? resolve(options.config) : resolve(here, 'config.vps.json');
  const supplied = JSON.parse(await (await import('node:fs/promises')).readFile(configPath, 'utf8'));
  const config = validateConfig(supplied);
  const api = new Multilogin({ token, launcherUrl: config.launcherUrl });
  const outcome = await applyProfileLabels({ report, api, apply: true });
  console.log(JSON.stringify({ step: 'labels', ...outcome }, null, 2));
  if (outcome.results.some(result => result.action === 'failed')) process.exitCode = 2;
  return process.exitCode || 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { console.error(JSON.stringify({ status: 'stopped', reason: errorCode(error),
    detail: error?.message && error.message !== errorCode(error) ? error.message : undefined }));
    process.exitCode = 1; });
}
