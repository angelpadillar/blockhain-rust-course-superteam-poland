import { createHash } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { requireThat } from './core.mjs';
import { readJson, writeJson } from './storage.mjs';
import { acquireNamedLock } from './profile-lock.mjs';

// Canonical profile-health record. It is derived from the job evidence the
// kernel already writes (job.json, lifecycle.json, human-checkpoint.json) and
// kept in one compact store so the operator sees one truth in the runtime, in
// the CLI and on the Multilogin profile name.
export const healthStatuses = ['GOOD_AUTHENTICATED', 'GOOD_PERSISTED', 'WAITING_FOR_HUMAN',
  'BAD_LOGIN', 'BAD_PROXY', 'CANCELLED', 'UNKNOWN'];
export const healthBadge = { GOOD_AUTHENTICATED: 'GOOD', GOOD_PERSISTED: 'GOOD',
  WAITING_FOR_HUMAN: 'HUMAN', BAD_LOGIN: 'BAD', BAD_PROXY: 'BAD', CANCELLED: 'BAD', UNKNOWN: 'UNKNOWN' };
export const healthDetail = { GOOD_PERSISTED: 'Studio verified', GOOD_AUTHENTICATED: 'identity verified',
  WAITING_FOR_HUMAN: 'security verification', BAD_LOGIN: 'login incomplete',
  BAD_PROXY: 'proxy unavailable', CANCELLED: 'cancelled / login incomplete', UNKNOWN: 'not yet verified' };

const proxyFailurePattern = /proxy|transport|tunnel|dns|connection|multilogin_http_4\d\d|multilogin_http_5\d\d|browser_attachment|invalid_browser_port|validate_proxy/;

export function healthStatusFromResult(result = {}, jobDocument = null) {
  if (result.status === 'completed') {
    const verification = result.verification || {};
    const studio = verification.studio === true || jobDocument?.channel?.authenticated === true;
    const persisted = verification.reopen === true || jobDocument?.login?.reopenVerified === true;
    return studio && persisted ? 'GOOD_PERSISTED' : 'GOOD_AUTHENTICATED';
  }
  if (result.status === 'waiting_for_human') return 'WAITING_FOR_HUMAN';
  if (result.status === 'cancelled') return 'CANCELLED';
  const reason = result.reason || jobDocument?.reason || '';
  return proxyFailurePattern.test(reason) ? 'BAD_PROXY' : 'BAD_LOGIN';
}

export function recordFromResult({ result = {}, job = {}, jobDocument = null, checkpoint = null,
  now = Date.now } = {}) {
  const status = healthStatusFromResult(result, jobDocument);
  const verification = result.verification || {};
  // `null` means "not observed in this run"; the merge keeps the previous proven
  // value instead of turning an infrastructure failure into a lost session. Only
  // a completed run may attest Studio/restart persistence at all.
  const observed = value => (value === true ? true : value === false ? false : null);
  const completed = result.status === 'completed';
  const studioRaw = completed ? (verification.studio ?? jobDocument?.channel?.authenticated ?? null) : null;
  const reopenRaw = completed ? (verification.reopen ?? jobDocument?.login?.reopenVerified ?? null) : null;
  return {
    profileId: result.profileId ?? jobDocument?.profileId ?? null,
    accountRef: job.accountRef ?? jobDocument?.accountRef ?? null,
    platform: job.platform ?? jobDocument?.platform ?? null,
    profileRef: job.profileRef ?? jobDocument?.profileRef ?? null,
    status,
    badge: healthBadge[status],
    label: null,
    lastRunStatus: status,
    observedAt: result.finishedAt || jobDocument?.finishedAt || new Date(now()).toISOString(),
    lastVerifiedAt: status.startsWith('GOOD') ? (result.finishedAt || new Date(now()).toISOString())
      : null,
    studioVerified: observed(studioRaw),
    restartPersistenceVerified: observed(reopenRaw),
    proxyStatus: result.proxy?.reuseExistingProxy === true ? (result.proxy?.verifiedAttached ? 'reuse_verified' : 'reuse_unproven')
      : (result.proxy?.rotations ? `rotated:${result.proxy.rotations}` : 'attached'),
    humanCheckpoint: checkpoint ? { id: checkpoint.id ?? null, state: checkpoint.state ?? null,
      reason: checkpoint.reason ?? null, expiresAt: checkpoint.expiresAt ?? null } : null,
    lastFailureReason: status.startsWith('GOOD') ? null : (result.reason || jobDocument?.reason || null),
    lastJobId: result.jobId ?? jobDocument?.jobId ?? null,
    updatedAt: new Date(now()).toISOString(),
  };
}

