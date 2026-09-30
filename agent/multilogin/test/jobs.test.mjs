import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, readdir, writeFile, chmod, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';

const execFileAsync = promisify(execFile);
import { runJobBatch, validateJobs, waitForHuman, inspectJobPlan, summaryLines, CancelToken, JobLog,
  jobStateForResult, humanCheckpointReasons } from '../src/jobs.mjs';
import { accountsFromRecords, loadAccountIndex } from '../src/accounts.mjs';
import { acquireProfileLock, acquireNamedLock } from '../src/profile-lock.mjs';
import { captureSafeScreenshot } from '../src/screenshots.mjs';
import { PilotError } from '../src/core.mjs';
import { readJson, writeJson } from '../src/storage.mjs';

const seed = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
const password = 'private-password';

export function accountIndex(count = 3) {
  return accountsFromRecords(Array.from({ length: count }, (_, index) => ({
    ref: `yt-account-0${index + 1}`, platform: 'youtube', username: `fixture0${index + 1}@example.com`,
    password, totp: seed })));
}
export function jobsFor(count = 3) {
  return validateJobs({ jobs: Array.from({ length: count }, (_, index) => ({ id: `youtube-0${index + 1}`,
    platform: 'youtube', accountRef: `yt-account-0${index + 1}`, profileRef: `yt-profile-0${index + 1}` })) });
}

function page({ url = 'https://www.youtube.com/', passwordFields = 0, written = [] } = {}) {
  return { url: () => url,
    locator: () => ({ count: async () => passwordFields, first() { return this; }, innerText: async () => '' }),
    screenshot: async ({ path }) => { written.push(path); await writeFile(path, 'png-bytes'); } };
}

function stubApi() {
  const state = { creates: 0, started: new Set(), peakProfiles: 0, stops: [], ports: new Set(), profiles: new Set() };
  const api = {
    create: async () => { state.creates++; const id = `profile-${String(state.creates).padStart(4, '0')}`;
      state.profiles.add(id); return id; },
    start: async (folderId, profileId) => {
      assert.equal(state.started.has(profileId), false, 'the same profile was started twice at once');
      state.started.add(profileId); state.peakProfiles = Math.max(state.peakProfiles, state.started.size);
      const port = 50000 + Number(profileId.split('-')[1]);
      state.ports.add(port); return port;
    },
    stop: async profileId => { state.stops.push(profileId); assert.equal(state.started.delete(profileId), true); },
    premiumProxy: async () => ({ type: 'socks5', host: 'proxy.example', port: 1080, username: 'user', password: 'proxy-secret' }),
    changeProxy: async () => {},
    status: async () => ({ status: 'stopped' }),
  };
  return { api, state };
}

const guideFactory = () => Object.assign(async () => {}, { metrics: { calls: 0, usageComplete: true, exactActions: 0 } });
const studioReady = async () => ({ authenticated: true, state: 'ready', channel: { name: 'Fixture Channel' },
  url: 'https://studio.youtube.com/', reason: null });

async function fixture(t, { count = 3 } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'jev-jobs-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const written = []; const { api, state } = stubApi();
  return { directory, api, state, written, jobs: jobsFor(count), accountIndex: accountIndex(count),
    config: { folderId: 'folder-0001', proxyMode: 'none', seedSites: [], verifyRestart: true, humanCheckpointSeconds: 2 },
    guideFactory, studioImpl: studioReady, humanCheckpointPollMs: 20, states: [],
    connectImpl: async () => ({ page: page({ written }), context: {},
      browser: { isConnected: () => false, close: async () => {} } }),
    flowImpl: async ({ onStep, verifyOnly = false }) => {
      await onStep({ step: 0, phase: verifyOnly ? 'verify_reopen' : 'login', action: 'fill_username', state: 'after' });
      await new Promise(resolve => setTimeout(resolve, 30));
      return { verified: true, steps: 1, durationMs: 5 };
    } };
}

