import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { mkdir, appendFile } from 'node:fs/promises';
import { PilotError, requireThat, errorCode, createRedactor } from './core.mjs';
import { readJson, writeJson } from './storage.mjs';
import { runBatch, validateConfig, connect as defaultConnect, seedSites } from './runner.mjs';
import { runConcurrentBatch } from './batch.mjs';
import { runLogin, sites, classifyPage } from './login.mjs';
import { acquireNamedLock } from './profile-lock.mjs';
import { createReceiptStore } from './receipts.mjs';
import { MultiloginSessionProvider } from './session-provider.mjs';
import { captureSafeScreenshot } from './screenshots.mjs';
import { inspectStudio, observeStudio } from './youtube.mjs';
import { selectJobAccounts, refPattern } from './accounts.mjs';

// Thin job-centric layer over the existing account worker: every job owns one
// Multilogin profile, one browser session, one log directory and one lifecycle.
export const jobStates = ['queued', 'starting_profile', 'browser_ready', 'running', 'waiting_for_human',
  'success', 'failed', 'cancelled'];
export const humanCheckpointReasons = ['human_verification_required', 'email_or_sms_verification_required',
  'device_verification_required', 'account_setup_requires_attention'];
const jobIdPattern = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;

export function validateJobs(input) {
  const jobs = Array.isArray(input) ? input : input?.jobs;
  requireThat(Array.isArray(jobs) && jobs.length > 0, 'invalid_jobs_file');
  requireThat(jobs.length <= 6, 'too_many_jobs');
  const ids = new Set(); const profileRefs = new Set(); const accountRefs = new Set();
  return jobs.map(raw => {
    requireThat(raw && typeof raw === 'object', 'invalid_job');
    const job = { id: raw.id, platform: raw.platform, accountRef: raw.accountRef, profileRef: raw.profileRef };
    requireThat(typeof job.id === 'string' && jobIdPattern.test(job.id), 'invalid_job_id');
    requireThat(['instagram', 'youtube'].includes(job.platform), 'unsupported_platform');
    requireThat(typeof job.accountRef === 'string' && refPattern.test(job.accountRef), 'invalid_account_ref');
    requireThat(typeof job.profileRef === 'string' && refPattern.test(job.profileRef), 'invalid_profile_ref');
    requireThat(!ids.has(job.id), 'duplicate_job_id'); ids.add(job.id);
    requireThat(!profileRefs.has(job.profileRef), 'duplicate_profile_ref'); profileRefs.add(job.profileRef);
    requireThat(!accountRefs.has(job.accountRef), 'duplicate_account_ref'); accountRefs.add(job.accountRef);
    return job;
  });
}

export function jobStateForResult({ status = '', reason = null } = {}) {
  if (status.startsWith('completed')) return 'success';
  if (reason === 'cancelled' || reason === 'cancelled_before_start') return 'cancelled';
  if (reason === 'human_checkpoint_timeout' || humanCheckpointReasons.includes(reason)) return 'waiting_for_human';
  return 'failed';
}

export class CancelToken {
  constructor() { this.aborted = false; this.reason = null; }
  abort(reason = 'cancelled_by_operator') { this.aborted = true; this.reason ||= reason; }
  async throwIfCancelled(jobDirectory) {
    if (this.aborted) throw new PilotError('cancelled');
    if (!jobDirectory) return;
    const control = await readJson(resolve(jobDirectory, 'control.json'), null).catch(() => null);
    if (control?.action === 'cancel') throw new PilotError('cancelled');
  }
}

