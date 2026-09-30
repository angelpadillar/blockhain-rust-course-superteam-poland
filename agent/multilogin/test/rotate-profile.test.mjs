import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArguments, rotateProfile } from '../scripts/rotate-profile.mjs';

const ACCOUNT = 'e287b2b96ad94f91f1fd';
const OLD_PROFILE = 'old-profile-id';

function setup({ child = true, root = true, refs = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'rotate-profile-'));
  if (child) {
    mkdirSync(join(dir, 'accounts', ACCOUNT), { recursive: true });
    writeFileSync(join(dir, 'accounts', ACCOUNT, 'profiles.json'),
      `${JSON.stringify({ profiles: { [ACCOUNT]: { profileId: OLD_PROFILE, state: 'cancelled' } } }, null, 2)}\n`);
  }
  if (root) {
    writeFileSync(join(dir, 'profiles.json'), `${JSON.stringify({ version: 1, profiles: {
      [ACCOUNT]: { profileId: OLD_PROFILE, platform: 'youtube' },
      other: { profileId: 'keep-me', platform: 'youtube' },
    } }, null, 2)}\n`);
  }
  if (refs) {
    writeFileSync(join(dir, 'profile-refs.json'), `${JSON.stringify({ refs: {
      'yt-live-profile-04-fresh': { accountId: ACCOUNT, profileId: OLD_PROFILE, state: 'failed' },
      'other-profile': { accountId: 'other', profileId: 'keep-me', state: 'active' },
    } }, null, 2)}\n`);
  }
  return dir;
}

test('rotation clears the account from every store and keeps backups', () => {
  const dir = setup();
  try {
    const result = rotateProfile({ dataDirectory: dir, accountIdValue: ACCOUNT, reason: 'clean install' });
    assert.equal(result.rotated, true);
    assert.equal(result.oldProfileId, OLD_PROFILE);
    assert.equal(result.steps.length, 3);
    assert.equal(existsSync(join(dir, 'accounts', ACCOUNT, 'profiles.json')), false);
    const root = JSON.parse(readFileSync(join(dir, 'profiles.json'), 'utf8'));
    assert.equal(root.profiles[ACCOUNT], undefined);
    assert.equal(root.profiles.other.profileId, 'keep-me');
    const refs = JSON.parse(readFileSync(join(dir, 'profile-refs.json'), 'utf8'));
    assert.equal(refs.refs['yt-live-profile-04-fresh'].profileId, null);
    assert.equal(refs.refs['yt-live-profile-04-fresh'].state, 'rotated');
    assert.equal(refs.refs['other-profile'].profileId, 'keep-me');
    const rotations = readFileSync(join(dir, 'rotations.ndjson'), 'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(rotations.length, 1);
    assert.equal(rotations[0].oldProfileId, OLD_PROFILE);
    assert.equal(rotations[0].steps.length, 3);
    for (const step of result.steps) assert.equal(existsSync(step.backupPath), true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('rotation is a no-op when no store has a mapping', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rotate-profile-empty-'));
  try {
    const result = rotateProfile({ dataDirectory: dir, accountIdValue: ACCOUNT });
    assert.equal(result.rotated, false);
    assert.equal(result.reason, 'nothing_to_rotate');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('the root state alone is enough to force a new profile', () => {
  const dir = setup({ child: false, refs: false });
  try {
    const result = rotateProfile({ dataDirectory: dir, accountIdValue: ACCOUNT });
    assert.equal(result.rotated, true);
    const root = JSON.parse(readFileSync(join(dir, 'profiles.json'), 'utf8'));
    assert.equal(root.profiles[ACCOUNT], undefined);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('the command requires explicit confirmation and an account ref', () => {
  const unconfirmed = parseArguments(['--account-ref', 'yt-live-04']);
  assert.equal(unconfirmed.confirmRotate, undefined);
  assert.equal(unconfirmed['account-ref'], 'yt-live-04');
  const confirmed = parseArguments(['--account-ref', 'yt-live-04', '--confirm-rotate', '--reason', 'x']);
  assert.equal(confirmed.confirmRotate, true);
  assert.equal(confirmed.reason, 'x');
  assert.throws(() => parseArguments(['--unknown']), /unknown argument/);
});