test('a profile lock is atomic: one owner, and no second owner while a job holds it', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'jev-lock-race-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  // mkdir is atomic, so concurrent workers can never both win the same profile.
  const attempts = await Promise.allSettled(Array.from({ length: 5 },
    () => acquireProfileLock(directory, 'yt-profile-01')));
  const winners = attempts.filter(attempt => attempt.status === 'fulfilled');
  assert.equal(winners.length, 1, 'exactly one worker may own a profile');
  assert.equal(attempts.filter(attempt => attempt.status === 'rejected')
    .every(attempt => /profile_locked_or_stale_lock/.test(attempt.reason)), true);
  // A held profile does not block a different one.
  const other = await acquireProfileLock(directory, 'yt-profile-02');
  const owner = await readJson(join(directory, 'locks', 'profile-yt-profile-01.lock', 'owner.json'));
  assert.equal(owner.name, 'profile-yt-profile-01');
  await winners[0].value(); await other();
  // While a job is running, its profile is locked against any other owner.
  const input = await fixture(t, { count: 1 });
  const job = input.jobs[0];
  const connect = input.connectImpl;
  input.connectImpl = async (...args) => {
    const lockOwner = await readJson(join(input.directory, 'locks', `profile-${job.profileRef}.lock`, 'owner.json'));
    assert.equal(lockOwner.jobId, job.id);
    assert.equal(lockOwner.pid, process.pid);
    await assert.rejects(acquireProfileLock(input.directory, job.profileRef), /profile_locked_or_stale_lock/);
    const free = await acquireProfileLock(input.directory, 'yt-profile-99');
    await free();
    return connect(...args);
  };
  const result = await runJobBatch({ ...input, concurrency: 1 });
  assert.equal(result.summary.jobs[0].state, 'success');
  assert.deepEqual(await readdir(join(input.directory, 'locks')), []);
});

test('job definitions reject duplicate ids, repeated references and unknown platforms', () => {
  const base = { id: 'youtube-01', platform: 'youtube', accountRef: 'yt-account-01', profileRef: 'yt-profile-01' };
  assert.equal(validateJobs({ jobs: [base] }).length, 1);
  // The same account on the same profile is a multi-step identity (Outlook then
  // LinkedIn) and is allowed; a different account or a split profile is not.
  assert.equal(validateJobs({ jobs: [base, { ...base, id: 'youtube-02', platform: 'linkedin' }] }).length, 2);
  for (const [jobs, expected] of [
    [[base, { ...base, accountRef: 'yt-account-02' }], /duplicate_job_id/],
    [[base, { ...base, id: 'youtube-02', accountRef: 'yt-account-02' }], /duplicate_profile_ref/],
    [[base, { ...base, id: 'youtube-02', profileRef: 'yt-profile-02' }], /duplicate_account_ref/],
    [[{ ...base, platform: 'tiktok' }], /unsupported_platform/],
    [[{ ...base, profileRef: '../escape' }], /invalid_profile_ref/],
    [[], /invalid_jobs_file/],
  ]) assert.throws(() => validateJobs({ jobs }), expected);
});

test('account references resolve from a mode-600 private store only', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'jev-accounts-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'accounts.json');
  await writeFile(path, JSON.stringify([{ ref: 'yt-account-01', platform: 'youtube',
    username: 'fixture01@example.com', password, totp: seed }]), { mode: 0o600 });
  const index = await loadAccountIndex({ path });
  assert.equal(index.get('yt-account-01').password, password);
  await chmod(path, 0o644);
  await assert.rejects(loadAccountIndex({ path }), /private_file_requires_mode_600/);
  assert.throws(() => accountsFromRecords([{ ref: 'yt-account-01', platform: 'youtube',
    username: 'fixture01@example.com', password }, { ref: 'yt-account-01', platform: 'youtube',
    username: 'fixture02@example.com', password }]), /duplicate_account_ref/);
});

test('a profile reference lock is exclusive per profile and reusable after release', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'jev-lock-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const release = await acquireProfileLock(directory, 'yt-profile-01', { accountId: 'a' });
  await assert.rejects(acquireProfileLock(directory, 'yt-profile-01'), /profile_locked_or_stale_lock/);
  const other = await acquireProfileLock(directory, 'yt-profile-02');
  await release();
  const again = await acquireProfileLock(directory, 'yt-profile-01');
  await again(); await other();
  await assert.rejects(acquireNamedLock(directory, 'bad/name'), /invalid_lock_name/);
});