// Waits for a person to finish a security checkpoint in the live browser. It
// observes only: it never answers a challenge, never fills a field and never
// changes proxy or browser identity to evade the checkpoint.
export async function waitForHuman({ reason, observe, log, config, cancel,
  pollMs = 2000, onStep = async () => {} }) {
  requireThat(humanCheckpointReasons.includes(reason), 'unsupported_human_checkpoint');
  const started = Date.now();
  await log.transition('waiting_for_human', { reason, browserPreserved: true });
  await onStep({ phase: 'human_checkpoint', reason, state: 'waiting' });
  const deadline = started + config.humanCheckpointSeconds * 1000;
  while (Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, Math.min(pollMs, Math.max(250, deadline - Date.now()))));
    await cancel.throwIfCancelled(log.directory);
    const snapshot = await observe().catch(() => null);
    if (!snapshot) continue;
    // Cleared means the challenge surface is gone and the page no longer
    // classifies as the same checkpoint. Anything else keeps waiting.
    if (snapshot.challengeFrame !== true && classifyPage(snapshot) !== reason) {
      const waitedMs = Date.now() - started;
      await log.transition('running', { resumedFromCheckpoint: reason, waitedMs });
      await onStep({ phase: 'human_checkpoint', reason, state: 'resolved', waitedMs });
      return { resumed: true, waitedMs };
    }
  }
  await onStep({ phase: 'human_checkpoint', reason, state: 'timeout' });
  throw new PilotError('human_checkpoint_timeout');
}

function redactDeep(redact, value) {
  if (typeof value === 'string') return redact(value);
  if (Array.isArray(value)) return value.map(item => redactDeep(redact, item));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactDeep(redact, item)]));
  }
  return value;
}

// Per-job evidence. Every value written passes through the job redactor, and a
// logging failure is recorded instead of breaking the job.
export class JobLog {
  constructor({ directory, job, redact, onState = null }) {
    this.directory = directory; this.job = job; this.onState = onState;
    this.redact = redact || (value => String(value ?? ''));
    this.state = 'queued'; this.transitions = []; this.screenshots = []; this.logFailures = [];
    this.startedAt = new Date(); this.finishedAt = null; this.moment = performance.now();
    this.screenIndex = 0;
  }
  get elapsedMs() { return Math.round(performance.now() - this.moment); }
  async init() {
    try { await mkdir(resolve(this.directory, 'screenshots'), { recursive: true, mode: 0o700 }); }
    catch { this.logFailures.push('log_directory_unavailable'); }
  }
  async record(entry) {
    const line = redactDeep(this.redact, { at: new Date().toISOString(), elapsedMs: this.elapsedMs,
      jobId: this.job.id, state: this.state, ...entry });
    try { await appendFile(resolve(this.directory, 'events.ndjson'), `${JSON.stringify(line)}\n`, { mode: 0o600 }); }
    catch { this.logFailures.push('event_log_unavailable'); }
    return line;
  }
  async transition(state, detail = {}) {
    requireThat(jobStates.includes(state), 'unknown_job_state');
    this.state = state;
    const record = { state, at: new Date().toISOString(), elapsedMs: this.elapsedMs, ...redactDeep(this.redact, detail) };
    this.transitions.push(record);
    await this.record({ event: 'state_transition', state });
    await this.write();
    if (this.onState) {
      try { await this.onState({ ...record, jobId: this.job.id, platform: this.job.platform, profileRef: this.job.profileRef }); }
      catch { this.logFailures.push('state_sink_unavailable'); }
    }
    return record;
  }
  async screenshot(page, label, credentialOrigins = []) {
    this.screenIndex++;
    const result = await captureSafeScreenshot({ page, directory: resolve(this.directory, 'screenshots'), label,
      index: this.screenIndex, credentialOrigins });
    this.screenshots.push({ label, ...result });
    await this.record({ event: 'screenshot', label, ...result });
    return result;
  }
  failure(reason) { this.logFailures.push(reason); return reason; }
  async write() {
    try {
      await writeJson(resolve(this.directory, 'job.json'), { jobId: this.job.id, platform: this.job.platform,
        accountRef: this.job.accountRef, profileRef: this.job.profileRef,
        accountId: this.accountId || null, profileId: this.profileId || null, state: this.state,
        reason: this.reason || null, startedAt: this.startedAt.toISOString(),
        finishedAt: this.finishedAt ? this.finishedAt.toISOString() : null,
        durationMs: this.durationMs ?? null, stateTransitions: this.transitions, screenshots: this.screenshots,
        login: this.login || null, jev: this.jev || null, channel: this.channel || null,
        studioAfterRestart: this.studioAfterRestart || null, reportPath: this.reportPath || null,
        preservedProfile: this.preservedProfile || null, logFailures: [...new Set(this.logFailures)] });
    } catch { this.logFailures.push('job_log_write_failed'); }
  }
  async finish({ state, reason = null, ...detail }) {
    this.reason = reason; this.finishedAt = new Date(); this.durationMs = detail.durationMs ?? this.elapsedMs;
    Object.assign(this, detail);
    await this.transition(state, { terminal: true, ...(reason ? { reason } : {}) });
    return this.summary();
  }
  summary() {
    return { id: this.job.id, platform: this.job.platform, accountRef: this.job.accountRef,
      profileRef: this.job.profileRef, accountId: this.accountId || null, profileId: this.profileId || null,
      state: this.state, reason: this.reason || null, durationMs: this.durationMs ?? this.elapsedMs,
      startedAt: this.startedAt.toISOString(), finishedAt: this.finishedAt ? this.finishedAt.toISOString() : null,
      screenshots: this.screenshots.filter(item => item.path).length, logFailures: [...new Set(this.logFailures)] };
  }
}

