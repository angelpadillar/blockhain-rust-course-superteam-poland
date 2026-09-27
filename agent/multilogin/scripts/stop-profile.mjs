import { resolve } from 'node:path';
import { requireThat } from '../src/core.mjs';
import { readPrivate } from '../src/storage.mjs';
import { Multilogin } from '../src/multilogin.mjs';

// Stop ONE Multilogin profile (clears a stale browser session after a crashed
// worker). Safe: reports `alreadyStopped` instead of failing.
//
// Usage:
//   node scripts/stop-profile.mjs --profile-id <id> [--token-file /data/automation-token]

export function parseArguments(argv) {
  const options = { positional: [] };
  const valueFlags = ['--profile-id', '--token-file'];
  for (let index = 0; index < argv.length; index++) {
    const token = argv[index];
    if (valueFlags.includes(token)) {
      const value = argv[index + 1];
      requireThat(typeof value === 'string' && !value.startsWith('--'), 'invalid_command_arguments');
      options[token.slice(2)] = value;
      index++;
    } else if (token.startsWith('--')) throw new Error(`unknown argument ${token}`);
    else options.positional.push(token);
  }
  return options;
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArguments(argv);
  requireThat(options['profile-id'], 'profile_id_required');
  const token = (await readPrivate(resolve(options['token-file'] || '/data/automation-token'))).trim();
  const api = new Multilogin({ token, launcherUrl: 'https://launcher.mlx.yt:45001' });
  const result = await api.stop(options['profile-id']);
  const status = result?.alreadyStopped ? 'already_stopped' : 'stopped';
  console.log(JSON.stringify({ step: 'stop_profile', profileId: options['profile-id'], status }, null, 2));
  return 0;
}

if (process.argv[1] && import.meta.url === new URL(`file://${resolve(process.argv[1])}`).href) {
  main().then((code) => process.exit(code)).catch((error) => {
    console.error(JSON.stringify({ status: 'error', error: String(error?.message ?? error).slice(0, 200) }));
    process.exit(2);
  });
}