test('job states distinguish success, checkpoints, cancellation and failure', () => {
  assert.equal(jobStateForResult({ status: 'completed' }), 'success');
  assert.equal(jobStateForResult({ status: 'completed_with_seed_attention' }), 'success');
  assert.equal(jobStateForResult({ status: 'needs_attention', reason: 'signin_rejected' }), 'failed');
  assert.equal(jobStateForResult({ status: 'needs_attention', reason: 'cancelled' }), 'cancelled');
  assert.equal(jobStateForResult({ status: 'needs_attention', reason: 'proxy_connection_failed' }), 'failed');
  for (const reason of [...humanCheckpointReasons, 'human_checkpoint_timeout']) {
    assert.equal(jobStateForResult({ status: 'needs_attention', reason }), 'waiting_for_human', reason);
  }
});

test('three jobs run at once on isolated profiles, browsers and log directories', async t => {
  const input = await fixture(t, { count: 3 });
  const result = await runJobBatch({ ...input, concurrency: 3,
    onJobState: state => input.states.push(state) });
  for (const job of result.summary.jobs) assert.equal(job.state, 'success', job.reason || 'no reason');
  assert.equal(result.report.peakWorkers, 3);
  assert.equal(input.state.peakProfiles, 3);
  assert.equal(input.state.profiles.size, 3);
  assert.equal(input.state.ports.size, 3);
  assert.equal(input.state.started.size, 0, 'every profile was stopped');
  assert.ok(input.states.some(state => state.state === 'starting_profile'));
  assert.ok(input.states.some(state => state.state === 'browser_ready'));
  assert.ok(input.states.some(state => state.state === 'success'));
  for (const job of input.jobs) {
    const jobDirectory = join(input.directory, 'jobs', job.id);
    const document = await readJson(join(jobDirectory, 'job.json'));
    const raw = await readFile(join(jobDirectory, 'job.json'), 'utf8');
    const events = await readFile(join(jobDirectory, 'events.ndjson'), 'utf8');
    assert.equal(document.profileRef, job.profileRef);
    assert.equal(document.state, 'success');
    assert.ok(document.profileId);
    assert.equal(document.channel.state, 'ready');
    assert.equal(document.login.verified, true);
    assert.equal(document.login.reopenVerified, true);
    for (const state of ['starting_profile', 'browser_ready', 'running', 'success']) {
      assert.ok(document.stateTransitions.some(item => item.state === state), state);
    }
    for (const other of input.jobs.filter(candidate => candidate.id !== job.id)) {
      assert.equal(raw.includes(other.profileRef), false, 'logs are isolated per job');
    }
    for (const secret of [password, seed, 'fixture01@example.com', 'proxy-secret']) {
      assert.equal(raw.includes(secret), false, `job.json must not contain ${secret}`);
      assert.equal(events.includes(secret), false, `events must not contain ${secret}`);
    }
    assert.ok(events.includes('browser_action'), 'browser actions are recorded');
  }
  const summaryRaw = await readFile(result.summaryPath, 'utf8');
  assert.equal(summaryRaw.includes(password), false);
  assert.match(summaryLines(result.summary)[0], /^youtube-01\s+success\s+\d+\.\d+s$/);
  assert.equal(input.written.length >= 3, true, 'state transitions capture screenshots');
  const registry = await readJson(join(input.directory, 'profile-refs.json'));
  assert.equal(Object.keys(registry.refs).length, 3);
  assert.equal(new Set(Object.values(registry.refs).map(entry => entry.profileId)).size, 3);
});