function syntheticResult(account, reason) {
  return { report: { accounts: [{ accountId: account.id, platform: account.platform,
    status: 'needs_attention', reason }] }, reportPath: null };
}

async function withProfileRefRegistry(directory, task) {
  const release = await acquireNamedLock(directory, 'profile-refs');
  try {
    const path = resolve(directory, 'profile-refs.json');
    const registry = await readJson(path, { version: 1, refs: {} });
    requireThat(registry.version === 1 && registry.refs && typeof registry.refs === 'object', 'profile_ref_registry_invalid');
    const result = await task(registry);
    await writeJson(path, registry);
    return result;
  } finally { await release(); }
}

// A profile reference may only ever describe one account and platform, so a
// renamed or reused reference cannot silently hand over another account's profile.
export async function registerProfileRefs({ directory, jobs, jobAccounts }) {
  return withProfileRefRegistry(directory, registry => {
    jobs.forEach((job, index) => {
      const account = jobAccounts[index];
      const existing = registry.refs[job.profileRef];
      if (existing) requireThat(existing.accountId === account.id && existing.platform === job.platform, 'profile_ref_conflict');
      registry.refs[job.profileRef] = { ...(existing || { profileId: null, createdAt: new Date().toISOString() }),
        accountId: account.id, platform: job.platform, lastJobId: job.id };
    });
    return registry;
  });
}

// Concurrent workers finish at different moments, so the registry write is
// retried; a busy sibling must not drop this job's mapping. The job log remains
// the authoritative record either way.
async function updateProfileRef({ directory, job, accountId, profileId, state, preserved }) {
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      await withProfileRefRegistry(directory, registry => {
        const entry = registry.refs[job.profileRef];
        requireThat(entry, 'profile_ref_missing');
        registry.refs[job.profileRef] = { ...entry, accountId, platform: job.platform,
          profileId: profileId || entry.profileId || null, state, preserved: preserved === true,
          updatedAt: new Date().toISOString() };
      });
      return;
    } catch { await new Promise(resolve => setTimeout(resolve, 50 * (attempt + 1))); }
  }
}

async function existingProfileId(directory, accountId) {
  const child = await readJson(resolve(directory, 'accounts', accountId, 'profiles.json'), null).catch(() => null);
  return child?.profiles?.[accountId]?.profileId || null;
}

function wrapProfileApi({ api, log, preserved, preserveOnCheckpoint }) {
  const wrapped = Object.create(api);
  wrapped.create = async (...args) => {
    await log.transition('starting_profile', { phase: 'profile_create' });
    const profileId = await api.create(...args);
    await log.record({ event: 'profile_created', profileId });
    return profileId;
  };
  wrapped.start = async (...args) => {
    await log.transition('starting_profile', { phase: 'profile_start' });
    const port = await api.start(...args);
    preserved.port = port;
    await log.record({ event: 'browser_port_received', port });
    return port;
  };
  wrapped.stop = async profileId => {
    if (preserveOnCheckpoint && preserved.active) {
      await log.record({ event: 'profile_stop_withheld', profileId });
      return { preserved: true };
    }
    return api.stop(profileId);
  };
  return wrapped;
}

