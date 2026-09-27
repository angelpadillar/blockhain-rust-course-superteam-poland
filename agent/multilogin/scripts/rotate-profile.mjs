import { existsSync, readFileSync, renameSync, appendFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { requireThat } from '../src/core.mjs';
import { loadAccountIndex } from '../src/accounts.mjs';
import { accountId } from '../src/core.mjs';

// Operator-approved browser rotation for one existing account.
//
// A failed login is normally retried on the SAME profile: the mapping is never
// deleted as a retry trick. A clean install is a different operation: the
// operator explicitly rotates the browser (fresh cookies/device) while the old
// profile and its audit trail stay intact.
//
// What it does:
//   1. resolves --account-ref against the private account store (no secret is
//      read into output or printed);
//   2. archives <data>/accounts/<accountId>/profiles.json to
//      profiles.json.pre-rotate-<utc> (atomic rename, never deleted);
//   3. appends a rotation record to <data>/rotations.ndjson.
//
// It never calls Multilogin. The next job run for a NEW profileRef creates a
// fresh profile (and, with proxyMode=multilogin, a new proxy).
//
// Usage:
//   node scripts/rotate-profile.mjs --data /data/account-pilot --accounts /data/accounts.json \
//     --account-ref yt-live-04 --confirm-rotate --reason "clean install: new profile/IP/cookies"

export function parseArguments(argv) {
  const options = { positional: [] };
  const valueFlags = ['--data', '--accounts', '--account-ref', '--reason'];
  for (let index = 0; index < argv.length; index++) {
    const token = argv[index];
    if (token === '--confirm-rotate') options.confirmRotate = true;
    else if (valueFlags.includes(token)) {
      const value = argv[index + 1];
      requireThat(typeof value === 'string' && !value.startsWith('--'), 'invalid_command_arguments');
      options[token.slice(2)] = value; index += 1;
    } else if (token.startsWith('--')) throw new Error(`unknown argument ${token}`);
    else options.positional.push(token);
  }
  return options;
}

export function rotateProfile({ dataDirectory, accountIdValue, now = () => new Date(), reason = null, fs = { existsSync, readFileSync, renameSync, appendFileSync, writeFileSync } } = {}) {
  requireThat(typeof dataDirectory === 'string' && dataDirectory, 'data_directory_required');
  requireThat(/^[a-f0-9]{20}$/.test(accountIdValue || ''), 'account_id_required');
  const stamp = now().toISOString().replace(/[:.]/g, '-');
  const steps = [];

  // 1. The account-child mapping used by the batch resolver.
  const mappingPath = resolve(dataDirectory, 'accounts', accountIdValue, 'profiles.json');
  let oldProfileId = null;
  if (fs.existsSync(mappingPath)) {
    let mapping = null;
    try { mapping = JSON.parse(fs.readFileSync(mappingPath, 'utf8')); } catch { throw new Error('invalid_profile_mapping'); }
    oldProfileId = mapping?.profiles?.[accountIdValue]?.profileId ?? null;
    if (oldProfileId || Object.keys(mapping?.profiles ?? {}).length) {
      const backupPath = `${mappingPath}.pre-rotate-${stamp}`;
      fs.renameSync(mappingPath, backupPath);
      steps.push({ store: 'account_mapping', backupPath, oldProfileId });
    }
  }

  // 2. The root state registry (`<data>/profiles.json`) is the sequential-flow
  //    authority and is consulted during resolution; the old account entry must
  //    be removed there too or the old profile is reused.
  const rootPath = resolve(dataDirectory, 'profiles.json');
  if (fs.existsSync(rootPath)) {
    let root = null;
    try { root = JSON.parse(fs.readFileSync(rootPath, 'utf8')); } catch { root = null; }
    if (root?.profiles?.[accountIdValue]) {
      oldProfileId = oldProfileId ?? root.profiles[accountIdValue]?.profileId ?? null;
      const backupPath = `${rootPath}.pre-rotate-${stamp}`;
      const copy = structuredClone(root);
      delete copy.profiles[accountIdValue];
      fs.renameSync(rootPath, backupPath);
      fs.writeFileSync(rootPath, `${JSON.stringify(copy, null, 2)}\n`, { mode: 0o600 });
      steps.push({ store: 'root_state', backupPath, removedProfileId: root.profiles[accountIdValue]?.profileId ?? null });
    }
  }

  // 3. The profile-ref registry: release any ref still bound to the old profile.
  const refsPath = resolve(dataDirectory, 'profile-refs.json');
  if (fs.existsSync(refsPath)) {
    const refs = JSON.parse(fs.readFileSync(refsPath, 'utf8'));
    const released = [];
    for (const [ref, entry] of Object.entries(refs.refs ?? {})) {
      if (entry?.accountId === accountIdValue && entry?.profileId) {
        released.push({ ref, oldProfileId: entry.profileId });
        entry.profileId = null;
        entry.state = 'rotated';
        entry.rotatedAt = now().toISOString();
      }
    }
    if (released.length) {
      const backupPath = `${refsPath}.pre-rotate-${stamp}`;
      fs.renameSync(refsPath, backupPath);
      fs.writeFileSync(refsPath, `${JSON.stringify(refs, null, 2)}\n`, { mode: 0o600 });
      steps.push({ store: 'profile_refs', backupPath, released });
    }
  }

  if (!steps.length) return { rotated: false, reason: 'nothing_to_rotate' };
  const record = { at: now().toISOString(), schema: 'buena.profile-rotation/1', accountId: accountIdValue,
    oldProfileId, reason, steps,
    nextStep: 'run the fresh job with a new profileRef; the old profile is preserved in Multilogin' };
  fs.appendFileSync(resolve(dataDirectory, 'rotations.ndjson'), `${JSON.stringify(record)}\n`, { mode: 0o600 });
  return { rotated: true, accountId: accountIdValue, oldProfileId, steps };
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArguments(argv);
  requireThat(options.confirmRotate === true, 'confirm_rotate_required');
  requireThat(options['account-ref'], 'account_ref_required');
  const dataDirectory = options.data || '/data/account-pilot';
  const accountsPath = options.accounts || '/data/accounts.json';
  const index = await loadAccountIndex({ path: accountsPath });
  requireThat(index.has(options['account-ref']), 'unknown_account_ref');
  const account = index.get(options['account-ref']);
  const id = accountId(account);
  const result = rotateProfile({ dataDirectory, accountIdValue: id, reason: options.reason || 'operator_rotation' });
  // No credentials, handles or proxy data are ever printed.
  console.log(JSON.stringify({ step: 'rotate_profile', ...result }, null, 2));
  return result.rotated ? 0 : 2;
}

if (!process.argv[1] || process.argv[1] === '-' || process.argv[1].endsWith('rotate-profile.mjs')) {
  main().then(code => { process.exitCode = code; }).catch(error => {
    console.error(JSON.stringify({ step: 'rotate_profile', error: String(error?.message || error) }));
    process.exitCode = 1;
  });
}