test('one failing worker never cancels the others and releases its profile lock', async t => {
  const input = await fixture(t, { count: 3 });
  const failing = input.accountIndex.get('yt-account-02').id;
  input.flowImpl = async ({ account, onStep, verifyOnly = false }) => {
    if (!verifyOnly && account.id === failing) throw new PilotError('signin_rejected');
    await onStep({ step: 0, phase: 'login', action: 'fill_username', state: 'after' });
    return { verified: true, steps: 1 };
  };
  const result = await runJobBatch({ ...input, concurrency: 3 });
  assert.deepEqual(result.summary.jobs.map(job => job.state), ['success', 'failed', 'success']);
  assert.equal(result.summary.jobs[1].reason, 'signin_rejected');
  assert.equal(input.state.started.size, 0);
  const leftovers = await readdir(join(input.directory, 'locks'));
  assert.deepEqual(leftovers, []);
});

test('a job waiting for a person keeps its browser without blocking other jobs', async t => {
  const input = await fixture(t, { count: 3 });
  const challenged = input.accountIndex.get('yt-account-02').id;
  const challenge = { url: 'https://accounts.google.com/signin/challenge', text: 'Verify you are human',
    controls: [], challengeFrame: true };
  input.flowImpl = async ({ account, onStep, requestHumanCheckpoint, verifyOnly = false }) => {
    if (!verifyOnly && account.id === challenged) {
      await requestHumanCheckpoint({ reason: 'human_verification_required', page: page(),
        browser: { observe: async () => challenge } });
    }
    await onStep({ step: 0, phase: 'login', action: 'fill_username', state: 'after' });
    return { verified: true, steps: 1 };
  };
  const result = await runJobBatch({ ...input, concurrency: 3 });
  assert.deepEqual(result.summary.jobs.map(job => job.state), ['success', 'waiting_for_human', 'success']);
  assert.equal(result.summary.jobs[1].reason, 'human_checkpoint_timeout');
  const document = await readJson(join(input.directory, 'jobs', input.jobs[1].id, 'job.json'));
  assert.ok(document.stateTransitions.some(item => item.state === 'waiting_for_human'));
  assert.equal(document.stateTransitions.at(-1).state, 'waiting_for_human');
  assert.equal(input.state.started.size, 0);
  assert.deepEqual(await readdir(join(input.directory, 'locks')), []);
  const registry = await readJson(join(input.directory, 'profile-refs.json'));
  assert.ok(registry.refs['yt-profile-02'].profileId, 'the waiting profile stays mapped for its rerun');
});

test('cancellation stops queued jobs before any profile is created or started', async t => {
  const input = await fixture(t, { count: 2 });
  const cancel = new CancelToken(); cancel.abort('operator');
  const result = await runJobBatch({ ...input, concurrency: 2, cancel });
  assert.deepEqual(result.summary.jobs.map(job => job.state), ['cancelled', 'cancelled']);
  assert.equal(input.state.creates, 0);
  assert.equal(input.state.started.size, 0);
});

test('a job can be cancelled while it waits for a person', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'jev-cancel-checkpoint-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const job = jobsFor(1)[0];
  const log = new JobLog({ directory, job, redact: value => String(value) });
  await log.init();
  const cancel = new CancelToken();
  setTimeout(() => cancel.abort('operator'), 50);
  await assert.rejects(waitForHuman({ reason: 'human_verification_required',
    observe: async () => ({ url: 'https://accounts.google.com/signin/challenge', text: 'Verify you are human',
      controls: [], challengeFrame: true }),
    log, config: { humanCheckpointSeconds: 30 }, cancel, pollMs: 10, onStep: async () => {} }), /cancelled/);
  assert.equal(log.state, 'waiting_for_human');
});

test('two jobs can never be pointed at the same Multilogin profile or reuse a reference', async t => {
  const input = await fixture(t, { count: 2 });
  const [first, second] = input.jobs;
  const accountId = job => input.accountIndex.get(job.accountRef).id;
  await writeJson(join(input.directory, 'profile-refs.json'), { version: 1, refs: {
    [first.profileRef]: { accountId: accountId(first), platform: 'youtube', profileId: 'profile-shared-01' },
    [second.profileRef]: { accountId: accountId(second), platform: 'youtube', profileId: 'profile-shared-01' } } });
  await assert.rejects(runJobBatch({ ...input, concurrency: 2 }), /duplicate_profile_ownership/);
  const foreign = await readJson(join(input.directory, 'profile-refs.json'));
  foreign.refs[first.profileRef].accountId = accountId(second);
  await writeJson(join(input.directory, 'profile-refs.json'), foreign);
  await assert.rejects(runJobBatch({ ...input, concurrency: 2 }), /profile_ref_conflict/);
  assert.equal(input.state.creates, 0);
});