export async function loadHealthStore({ directory } = {}) {
  requireThat(directory, 'health_directory_required');
  const store = await readJson(resolve(directory, 'health.json'), null).catch(() => null);
  if (!store || store.version !== 1 || typeof store.profiles !== 'object') {
    return { version: 1, updatedAt: null, profiles: {} };
  }
  return store;
}

// One merge policy, shared by the live write path and the report replay: an
// infrastructure failure never downgrades a proven session, and an unobserved
// verification flag never erases the previous proof.
export function mergeHealthRecord(previous = {}, record = {}, now = Date.now) {
  const merged = { ...previous, ...record, updatedAt: new Date(now()).toISOString() };
  if (record.status === 'BAD_PROXY' && String(previous.status || '').startsWith('GOOD')) {
    merged.status = previous.status;
    merged.badge = healthBadge[previous.status];
    merged.lastVerifiedAt = previous.lastVerifiedAt ?? null;
    merged.lastFailureReason = record.lastFailureReason ?? previous.lastFailureReason ?? null;
  }
  if (record.studioVerified === null) merged.studioVerified = previous.studioVerified ?? null;
  if (record.restartPersistenceVerified === null) {
    merged.restartPersistenceVerified = previous.restartPersistenceVerified ?? null;
  }
  return merged;
}

export async function writeHealthRecord({ directory, record, previous = null, now = Date.now } = {}) {
  requireThat(record?.accountRef, 'health_record_requires_account');
  requireThat(healthStatuses.includes(record.status), 'unknown_health_status');
  const release = await acquireNamedLock(directory, 'health');
  try {
    const store = await loadHealthStore({ directory });
    const key = record.profileId || record.profileRef || record.accountRef;
    // When the store has no entry yet, the replayed job evidence is the prior
    // context, so a proxy outage cannot erase a session proven by earlier runs.
    const base = store.profiles[key] || previous || {};
    store.profiles[key] = mergeHealthRecord(base, record, now);
    store.updatedAt = new Date(now()).toISOString();
    await writeJson(resolve(directory, 'health.json'), store);
    return store.profiles[key];
  } finally { await release(); }
}

// The operator-facing label, e.g. "YT-01 | GOOD | Studio verified".
export function labelForHealth({ record = {} } = {}) {
  const suffix = /(\d+)\s*$/.exec(String(record.accountRef || record.profileRef || ''))?.[1];
  const id = suffix ? `YT-${suffix.padStart(2, '0')}`
    : String(record.accountRef || record.profileRef || 'profile').toUpperCase().slice(0, 24);
  const status = healthStatuses.includes(record.status) ? record.status : 'UNKNOWN';
  return `${id} | ${healthBadge[status]} | ${healthDetail[status]}`;
}

function digest(value) { return createHash('sha256').update(JSON.stringify(value ?? null)).digest('hex'); }

