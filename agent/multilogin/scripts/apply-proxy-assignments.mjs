import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { requireThat } from '../src/core.mjs';
import { readPrivate } from '../src/storage.mjs';
import { Multilogin } from '../src/multilogin.mjs';
import { parseProxyFile } from './set-custom-proxy.mjs';

// Batch-attach per-character custom proxies to their Multilogin profiles.
//
// Assignments file (JSON, no credentials):
//   [ { "code": "K01", "kind": "instagram|youtube|tiktok", "profileId": "..." } ]
// Proxy files live at /data/proxies/<code lowercase>.txt (see set-custom-proxy.mjs).
//
// Usage:
//   node scripts/apply-proxy-assignments.mjs --assignments /data/proxies/assignments.json \
//     [--proxy-dir /data/proxies] [--token-file /data/automation-token] [--confirm]

export function parseArguments(argv) {
  const options = { positional: [] };
  const valueFlags = ['--assignments', '--proxy-dir', '--token-file'];
  for (let index = 0; index < argv.length; index++) {
    const token = argv[index];
    if (token === '--confirm') options.confirm = true;
    else if (valueFlags.includes(token)) {
      const value = argv[index + 1];
      requireThat(typeof value === 'string' && !value.startsWith('--'), 'invalid_command_arguments');
      options[token.slice(2)] = value;
      index++;
    } else if (token.startsWith('--')) throw new Error(`unknown argument ${token}`);
  }
  return options;
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArguments(argv);
  requireThat(options.assignments, 'assignments_required');
  const proxyDir = options['proxy-dir'] || '/data/proxies';
  const token = (await readPrivate(resolve(options['token-file'] || '/data/automation-token'))).trim();
  const api = new Multilogin({ token, launcherUrl: 'https://launcher.mlx.yt:45001' });
  const assignments = JSON.parse(await readFile(options.assignments, 'utf8'));
  requireThat(Array.isArray(assignments) && assignments.length > 0, 'assignments_empty');
  const cache = new Map();
  const results = [];

  for (const assignment of assignments) {
    const { code, kind, profileId } = assignment;
    requireThat(code && profileId, 'assignment_invalid');
    const file = resolve(proxyDir, `${code.toLowerCase()}.txt`);
    if (!cache.has(file)) cache.set(file, parseProxyFile(await readFile(file, 'utf8')));
    const proxy = cache.get(file);
    const before = await api.profileMeta(profileId);
    const row = { code, kind: kind ?? null, profileId, host: proxy.host, port: proxy.port, type: proxy.type, maskingBefore: before?.parameters?.flags?.proxy_masking ?? before?.proxy_masking ?? null, status: null };
    if (before?.in_use_by) {
      row.status = 'skipped_in_use';
      results.push(row);
      continue;
    }
    if (!options.confirm) {
      row.status = 'dry_run';
      results.push(row);
      continue;
    }
    await api.changeProxy(profileId, proxy);
    const after = await api.profileMeta(profileId);
    const masking = after?.parameters?.flags?.proxy_masking ?? after?.proxy_masking ?? null;
    row.maskingAfter = masking;
    row.status = masking === 'custom' ? 'attached' : 'unconfirmed';
    results.push(row);
  }

  console.log(JSON.stringify({ step: 'apply_proxy_assignments', confirm: Boolean(options.confirm), results }, null, 2));
  return results.every((row) => ['attached', 'dry_run'].includes(row.status)) ? 0 : 2;
}

if (process.argv[1] && import.meta.url === new URL(`file://${resolve(process.argv[1])}`).href) {
  main().then((code) => process.exit(code)).catch((error) => {
    console.error(JSON.stringify({ status: 'error', error: String(error?.message ?? error).slice(0, 200) }));
    process.exit(2);
  });
}