test('the human checkpoint wait resumes the live browser and never answers a challenge', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'jev-wait-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const job = jobsFor(1)[0];
  const log = new JobLog({ directory, job, redact: value => String(value) });
  await log.init();
  const steps = []; let observations = 0;
  const resumed = await waitForHuman({ reason: 'human_verification_required',
    observe: async () => (++observations === 1
      ? { url: 'https://accounts.google.com/signin/challenge', text: 'Verify you are human', controls: [], challengeFrame: true }
      : { url: 'https://www.youtube.com/', text: 'Google Account Sign out Switch account', controls: [] }),
    log, config: { humanCheckpointSeconds: 5 }, cancel: new CancelToken(), pollMs: 10,
    onStep: async detail => steps.push(detail) });
  assert.equal(resumed.resumed, true);
  assert.ok(resumed.waitedMs >= 0);
  assert.deepEqual(log.transitions.map(item => item.state), ['waiting_for_human', 'running']);
  assert.deepEqual(steps.map(step => step.state), ['waiting', 'resolved']);
  await assert.rejects(waitForHuman({ reason: 'email_or_sms_verification_required',
    observe: async () => ({ url: 'https://accounts.google.com/signin/challenge', text: 'Verify you are human',
      controls: [], challengeFrame: true }),
    log, config: { humanCheckpointSeconds: 1 }, cancel: new CancelToken(), pollMs: 10,
    onStep: async () => {} }), /human_checkpoint_timeout/);
  await assert.rejects(waitForHuman({ reason: 'account_restricted', observe: async () => ({}), log,
    config: { humanCheckpointSeconds: 1 }, cancel: new CancelToken(), pollMs: 10 }), /unsupported_human_checkpoint/);
});

test('screenshots are captured at transitions but never while a password field is on screen', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'jev-shots-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const written = [];
  const captured = await captureSafeScreenshot({ page: page({ url: 'https://www.youtube.com/', written }),
    directory, label: 'login_verified', index: 1 });
  assert.ok(captured.path);
  const skipped = await captureSafeScreenshot({ page: page({ url: 'https://accounts.google.com/signin/v2/challenge',
    passwordFields: 1, written }), directory, label: 'checkpoint_human_verification_required', index: 2,
    credentialOrigins: ['https://accounts.google.com'] });
  assert.deepEqual(skipped, { skipped: 'credential_entry_visible' });
  const allowed = await captureSafeScreenshot({ page: page({ url: 'https://accounts.google.com/signin/v2/challenge',
    passwordFields: 0, written }), directory, label: 'checkpoint_human_verification_required', index: 3,
    credentialOrigins: ['https://accounts.google.com'] });
  assert.ok(allowed.path);
  assert.equal(written.length, 2);
});

test('the read-only plan reports conflicts without taking a lock', async t => {
  const input = await fixture(t, { count: 2 });
  const clean = await inspectJobPlan({ jobs: input.jobs, accountIndex: input.accountIndex, directory: input.directory });
  assert.equal(clean.status, 'ok');
  assert.equal(clean.planned[0].profileLock, 'free');
  assert.equal(clean.planned[0].profileId, null);
  const [first, second] = input.jobs;
  const accountId = job => input.accountIndex.get(job.accountRef).id;
  await writeJson(join(input.directory, 'profile-refs.json'), { version: 1, refs: {
    [first.profileRef]: { accountId: accountId(first), platform: 'youtube', profileId: 'profile-aaaa-01' },
    [second.profileRef]: { accountId: accountId(second), platform: 'youtube', profileId: 'profile-aaaa-01' } } });
  const blocked = await inspectJobPlan({ jobs: input.jobs, accountIndex: input.accountIndex, directory: input.directory });
  assert.equal(blocked.status, 'blocked');
  assert.deepEqual(blocked.problems.map(problem => problem.problem), ['duplicate_profile_ownership']);
  assert.deepEqual(await readdir(join(input.directory, 'locks')).catch(() => []), []);
});