// Read-only report over the job evidence plus the registry and the health store.
export async function buildHealthReport({ directory, platform = null, jobs = null } = {}) {
  requireThat(directory, 'health_directory_required');
  const store = await loadHealthStore({ directory });
  const registry = await readJson(resolve(directory, 'profile-refs.json'), { version: 1, refs: {} })
    .catch(() => ({ version: 1, refs: {} }));
  const records = new Map();
  for (const [profileRef, entry] of Object.entries(registry.refs || {})) {
    records.set(entry.profileId || profileRef, { profileId: entry.profileId || null, profileRef,
      accountRef: null, platform: entry.platform, status: 'UNKNOWN', badge: 'UNKNOWN',
      label: null, lastVerifiedAt: null, studioVerified: null, restartPersistenceVerified: null,
      proxyStatus: 'unknown', humanCheckpoint: null, lastFailureReason: null, lastJobId: entry.lastJobId ?? null });
  }
  const jobIds = jobs ? jobs.map(job => job.id) : await readdir(resolve(directory, 'jobs')).catch(() => []);
  const stampOf = value => { const stamp = Date.parse(value || ''); return Number.isFinite(stamp) ? stamp : 0; };
  // Replay every job's evidence per profile in time order through the same merge
  // policy the live writer uses, so the report and the store cannot disagree.
  const replayed = new Map();
  const allRecords = [];
  for (const jobId of jobIds) {
    const jobDirectory = resolve(directory, 'jobs', jobId);
    const document = await readJson(resolve(jobDirectory, 'job.json'), null).catch(() => null);
    if (!document) continue;
    const checkpoint = await readJson(resolve(jobDirectory, 'human-checkpoint.json'), null).catch(() => null);
    const result = await readJson(resolve(jobDirectory, 'result.json'), null).catch(() => null);
    allRecords.push(recordFromResult({ result: result || { status: mapLegacyState(document.state),
      reason: document.reason, profileId: document.profileId, jobId: jobId, finishedAt: document.finishedAt,
      verification: { studio: document.channel?.authenticated ?? null, reopen: document.login?.reopenVerified ?? null } },
      job: { id: jobId, platform: document.platform, accountRef: document.accountRef, profileRef: document.profileRef },
      jobDocument: document, checkpoint }));
  }
  allRecords.sort((left, right) => stampOf(left.observedAt) - stampOf(right.observedAt));
  for (const record of allRecords) {
    const key = record.profileId || record.profileRef || record.accountRef;
    replayed.set(key, mergeHealthRecord(replayed.get(key) || {}, record));
  }
  for (const [key, record] of replayed) records.set(key, { ...(records.get(key) || {}), ...record });
  for (const [key, rawStored] of Object.entries(store.profiles || {})) {
    const stored = normalizeLegacyHealthRecord(rawStored);
    // A record written before observedAt existed cannot be ordered, and the job
    // replay is then the authoritative source; post-fix records compare normally.
    if (!stored.observedAt) continue;
    const previous = records.get(key) || {};
    if (stampOf(stored.observedAt) >= stampOf(previous.observedAt)) {
      records.set(key, mergeHealthRecord(previous, stored));
    }
  }
  const list = [...records.values()]
    .filter(record => !platform || record.platform === platform)
    .map(record => ({ ...record, label: labelForHealth({ record }) }))
    .sort((left, right) => String(left.accountRef || left.profileRef).localeCompare(String(right.accountRef || right.profileRef)));
  return { updatedAt: new Date().toISOString(), counts: {
    GOOD: list.filter(record => record.badge === 'GOOD').length,
    HUMAN: list.filter(record => record.badge === 'HUMAN').length,
    BAD: list.filter(record => record.badge === 'BAD').length,
    UNKNOWN: list.filter(record => record.badge === 'UNKNOWN').length,
  }, profiles: list };
}

function mapLegacyState(state) {
  if (state === 'success') return 'completed';
  if (state === 'failed') return 'failed';
  if (state === 'cancelled') return 'cancelled';
  if (state === 'waiting_for_human') return 'waiting_for_human';
  return 'unknown';
}

// One-time read normalization for records written before `lastRunStatus`
// existed: such a record cannot tell "not observed" from "observed false", and
// a BAD_PROXY run never observed identity/Studio/persistence at all.
export function normalizeLegacyHealthRecord(record) {
  if (!record || record.lastRunStatus !== undefined) return record;
  const normalized = { ...record, lastRunStatus: record.status };
  if (record.status === 'BAD_PROXY') {
    normalized.studioVerified = null;
    normalized.restartPersistenceVerified = null;
  }
  return normalized;
}

export function formatHealthTable(report) {
  const rows = [['PROFILE', 'ACCOUNT', 'STATUS', 'BADGE', 'STUDIO', 'PERSIST', 'PROXY', 'LAST JOB', 'NOTE']];
  for (const record of report.profiles) {
    rows.push([record.label.split(' | ')[0], record.accountRef || record.profileRef || '-', record.status,
      record.badge, record.studioVerified === null ? '-' : record.studioVerified ? 'yes' : 'no',
      record.restartPersistenceVerified === null ? '-' : record.restartPersistenceVerified ? 'yes' : 'no',
      record.proxyStatus || 'unknown', record.lastJobId || '-',
      record.status.startsWith('GOOD') && record.lastFailureReason ? record.lastFailureReason : '']);
  }
  const widths = rows[0].map((_, column) => Math.max(...rows.map(row => String(row[column] ?? '').length)));
  const lines = rows.map(row => row.map((cell, column) => String(cell ?? '').padEnd(widths[column])).join('  ').trimEnd());
  lines.push(`GOOD: ${report.counts.GOOD} | HUMAN: ${report.counts.HUMAN} | BAD: ${report.counts.BAD} | UNKNOWN: ${report.counts.UNKNOWN}`);
  return lines.join('\n');
}

export { digest as healthDigest };
