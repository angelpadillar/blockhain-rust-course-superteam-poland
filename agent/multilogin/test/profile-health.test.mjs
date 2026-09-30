import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { healthStatusFromResult, recordFromResult, labelForHealth, writeHealthRecord,
  buildHealthReport, formatHealthTable, loadHealthStore, normalizeLegacyHealthRecord } from '../src/profile-health.mjs';

const scratch = async t => {
  const directory = await mkdtemp(join(tmpdir(), 'profile-health-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
};

test('job outcomes map to the canonical health statuses', () => {
  assert.equal(healthStatusFromResult({ status: 'completed',
    verification: { studio: true, reopen: true } }), 'GOOD_PERSISTED');
  assert.equal(healthStatusFromResult({ status: 'completed',
    verification: { studio: true, reopen: false } }), 'GOOD_AUTHENTICATED');
  assert.equal(healthStatusFromResult({ status: 'waiting_for_human' }), 'WAITING_FOR_HUMAN');
  assert.equal(healthStatusFromResult({ status: 'cancelled' }), 'CANCELLED');
  assert.equal(healthStatusFromResult({ status: 'failed', reason: 'proxy_connection_failed' }), 'BAD_PROXY');
  assert.equal(healthStatusFromResult({ status: 'failed', reason: 'multilogin_http_403' }), 'BAD_PROXY');
  assert.equal(healthStatusFromResult({ status: 'failed', reason: 'invalid_credentials' }), 'BAD_LOGIN');
  assert.equal(healthStatusFromResult({ status: 'failed', reason: 'human_checkpoint_timeout',
    verification: {} }, { reason: 'human_checkpoint_timeout',
    stateTransitions: [{ state: 'waiting_for_human' }] }), 'BAD_LOGIN');
});

test('the label is the operator-facing NN | BADGE | detail string', () => {
  assert.equal(labelForHealth({ record: { accountRef: 'yt-live-01', status: 'GOOD_PERSISTED' } }),
    'YT-01 | GOOD | Studio verified');
  assert.equal(labelForHealth({ record: { accountRef: 'ol-03', status: 'GOOD_AUTHENTICATED' } }),
    'OL-03 | GOOD | identity verified');
  assert.equal(labelForHealth({ record: { accountRef: 'yt-live-04', status: 'WAITING_FOR_HUMAN' } }),
    'YT-04 | HUMAN | security verification');
  assert.equal(labelForHealth({ record: { accountRef: 'yt-live-05', status: 'CANCELLED' } }),
    'YT-05 | BAD | cancelled / login incomplete');
  assert.equal(labelForHealth({ record: { accountRef: 'other', status: 'BAD_PROXY' } }),
    'OTHER | BAD | proxy unavailable');
  assert.equal(labelForHealth({ record: { accountRef: 'x', status: 'nonsense' } }),
    'X | UNKNOWN | not yet verified');
});

test('a record keeps verification, proxy and failure details without credentials', () => {
  const record = recordFromResult({ result: { status: 'failed', reason: 'proxy_connection_failed',
    profileId: '9888f708-e12a-4af4-a6fc-9bda24aaa4c9', jobId: 'youtube-live-04', finishedAt: 'x',
    proxy: { reuseExistingProxy: true, verifiedAttached: true, rotations: 0 },
    verification: { studio: null, reopen: null } },
    job: { accountRef: 'yt-live-04', platform: 'youtube', profileRef: 'yt-live-profile-04' },
    jobDocument: { login: { reopenVerified: false } } });
  assert.equal(record.status, 'BAD_PROXY');
  assert.equal(record.proxyStatus, 'reuse_verified');
  assert.equal(record.lastFailureReason, 'proxy_connection_failed');
  assert.equal(record.lastJobId, 'youtube-live-04');
  assert.equal(JSON.stringify(record).includes('password'), false);
});

test('an infrastructure failure never downgrades a proven session', async t => {
  const directory = await scratch(t);
  await writeHealthRecord({ directory, record: { accountRef: 'yt-live-01', profileId: 'p1',
    profileRef: 'yt-live-profile-01', platform: 'youtube', status: 'GOOD_PERSISTED',
    lastRunStatus: 'GOOD_PERSISTED', studioVerified: true, restartPersistenceVerified: true,
    lastVerifiedAt: '2026-09-22T14:12:36.956Z', observedAt: '2026-09-22T14:12:36.956Z' } });
  const merged = await writeHealthRecord({ directory, record: { accountRef: 'yt-live-01', profileId: 'p1',
    profileRef: 'yt-live-profile-01', platform: 'youtube', status: 'BAD_PROXY',
    lastRunStatus: 'BAD_PROXY', lastFailureReason: 'proxy_connection_failed',
    proxyStatus: 'reuse_verified', studioVerified: null, restartPersistenceVerified: null,
    observedAt: '2026-09-25T09:34:25.028Z', lastJobId: 'youtube-live-01-reuse-proof' } });
  assert.equal(merged.status, 'GOOD_PERSISTED', 'the proven session survives a proxy outage');
  assert.equal(merged.studioVerified, true);
  assert.equal(merged.restartPersistenceVerified, true);
  assert.equal(merged.lastFailureReason, 'proxy_connection_failed');
  assert.equal(merged.proxyStatus, 'reuse_verified');
  assert.equal(merged.lastJobId, 'youtube-live-01-reuse-proof');
  assert.equal(merged.lastRunStatus, 'BAD_PROXY');
});

test('a failed run inherits prior evidence when the store has no record yet', async t => {
  const directory = await scratch(t);
  const merged = await writeHealthRecord({ directory,
    record: { accountRef: 'yt-live-01', profileId: 'p1', profileRef: 'yt-live-profile-01',
      platform: 'youtube', status: 'BAD_PROXY', lastRunStatus: 'BAD_PROXY',
      lastFailureReason: 'proxy_connection_failed', studioVerified: null,
      restartPersistenceVerified: null, observedAt: '2026-09-25T10:14:47.215Z' },
    previous: { accountRef: 'yt-live-01', profileId: 'p1', profileRef: 'yt-live-profile-01',
      platform: 'youtube', status: 'GOOD_PERSISTED', studioVerified: true,
      restartPersistenceVerified: true, lastVerifiedAt: '2026-09-22T21:40:19.660Z',
      observedAt: '2026-09-22T21:40:19.660Z' } });
  assert.equal(merged.status, 'GOOD_PERSISTED');
  assert.equal(merged.studioVerified, true);
});

test('legacy records cannot fake an observed verification', () => {
  const legacy = normalizeLegacyHealthRecord({ status: 'BAD_PROXY', studioVerified: false,
    restartPersistenceVerified: false, observedAt: '2026-09-25T09:34:25.028Z' });
  assert.equal(legacy.studioVerified, null);
  assert.equal(legacy.restartPersistenceVerified, null);
  assert.equal(legacy.lastRunStatus, 'BAD_PROXY');
  const current = { status: 'BAD_PROXY', studioVerified: false, lastRunStatus: 'BAD_PROXY' };
  assert.equal(normalizeLegacyHealthRecord(current), current, 'post-fix records are untouched');
});

test('the store merges records under one lock and the report reads job evidence', async t => {
  const directory = await scratch(t);
  await writeJson(join(directory, 'profile-refs.json'), { version: 1, refs: {
    'yt-live-profile-01': { profileId: 'profile-0001', accountId: 'a1', platform: 'youtube',
      lastJobId: 'youtube-live-01', state: 'success' },
    'yt-live-profile-02': { profileId: 'profile-0002', accountId: 'a2', platform: 'youtube',
      lastJobId: null, state: null },
    'yt-live-profile-04': { profileId: 'profile-0004', accountId: 'a4', platform: 'youtube',
      lastJobId: 'youtube-live-04', state: 'waiting_for_human' } } });
  await mkdir(join(directory, 'jobs', 'youtube-live-01'), { recursive: true });
  await writeJson(join(directory, 'jobs', 'youtube-live-01', 'job.json'), { jobId: 'youtube-live-01',
    accountRef: 'yt-live-01', profileRef: 'yt-live-profile-01', profileId: 'profile-0001',
    platform: 'youtube', state: 'success', finishedAt: '2026-09-22T14:12:36.956Z',
    login: { verified: true, reopenVerified: true }, channel: { authenticated: true } });
  await mkdir(join(directory, 'jobs', 'youtube-live-04'), { recursive: true });
  await writeJson(join(directory, 'jobs', 'youtube-live-04', 'job.json'), { jobId: 'youtube-live-04',
    accountRef: 'yt-live-04', profileRef: 'yt-live-profile-04', profileId: 'profile-0004',
    platform: 'youtube', state: 'waiting_for_human', reason: 'human_checkpoint_timeout' });
  await mkdir(join(directory, 'jobs', 'youtube-live-03'), { recursive: true });
  await writeJson(join(directory, 'jobs', 'youtube-live-03', 'job.json'), { jobId: 'youtube-live-03',
    accountRef: 'yt-live-03', profileRef: 'yt-live-profile-03', profileId: 'profile-0003',
    platform: 'instagram', state: 'failed', reason: 'invalid_credentials' });

  await writeHealthRecord({ directory, record: { accountRef: 'yt-live-01', status: 'GOOD_PERSISTED',
    profileId: 'profile-0001', profileRef: 'yt-live-profile-01', platform: 'youtube', studioVerified: true,
    restartPersistenceVerified: true, lastVerifiedAt: '2026-09-22T14:12:36.956Z' } });
  await writeHealthRecord({ directory, record: { accountRef: 'yt-live-04', status: 'WAITING_FOR_HUMAN',
    profileId: 'profile-0004', profileRef: 'yt-live-profile-04', platform: 'youtube' } });
  const store = await loadHealthStore({ directory });
  assert.equal(Object.keys(store.profiles).length, 2);

  const report = await buildHealthReport({ directory, platform: 'youtube' });
  assert.equal(report.profiles.length, 3, 'registry entries without job evidence stay UNKNOWN');
  const byAccount = Object.fromEntries(report.profiles.map(record => [record.accountRef || record.profileRef, record]));
  assert.equal(byAccount['yt-live-01'].status, 'GOOD_PERSISTED');
  assert.equal(byAccount['yt-live-01'].label, 'YT-01 | GOOD | Studio verified');
  assert.equal(byAccount['yt-live-04'].status, 'WAITING_FOR_HUMAN');
  assert.equal(byAccount['yt-live-profile-02'].status, 'UNKNOWN');
  assert.equal(report.counts.GOOD, 1);
  assert.equal(report.counts.HUMAN, 1);
  assert.equal(report.counts.UNKNOWN, 1);
  const table = formatHealthTable(report);
  assert.match(table, /YT-01\s+yt-live-01\s+GOOD_PERSISTED/);
  assert.match(table, /YT-04\s+yt-live-04\s+WAITING_FOR_HUMAN/);
  assert.match(table, /GOOD: 1 \| HUMAN: 1 \| BAD: 0 \| UNKNOWN: 1/);
});

async function writeJson(path, value) {
  const { writeJson: write } = await import('../src/storage.mjs');
  await write(path, value);
}
