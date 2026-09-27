import { copyFileSync, existsSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { requireThat, accountId } from '../src/core.mjs';
import { readPrivate } from '../src/storage.mjs';
import { loadAccountIndex } from '../src/accounts.mjs';
import { Multilogin } from '../src/multilogin.mjs';

// Operator-approved reconciliation of a stale profile lifecycle marker.
//
// A `pending` marker means the worker crashed between creating/starting a
// profile and clearing the marker. The runner correctly refuses to touch such a
// profile. This tool clears the marker ONLY after proving from the launcher's
// own status that the profile is not running and not in use:
//
//   allowed launcher statuses: stopped, start_browser_error
//   forbidden: anything with in_use_by set, or a pending marker of "create"
//              (a created profile may exist and must be reconciled by hand)
//
// Every file is backed up and every action is appended to
// <data>/reconciliations.ndjson. No credentials or proxy data are printed.
//
// Usage:
//   node scripts/reconcile-profile.mjs --data /data/account-pilot --accounts /data/accounts.json \
//     --account-ref yt-live-04 --profile-id <expected-profile-id> --confirm-reconcile

const SAFE_LAUNCHER_STATUSES = new Set(['stopped', 'start_browser_error']);
const SAFE_PENDING = new Set(['start', 'stop', 'connect']);

export function parseArguments(argv) {
  const options = {};
  const valueFlags = ['--data', '--accounts', '--account-ref', '--profile-id', '--token-file', '--launcher-url'];
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--confirm-reconcile') { options.confirmReconcile = true; continue; }
    requireThat(valueFlags.includes(token), `unknown argument ${token}`);
    const value = argv[index + 1];
    requireThat(typeof value === 'string' && !value.startsWith('--'), 'invalid_command_arguments');
    options[token.slice(2)] = value; index += 1;
  }
  return options;
}

export function reconcileProfileMarker({ dataDirectory, accountIdValue, expectedProfileId, launcherStatus,
  inUseBy = '', now = () => new Date(), fs = { existsSync, readFileSync, writeFileSync, copyFileSync, appendFileSync } } = {}) {
  requireThat(/^[a-f0-9]{20}$/.test(accountIdValue || ''), 'account_id_required');
  requireThat(typeof expectedProfileId === 'string' && expectedProfileId.length >= 8, 'profile_id_required');
  requireThat(SAFE_LAUNCHER_STATUSES.has(launcherStatus), `refusing: launcher status ${launcherStatus}`);
  requireThat(!inUseBy, 'refusing: profile is in use');

  const stamp = now().toISOString().replace(/[:.]/g, '-');
  const changes = [];
  const stores = [
    { store: 'account_mapping', path: resolve(dataDirectory, 'accounts', accountIdValue, 'profiles.json') },
    { store: 'root_state', path: resolve(dataDirectory, 'profiles.json') },
  ];
  for (const { store, path } of stores) {
    if (!fs.existsSync(path)) continue;
    const document = JSON.parse(fs.readFileSync(path, 'utf8'));
    const entry = document?.profiles?.[accountIdValue];
    if (!entry) continue;
    requireThat(entry.profileId === expectedProfileId, `refusing: ${store} profileId ${entry.profileId} != expected`);
    if (!entry.pending) continue;
    requireThat(SAFE_PENDING.has(entry.pending), `refusing: pending "${entry.pending}" requires manual reconciliation`);
    const backupPath = `${path}.pre-reconcile-${stamp}`;
    fs.copyFileSync(path, backupPath);
    entry.pending = null;
    entry.reconciledAt = now().toISOString();
    entry.reconciledBy = 'operator';
    fs.writeFileSync(path, `${JSON.stringify(document, null, 2)}\n`, { mode: 0o600 });
    changes.push({ store, backupPath, clearedPending: true });
  }
  if (!changes.length) return { reconciled: false, reason: 'no_pending_marker' };
  const record = { at: now().toISOString(), schema: 'buena.profile-reconciliation/1', accountId: accountIdValue,
    profileId: expectedProfileId, launcherStatus, changes };
  fs.appendFileSync(resolve(dataDirectory, 'reconciliations.ndjson'), `${JSON.stringify(record)}\n`, { mode: 0o600 });
  return { reconciled: true, accountId: accountIdValue, profileId: expectedProfileId, changes };
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArguments(argv);
  requireThat(options.confirmReconcile === true, 'confirm_reconcile_required');
  requireThat(options['account-ref'], 'account_ref_required');
  requireThat(options['profile-id'], 'profile_id_required');
  const dataDirectory = options.data || '/data/account-pilot';
  const index = await loadAccountIndex({ path: options.accounts || '/data/accounts.json' });
  requireThat(index.has(options['account-ref']), 'unknown_account_ref');
  const id = accountId(index.get(options['account-ref']));
  const token = await readPrivate(resolve(options['token-file'] || '/data/automation-token'));
  const api = new Multilogin({ token: token.trim(),
    launcherUrl: options['launcher-url'] || 'https://launcher.mlx.yt:45001' });
  const status = await api.status(options['profile-id']);
  const result = await reconcileProfileMarker({ dataDirectory, accountIdValue: id,
    expectedProfileId: options['profile-id'], launcherStatus: status?.status ?? 'unknown', inUseBy: status?.in_use_by || '' });
  console.log(JSON.stringify({ step: 'reconcile_profile', launcherStatus: status?.status ?? null, ...result }, null, 2));
  return result.reconciled ? 0 : 2;
}

if (!process.argv[1] || process.argv[1] === '-' || process.argv[1].endsWith('reconcile-profile.mjs')) {
  main().then(code => { process.exitCode = code; }).catch(error => {
    console.error(JSON.stringify({ step: 'reconcile_profile', error: String(error?.message || error) }));
    process.exitCode = 1;
  });
}