// Studio may itself raise a security checkpoint. It uses the same observing
// wait as the login flow and never answers the challenge.
async function studioWithCheckpoints({ account, page, log, config, cancel, studioImpl, emit, pollMs, attempt = 0 }) {
  const studio = await studioImpl({ page, account, onStep: emit });
  if (studio.state === 'checkpoint' && attempt < 2) {
    await log.screenshot(page, `studio_checkpoint_${attempt + 1}`, []);
    const reason = humanCheckpointReasons.includes(studio.reason) ? studio.reason : 'human_verification_required';
    const paused = await waitForHuman({ reason, observe: () => observeStudio(page), log, config, cancel,
      pollMs, onStep: emit });
    if (paused.resumed) {
      return studioWithCheckpoints({ account, page, log, config, cancel, studioImpl, emit, pollMs, attempt: attempt + 1 });
    }
  }
  return studio;
}

async function runJobFlow({ job, account, log, args, config, cancel, flowImpl, studioImpl, pollMs }) {
  const { page, verifyOnly = false, onStep = async () => {} } = args;
  const site = sites[account.platform];
  const emit = async detail => {
    await cancel.throwIfCancelled(log.directory);
    await log.record({ event: 'browser_action', ...detail });
    await onStep(detail);
  };
  const requestHumanCheckpoint = async context => {
    await log.screenshot(context.page, `checkpoint_${context.reason}`, site.credentialOrigins);
    return waitForHuman({ reason: context.reason, observe: () => context.browser.observe(),
      log, config, cancel, pollMs, onStep: emit });
  };
  await log.transition('running', { phase: verifyOnly ? 'session_reopen' : 'login' });
  // Durable receipts for this job: written before every dispatch, kept beside the
  // job's own evidence, and reconcilable read-only by a later worker.
  const result = await flowImpl({ ...args, onStep: emit, requestHumanCheckpoint,
    receipts: createReceiptStore({ directory: log.directory }),
    scope: { jobId: job.id, platform: job.platform, profileRef: job.profileRef,
      accountId: account.id, profileId: log.profileId || null } });
  await log.screenshot(page, verifyOnly ? 'session_persisted' : 'login_verified', site.credentialOrigins);
  if (job.platform === 'youtube') {
    const studio = await studioWithCheckpoints({ account, page, log, config, cancel, studioImpl, emit, pollMs });
    await log.screenshot(page, verifyOnly ? 'youtube_studio_after_restart' : 'youtube_studio', []);
    await log.record({ event: 'youtube_studio', verifyOnly, authenticated: studio.authenticated, state: studio.state,
      url: studio.url || null, channel: studio.channel ? { name: studio.channel.name } : null,
      reason: studio.reason || null });
    if (verifyOnly) log.studioAfterRestart = studio; else log.channel = studio;
    // The reopened session only has to survive the identity check the login flow
    // already performs; a Studio mismatch is recorded, not fatal.
    if (!verifyOnly && !studio.authenticated) throw new PilotError('youtube_studio_not_authenticated');
  }
  return result;
}

