import { resolve } from 'node:path';
import { requireThat } from '../src/core.mjs';
import { readPrivate } from '../src/storage.mjs';
import { Multilogin } from '../src/multilogin.mjs';
import { renameProfilePreservingConfiguration, parametersDigest } from '../src/profile-labels.mjs';

// Operator tool: set a human-readable Multilogin profile label without moving
// the profile's fingerprint, proxy, storage or flags. The only label-like field
// the API has is the profile name, so the rename carries the profile's own
// `parameters` back byte-identically and verifies the result by re-reading it.
//
// Usage:
//   node scripts/label-profile.mjs --profile-id <id> --name "YT-04 | HUMAN | ..." \
//     [--token-file /data/automation-token] [--launcher-url https://launcher.mlx.yt:45001]
const valueFlags = ['--profile-id', '--name', '--token-file', '--launcher-url'];

export function parseArguments(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    requireThat(valueFlags.includes(token), `unknown argument ${token}`);
    const value = argv[index + 1];
    requireThat(typeof value === 'string' && !value.startsWith('--'), 'invalid_command_arguments');
    options[token.slice(2)] = value; index += 1;
  }
  return options;
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArguments(argv);
  requireThat(options['profile-id'], 'profile_id_required');
  requireThat(options.name, 'name_required');
  const token = await readPrivate(resolve(options['token-file'] || '/data/automation-token'));
  const api = new Multilogin({ token: token.trim(),
    launcherUrl: options['launcher-url'] || 'https://launcher.mlx.yt:45001' });
  const result = await renameProfilePreservingConfiguration({ api, profileId: options['profile-id'],
    name: options.name });
  // No token, proxy credentials or handles are printed; the digest proves the
  // configuration did not move.
  console.log(JSON.stringify({ step: 'label_profile', profileId: result.profileId, name: result.name,
    previousName: result.previousName, parametersUnchanged: result.parametersUnchanged,
    proxyUnchanged: result.proxyUnchanged, digest: parametersDigest((await api.profileMeta(result.profileId))?.parameters).slice(0, 16) }, null, 2));
  return 0;
}

if (!process.argv[1] || process.argv[1] === '-' || process.argv[1].endsWith('label-profile.mjs')) {
  main().then(code => { process.exitCode = code; }).catch(error => {
    console.error(JSON.stringify({ step: 'label_profile', error: String(error?.message || error) }));
    process.exitCode = 1;
  });
}
