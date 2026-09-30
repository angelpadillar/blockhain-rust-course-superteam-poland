import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { requireThat } from '../src/core.mjs';
import { readPrivate } from '../src/storage.mjs';
import { Multilogin } from '../src/multilogin.mjs';

// Provision ONE Multilogin premium proxy (country) and write it in the standard
// private proxy-file format. Use when an IPRoyal IP is blocked by a platform and
// the premium balance covers the operation.
//
// Usage:
//   node scripts/provision-premium-proxy.mjs --country pl --out /data/proxies/k02.txt

export function parseArguments(argv) {
  const options = { positional: [] };
  const valueFlags = ['--country', '--out', '--token-file'];
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
  const country = options.country || 'pl';
  requireThat(/^[a-z]{2}$/.test(country), 'invalid_country');
  requireThat(options.out, 'out_required');
  const token = (await readPrivate(resolve(options['token-file'] || '/data/automation-token'))).trim();
  const api = new Multilogin({ token, launcherUrl: 'https://launcher.mlx.yt:45001' });
  const proxy = await api.premiumProxy(country);
  const out = resolve(options.out);
  const body = `protocol=socks5\nhost=${proxy.host}\nport=${proxy.port}\nuser=${proxy.username}\npass=${proxy.password}\n`;
  await writeFile(out, body, { mode: 0o600 });
  console.log(JSON.stringify({ step: 'provision_premium_proxy', country, host: proxy.host, port: proxy.port, out }, null, 2));
  return 0;
}

if (process.argv[1] && import.meta.url === new URL(`file://${resolve(process.argv[1])}`).href) {
  main().then((code) => process.exit(code)).catch((error) => {
    console.error(JSON.stringify({ status: 'error', error: String(error?.message ?? error).slice(0, 200) }));
    process.exit(2);
  });
}
