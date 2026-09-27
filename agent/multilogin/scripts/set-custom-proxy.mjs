import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { requireThat } from '../src/core.mjs';
import { readPrivate } from '../src/storage.mjs';
import { Multilogin } from '../src/multilogin.mjs';

// Attach a custom proxy (SOCKS5 or HTTP) to ONE Multilogin profile, preserving
// the rest of the profile configuration. Dry-run by default; credentials are
// read from a private file and never printed.
//
// Proxy file format (mode 600):
//   protocol=socks5|http
//   host=...
//   port=...
//   user=...
//   pass=...
//
// Usage:
//   node scripts/set-custom-proxy.mjs --profile-id <id> --proxy-file /data/iproyal-k01.txt \
//     [--token-file /data/automation-token] [--confirm] [--dry-run]

export function parseArguments(argv) {
  const options = { positional: [] };
  const valueFlags = ['--profile-id', '--proxy-file', '--token-file', '--label'];
  for (let index = 0; index < argv.length; index++) {
    const token = argv[index];
    if (token === '--confirm') options.confirm = true;
    else if (token === '--dry-run') options.dryRun = true;
    else if (valueFlags.includes(token)) {
      const value = argv[index + 1];
      requireThat(typeof value === 'string' && !value.startsWith('--'), 'invalid_command_arguments');
      options[token.slice(2)] = value;
      index++;
    } else if (token.startsWith('--')) throw new Error(`unknown argument ${token}`);
    else options.positional.push(token);
  }
  return options;
}

export function parseProxyFile(text) {
  const fields = {};
  for (const line of String(text ?? '').split('\n')) {
    const match = /^([a-z]+)\s*=\s*(.+)$/.exec(line.trim());
    if (match) fields[match[1]] = match[2].trim();
  }
  requireThat(['socks5', 'socks', 'http', 'https'].includes(fields.protocol), 'proxy_protocol_required');
  requireThat(fields.host, 'proxy_host_required');
  requireThat(Number.isFinite(Number(fields.port)), 'proxy_port_required');
  return {
    type: fields.protocol === 'socks' ? 'socks5' : fields.protocol,
    host: fields.host,
    port: Number(fields.port),
    ...(fields.user ? { username: fields.user } : {}),
    ...(fields.pass ? { password: fields.pass } : {}),
  };
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArguments(argv);
  requireThat(options['profile-id'], 'profile_id_required');
  requireThat(options['proxy-file'], 'proxy_file_required');
  const token = (await readPrivate(resolve(options['token-file'] || '/data/automation-token'))).trim();
  const proxy = parseProxyFile(await readFile(options['proxy-file'], 'utf8'));
  const api = new Multilogin({ token, launcherUrl: 'https://launcher.mlx.yt:45001' });

  const before = await api.profileMeta(options['profile-id']);
  requireThat(before, 'profile_metadata_missing');
  requireThat(!before.in_use_by, 'profile_in_use');
  const report = {
    step: 'set_custom_proxy',
    label: options.label || null,
    profileId: options['profile-id'],
    host: proxy.host,
    port: proxy.port,
    type: proxy.type,
    proxyMaskingBefore: before?.parameters?.flags?.proxy_masking ?? before?.proxy_masking ?? null,
    changed: false,
  };

  if (!options.confirm) {
    report.status = 'dry_run';
    console.log(JSON.stringify(report, null, 2));
    return 0;
  }

  await api.changeProxy(options['profile-id'], proxy);
  const after = await api.profileMeta(options['profile-id']);
  const masking = after?.parameters?.flags?.proxy_masking ?? after?.proxy_masking ?? null;
  report.proxyMaskingAfter = masking;
  report.changed = masking === 'custom';
  report.status = report.changed ? 'attached' : 'attach_unconfirmed';
  console.log(JSON.stringify(report, null, 2));
  return report.changed ? 0 : 2;
}

if (process.argv[1] && import.meta.url === new URL(`file://${resolve(process.argv[1])}`).href) {
  main().then((code) => process.exit(code)).catch((error) => {
    console.error(JSON.stringify({ status: 'error', error: String(error?.message ?? error).slice(0, 200) }));
    process.exit(2);
  });
}
