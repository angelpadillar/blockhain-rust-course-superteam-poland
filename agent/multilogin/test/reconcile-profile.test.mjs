import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArguments, reconcileProfileMarker } from '../scripts/reconcile-profile.mjs';

const ACCOUNT = 'e287b2b96ad94f91f1fd';
const PROFILE = 'ab12927a-00af-4af1-8a35-1a060392a8fc';

function setup({ pending = 'start' } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'reconcile-profile-'));
  mkdirSync(join(dir, 'accounts', ACCOUNT), { recursive: true });
  const entry = { profileId: PROFILE, platform: 'youtube', pending };
  writeFileSync(join(dir, 'accounts', ACCOUNT, 'profiles.json'),
    `${JSON.stringify({ profiles: { [ACCOUNT]: { ...entry } } }, null, 2)}\n`);
  writeFileSync(join(dir, 'profiles.json'), `${JSON.stringify({ profiles: { [ACCOUNT]: { ...entry } } }, null, 2)}\n`);
  return dir;
}

test('a stopped profile with a stale start marker is reconciled with backups', () => {
  const dir = setup();
  try {
    const result = reconcileProfileMarker({ dataDirectory: dir, accountIdValue: ACCOUNT, expectedProfileId: PROFILE,
      launcherStatus: 'stopped' });
    assert.equal(result.reconciled, true);
    assert.equal(result.changes.length, 2);
    for (const path of [join(dir, 'profiles.json'), join(dir, 'accounts', ACCOUNT, 'profiles.json')]) {
      const document = JSON.parse(readFileSync(path, 'utf8'));
      assert.equal(document.profiles[ACCOUNT].pending, null);
      assert.equal(document.profiles[ACCOUNT].reconciledBy, 'operator');
    }
    const audit = readFileSync(join(dir, 'reconciliations.ndjson'), 'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(audit.length, 1);
    assert.equal(audit[0].profileId, PROFILE);
    for (const change of result.changes) assert.ok(readFileSync(change.backupPath, 'utf8').includes('"pending": "start"'));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('reconciliation refuses a running or in-use profile', () => {
  const dir = setup();
  try {
    assert.throws(() => reconcileProfileMarker({ dataDirectory: dir, accountIdValue: ACCOUNT, expectedProfileId: PROFILE,
      launcherStatus: 'running' }), /refusing: launcher status/);
    assert.throws(() => reconcileProfileMarker({ dataDirectory: dir, accountIdValue: ACCOUNT, expectedProfileId: PROFILE,
      launcherStatus: 'stopped', inUseBy: 'someone@example.test' }), /in use/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('reconciliation refuses a pending create or a mismatched profile', () => {
  const dir = setup({ pending: 'create' });
  try {
    assert.throws(() => reconcileProfileMarker({ dataDirectory: dir, accountIdValue: ACCOUNT, expectedProfileId: PROFILE,
      launcherStatus: 'stopped' }), /manual reconciliation/);
    assert.throws(() => reconcileProfileMarker({ dataDirectory: dir, accountIdValue: ACCOUNT,
      expectedProfileId: 'different-profile', launcherStatus: 'start_browser_error' }), /!= expected/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('arguments require explicit confirmation', () => {
  assert.equal(parseArguments(['--account-ref', 'x', '--profile-id', 'y']).confirmReconcile, undefined);
  assert.equal(parseArguments(['--account-ref', 'x', '--profile-id', 'y', '--confirm-reconcile']).confirmReconcile, true);
});