test('batch-runner validates a job file and prints a plan without touching a profile', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'jev-cli-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const accountsPath = join(directory, 'accounts.json');
  await writeFile(accountsPath, JSON.stringify([{ ref: 'yt-account-01', platform: 'youtube',
    username: 'fixture01@example.com', password, totp: seed }]), { mode: 0o600 });
  const jobsPath = join(directory, 'jobs.json');
  await writeFile(jobsPath, JSON.stringify({ jobs: [{ id: 'youtube-01', platform: 'youtube',
    accountRef: 'yt-account-01', profileRef: 'yt-profile-01' }] }));
  const configPath = join(directory, 'config.json');
  await writeFile(configPath, JSON.stringify({ folderId: 'folder-0001', proxyMode: 'multilogin', proxyCountry: 'pl' }));
  const { stdout } = await execFileAsync(process.execPath, ['batch-runner.mjs', jobsPath, '--dry-run', '--accounts',
    accountsPath, '--data', join(directory, 'state'), '--config', configPath, '--concurrency', '3'],
  { cwd: fileURLToPath(new URL('..', import.meta.url)) });
  const plan = JSON.parse(stdout);
  assert.equal(plan.status, 'ok');
  assert.equal(plan.mode, 'dry_run');
  assert.equal(plan.concurrency, 3);
  assert.equal(plan.planned[0].profileLock, 'free');
  assert.equal(plan.planned[0].hasTotp, true);
  assert.deepEqual(plan.config.seedSites, [], 'merchant visits stay off for the login workflow');
  assert.equal(stdout.includes(password), false);
  assert.equal(stdout.includes(seed), false);
  assert.equal(existsSync(join(directory, 'state')), false, 'a dry run is read-only');
});

test('a dry run reports a conflicting plan with exit code 2 and takes no lock', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'jev-dry-run-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const records = [1, 2].map(index => ({ ref: `yt-account-0${index}`, platform: 'youtube',
    username: `fixture0${index}@example.com`, password, totp: seed }));
  const index = accountsFromRecords(records);
  const accountsPath = join(directory, 'accounts.json');
  await writeFile(accountsPath, JSON.stringify(records), { mode: 0o600 });
  const jobsPath = join(directory, 'jobs.json');
  await writeFile(jobsPath, JSON.stringify({ jobs: [1, 2].map(number => ({ id: `youtube-0${number}`,
    platform: 'youtube', accountRef: `yt-account-0${number}`, profileRef: `yt-profile-0${number}` })) }));
  const configPath = join(directory, 'config.json');
  await writeFile(configPath, JSON.stringify({ folderId: 'folder-0001', proxyMode: 'multilogin', proxyCountry: 'pl' }));
  // Two references already pointing at one profile is exactly what a rerun must refuse.
  const state = join(directory, 'state');
  await mkdir(state, { recursive: true });
  await writeJson(join(state, 'profile-refs.json'), { version: 1, refs: {
    'yt-profile-01': { accountId: index.get('yt-account-01').id, platform: 'youtube', profileId: 'profile-shared-01' },
    'yt-profile-02': { accountId: index.get('yt-account-02').id, platform: 'youtube', profileId: 'profile-shared-01' } } });
  const failure = await execFileAsync(process.execPath, ['batch-runner.mjs', jobsPath, '--dry-run', '--accounts',
    accountsPath, '--data', state, '--config', configPath], { cwd: fileURLToPath(new URL('..', import.meta.url)) })
    .then(() => null, error => error);
  assert.equal(failure?.code, 2, 'a blocked plan is not a successful run');
  const plan = JSON.parse(failure.stdout);
  assert.equal(plan.status, 'blocked');
  assert.deepEqual(plan.problems, [{ jobId: 'youtube-02', problem: 'duplicate_profile_ownership' }]);
  assert.equal(plan.planned[0].profileLock, 'free');
  assert.equal(existsSync(join(state, 'locks')), false, 'a dry run never takes a profile lock');
  assert.equal(failure.stdout.includes(password), false);
});