export async function runJobBatch({ jobs, accountIndex, config: supplied, directory, concurrency = 2,
  api, guideFactory, cancel = new CancelToken(), connectImpl = defaultConnect, flowImpl = runLogin,
  seedImpl = seedSites, studioImpl = inspectStudio, humanCheckpointPollMs = 2000, preserveOnCheckpoint = false,
  onJobState = null }) {
  const config = validateConfig(supplied);
  requireThat(Number.isInteger(concurrency) && concurrency >= 1 && concurrency <= 5, 'invalid_concurrency');
  requireThat(/^[a-zA-Z0-9-]{8,80}$/.test(config.folderId || '') && !config.folderId.includes('REPLACE'), 'folder_id_required');
  requireThat(accountIndex instanceof Map, 'account_source_required');
  const selected = selectJobAccounts(accountIndex, jobs);
  const jobAccounts = jobs.map(job => selected.get(job.accountRef));
  requireThat(new Set(jobAccounts.map(account => account.id)).size === jobAccounts.length, 'duplicate_account_in_batch');
  const logs = new Map();
  jobs.forEach((job, index) => {
    const account = jobAccounts[index];
    logs.set(job.id, new JobLog({ directory: resolve(directory, 'jobs', job.id), job, onState: onJobState,
      redact: createRedactor([account.username, account.password, account.totp, account.recoveryEmail].filter(Boolean)) }));
  });
  for (const log of logs.values()) await log.init();
  const registry = await registerProfileRefs({ directory, jobs, jobAccounts });
  // Two jobs must never be pointed at the same Multilogin profile.
  const owners = new Map();
  for (let index = 0; index < jobs.length; index++) {
    const job = jobs[index]; const log = logs.get(job.id);
    log.accountId = jobAccounts[index].id;
    const profileId = registry.refs[job.profileRef]?.profileId || await existingProfileId(directory, log.accountId);
    requireThat(!profileId || !owners.has(profileId), 'duplicate_profile_ownership');
    if (profileId) owners.set(profileId, job.id);
    log.profileId = profileId;
  }
  const jobByAccountId = new Map(jobs.map((job, index) => [jobAccounts[index].id, job]));
  // batch.mjs hands each worker `accounts: [account]` plus the child state directory.
  const runAccount = async ({ accounts: [account], directory: childDirectory, config: childConfig, api: batchApi }) => {
    const job = jobByAccountId.get(account.id);
    const log = logs.get(job.id);
    const began = performance.now();
    const preserved = { active: false, port: null };
    // The wrapped api keeps the existing state transitions and the
    // preserve-on-checkpoint behaviour; the provider drives that same api.
    const jobApi = wrapProfileApi({ api: batchApi, log, preserved, preserveOnCheckpoint });
    const attach = async (port, connectionConfig) => {
      const session = await connectImpl(port, connectionConfig);
      await log.transition('browser_ready', { port });
      await log.screenshot(session.page, 'browser_ready');
      return session;
    };
    // ONE profile/session ownership abstraction: the provider owns the ownership
    // lock, the launcher start, the launcher-returned CDP endpoint, the existing
    // context and the graceful stop/sync for this job.
    const provider = new MultiloginSessionProvider({
      api: jobApi, config: childConfig, directory,
      connectImpl: attach, lockDetails: { jobId: job.id, platform: job.platform },
    });
    if (log.profileId) provider.bindProfileId(log.profileId);
    try {
      await provider.claimOwnership({ profileRef: job.profileRef, accountId: account.id });
    } catch (error) {
      const reason = log.failure(errorCode(error));
      await log.finish({ state: 'failed', reason, durationMs: Math.round(performance.now() - began) });
      return syntheticResult(account, reason);
    }
    try {
      await cancel.throwIfCancelled(log.directory);
      const result = await runBatch({
        accounts: [account], config: childConfig,
        api: jobApi, provider,
        guideFactory, directory: childDirectory, seedImpl,
        connectImpl: attach,
        loginImpl: args => runJobFlow({ job, account, log, args, config: childConfig, cancel, flowImpl, studioImpl,
          pollMs: humanCheckpointPollMs }),
      });
      const outcome = result.report.accounts[0] || {};
      const state = jobStateForResult(outcome);
      if (preserved.active) log.failure('profile_left_running_for_human_checkpoint');
      await log.finish({ state, reason: outcome.reason || null, durationMs: Math.round(performance.now() - began),
        profileId: outcome.profileId || log.profileId || null, reportPath: result.reportPath, jev: outcome.jev || null,
        login: { verified: outcome.login?.verified === true, steps: outcome.login?.steps ?? null,
          reopenVerified: outcome.reopen?.verified === true, proxySwitches: outcome.proxySwitches || 0,
          seedSites: (outcome.seedSites || []).map(item => ({ site: item.site, status: item.status })) },
        preservedProfile: preserved.active ? { profileId: outcome.profileId || null, port: preserved.port } : null });
      return result;
    } catch (error) {
      const reason = errorCode(error);
      // An unexpected (non-pilot) failure keeps only its error type, which is
      // enough to diagnose it without recording any page or credential content.
      log.failure(reason === 'unexpected_error' ? `unexpected_error:${error?.name || 'unknown'}` : reason);
      await log.finish({ state: jobStateForResult({ status: 'needs_attention', reason }), reason,
        durationMs: Math.round(performance.now() - began) });
      return syntheticResult(account, reason);
    } finally {
      // Ownership is released through the same abstraction that took it, after the
      // graceful stop/sync (a preserved browser is left running on purpose).
      await provider.detach().catch(() => {});
      await updateProfileRef({ directory, job, accountId: account.id, profileId: log.profileId,
        state: log.state, preserved: preserved.active });
    }
  };
  let batch = null; let failure = null;
  try {
    for (const job of jobs) await logs.get(job.id).transition('queued', { acceptingJobs: true });
    batch = await runConcurrentBatch({ accounts: jobAccounts, config, directory, concurrency, api, guideFactory,
      seedImpl, runAccount,
      onAccount: async ({ accountId, status, reason }) => {
        const job = jobByAccountId.get(accountId);
        if (job) await logs.get(job.id).record({ event: 'batch_account_result', status, reason: reason || null });
      } });
  } catch (error) { failure = error; }
  const finishedAt = new Date().toISOString();
  const summary = { startedAt: jobs.length ? logs.get(jobs[0].id).startedAt.toISOString() : finishedAt, finishedAt,
    concurrency, peakWorkers: batch?.report?.peakWorkers ?? null,
    peakStartedProfiles: batch?.report?.peakStartedProfiles ?? null,
    jobs: jobs.map(job => logs.get(job.id).summary()) };
  const summaryPath = resolve(directory, 'jobs', 'summary.json');
  try { await writeJson(summaryPath, summary); } catch { summary.writeFailed = true; }
  if (failure) throw failure;
  return { report: batch.report, reportPath: batch.reportPath, summary, summaryPath };
}

export function summaryLines(summary) {
  return summary.jobs.map(job => `${job.id.padEnd(28, ' ')}${job.state.padEnd(20, ' ')}`
    + `${(job.durationMs / 1000).toFixed(1)}s${job.reason ? `  ${job.reason}` : ''}`);
}

// Read-only pre-flight: no locks are taken, no profile is touched and no
// network call is made. It reports the same conflicts runJobBatch would reject.
export async function inspectJobPlan({ jobs, accountIndex, directory }) {
  const selected = selectJobAccounts(accountIndex, jobs);
  const jobAccounts = jobs.map(job => selected.get(job.accountRef));
  const problems = [];
  if (new Set(jobAccounts.map(account => account.id)).size !== jobAccounts.length) {
    problems.push({ jobId: null, problem: 'duplicate_account_in_batch' });
  }
  const registry = await readJson(resolve(directory, 'profile-refs.json'), { version: 1, refs: {} })
    .catch(() => ({ version: 1, refs: {} }));
  const owners = new Map();
  const planned = [];
  for (let index = 0; index < jobs.length; index++) {
    const job = jobs[index]; const account = jobAccounts[index];
    const entry = registry.refs?.[job.profileRef] || null;
    if (entry && (entry.accountId !== account.id || entry.platform !== job.platform)) {
      problems.push({ jobId: job.id, problem: 'profile_ref_conflict' });
    }
    const profileId = (entry?.profileId || null) || await existingProfileId(directory, account.id);
    if (profileId) {
      if (owners.has(profileId)) problems.push({ jobId: job.id, problem: 'duplicate_profile_ownership' });
      owners.set(profileId, job.id);
    }
    planned.push({ id: job.id, platform: job.platform, accountRef: job.accountRef, profileRef: job.profileRef,
      accountId: account.id, profileId, hasTotp: Boolean(account.totp), hasRecoveryEmail: Boolean(account.recoveryEmail),
      proxyCountry: account.proxyCountry || null,
      profileLock: existsSync(resolve(directory, 'locks', `profile-${job.profileRef}.lock`)) ? 'held_or_stale' : 'free' });
  }
  return { status: problems.length ? 'blocked' : 'ok', planned, problems };
}
