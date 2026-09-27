import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runSingleJob } from '../src/orchestrator.mjs';
import { createFakeBackend, fixtureRecording } from './fixtures/fake-backend.mjs';
import { loadLifecycle } from '../src/lifecycle.mjs';
import { readJson } from '../src/storage.mjs';

// The fake-mode proof: the REAL orchestrator, login adapter, recovery layer,
// human-checkpoint hook, Studio verification and restart persistence run against
// an offline provider fixture with a real headless browser. No account is
// created, no network call is made and no provider budget is spent.
const scratch = async t => {
  const directory = await mkdtemp(join(tmpdir(), 'orchestrator-e2e-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
};

function recordingNotifier() {
  const sent = [];
  return { name: 'recording', sent,
    async notify({ checkpoint }) { sent.push(checkpoint);
      return { delivered: 'photo+document', previewMessageId: 41, documentMessageId: 42,
        documentName: join('screenshots', 'checkpoint.png') }; },
    async send() { return { ok: true }; },
    async poll() { return []; },
    diagnostics: { notified: 0, commands: 0, duplicates: 0, unauthorizedSender: 0 } };
}

async function waitForChallengePage(backend, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const page of backend.pages()) {
      const count = await page.locator('#human').count().catch(() => 0);
      if (count > 0) return page;
    }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error('challenge page not observed');
}

const options = ({ backend, directory, notifier = null, notify = true, job = backend.job, onEvent = null }) => ({
  job, accountIndex: backend.accountIndex, config: backend.config, directory, api: backend.api,
  guideFactory: backend.guideFactory, connectImpl: backend.connectImpl, studioImpl: backend.studioImpl,
  notifier, notify, telegram: false, memory: null, onEvent,
});

test('one command runs the whole lifecycle, announces the checkpoint and keeps the evidence', async t => {
  const directory = await scratch(t);
  const backend = await createFakeBackend({ challenged: true, humanCheckpointSeconds: 30 });
  t.after(() => backend.close());
  const notifier = recordingNotifier();
  // The person clears the challenge only once the job has genuinely reached the
  // waiting state and announced it (the recovery episode runs first).
  let waitingResolve = null;
  const waiting = new Promise(resolve => { waitingResolve = resolve; });
  const person = (async () => {
    const page = await waitForChallengePage(backend);
    await waiting;
    await new Promise(resolve => setTimeout(resolve, 300)); // a person takes a moment
    await page.locator('#human').click();
  })();
  const { result } = await runSingleJob(options({ backend, directory, notifier, notify: true,
    onEvent: entry => { if (entry.event === 'job_state' && entry.lifecycleState === 'WAITING_FOR_HUMAN') waitingResolve?.(); } }));
  await person;

  assert.equal(result.status, 'completed', JSON.stringify(result.transitions));
  assert.equal(result.lifecycleState, 'COMPLETE');
  // Formal state sequence: every phase is represented.
  const states = result.transitions.map(entry => entry.state);
  for (const state of ['PROFILE_READY', 'BROWSER_ATTACHED', 'AUTH_CHECK', 'LOGIN_IN_PROGRESS',
    'WAITING_FOR_HUMAN', 'AUTHENTICATED', 'STUDIO_VERIFIED', 'PERSISTENCE_CHECK', 'COMPLETE']) {
    assert.ok(states.includes(state), `missing lifecycle state ${state}: ${states}`);
  }
  // The human checkpoint is a human-sourced transition; execution is deterministic.
  const human = result.transitions.find(entry => entry.verification === 'human_cleared_checkpoint');
  assert.ok(human, 'the human clearance is recorded');
  assert.equal(human.actionSource, 'human');
  assert.ok(result.transitions.some(entry => entry.actionSource === 'deterministic'));
  // Identity, Studio and restart-persistence verification all passed.
  assert.deepEqual(result.verification, { login: true, reopen: true, studio: true,
    studioAfterRestart: true, restartPersistence: true });
  // The Telegram handoff carries the checkpoint identity and the screenshot.
  assert.equal(notifier.sent.length, 1);
  assert.equal(notifier.sent[0].id, result.checkpoint.id);
  assert.equal(notifier.sent[0].jobId, backend.job.id);
  assert.equal(result.checkpoint.state, 'resumed');
  // The screenshot bundle exists: canonical, context sidecar, and (with a real
  // iframe) full/region frames.
  const screenshots = await readdir(join(result.jobDirectory, 'screenshots'));
  const checkpointFiles = screenshots.filter(name => name.includes('checkpoint_'));
  assert.ok(checkpointFiles.some(name => name.endsWith('.png') && !name.includes('-full') && !name.includes('-region')));
  assert.ok(checkpointFiles.some(name => name.endsWith('-context.json')), `no context sidecar: ${screenshots}`);
  assert.equal(fixtureRecording.challengeAnswers, 0, 'the automation never answered the challenge');
  assert.equal(fixtureRecording.challengeRenders, 1);
  // The profile was stopped and the ownership lock released.
  assert.equal(backend.apiState.started.size, 0);
  assert.deepEqual(await readdir(join(directory, 'locks')).catch(() => []), []);
  // Observation mode: every decision and outcome is recorded, and the router
  // never changed execution (the same COMPLETE lifecycle above proves that).
  assert.ok(result.routerObservation, 'router observation is enabled');
  assert.equal(result.routerObservation.executionChanged, false);
  assert.ok(result.routerObservation.decisions >= 1);
  assert.ok(result.routerObservation.agreements >= 1);
  const observationRaw = await readFile(result.routerObservation.path, 'utf8');
  const observations = observationRaw.trim().split('\n').map(line => JSON.parse(line));
  assert.ok(observations.some(record => record.kind === 'decision' && record.executionChanged === false));
  assert.ok(observations.some(record => record.kind === 'outcome' && record.succeeded === true));
  assert.ok(observations.some(record => record.candidates.some(candidate => candidate.tool === 'fill_username')));
  assert.equal(observationRaw.includes('observed input'), false, 'candidate descriptions are never stored');
  assert.equal(result.proxy.reuseExistingProxy, false);
  assert.equal(result.proxy.rotations, 0);
  // Bandwidth discipline: media is blocked, bytes are measured, and a YouTube
  // run starts at the home/auth surface rather than through the login redirect.
  assert.equal(fixtureRecording.loginPageLoads, 0, 'the run starts at the home/auth surface');
  assert.ok(result.bandwidth.totalBytes > 0, 'received bytes are measured');
  assert.ok(result.bandwidth.blockedMedia >= 1, 'the fixture video request was blocked');
  assert.ok(result.bandwidth.mb < 5, `unexpected traffic: ${result.bandwidth.mb} MB`);
  assert.equal(result.profileLabel.startsWith('YT-'), true);
  assert.equal(result.health.status, 'GOOD_PERSISTED');
  // The structured result is durable, and no secret is present in the evidence.
  const stored = await readJson(result.resultPath, null);
  assert.equal(stored.status, 'completed');
  assert.equal(stored.schema, 'browser-job-result/1');
  for (const file of ['job.json', 'events.ndjson', 'lifecycle.json', 'lifecycle.ndjson', 'result.json']) {
    const raw = await readFile(join(result.jobDirectory, file), 'utf8');
    assert.equal(raw.includes('private-password'), false, `${file} must not contain the password`);
    assert.equal(raw.includes('GEZDGNBVGY3TQOJQ'), false, `${file} must not contain the TOTP seed`);
  }
});

test('a challenge that finishes loading on its own never becomes a human checkpoint', async t => {
  const directory = await scratch(t);
  const backend = await createFakeBackend({ challenged: true, lateClearMs: 2500,
    humanCheckpointSeconds: 30, challengeSettleMs: 3000 });
  t.after(() => backend.close());
  const notifier = recordingNotifier();
  const { result } = await runSingleJob(options({ backend, directory, notifier, notify: true }));
  assert.equal(result.status, 'completed', JSON.stringify(result.transitions));
  assert.equal(result.transitions.some(entry => entry.state === 'WAITING_FOR_HUMAN'), false);
  assert.equal(notifier.sent.length, 0, 'no alert for a self-clearing surface');
  assert.equal(fixtureRecording.challengeAnswers, 0, 'the automation never answered the challenge');
  assert.equal(fixtureRecording.challengeRenders, 1);
  const events = await readFile(join(result.jobDirectory, 'events.ndjson'), 'utf8');
  assert.equal(events.includes('cleared_during_settle'), true,
    'the bounded settle re-observe is the recorded reason no person was asked');
  assert.equal(result.health.status, 'GOOD_PERSISTED');
});

test('a timed-out checkpoint ends in WAITING_FOR_HUMAN, and the same command resumes the same profile', async t => {
  const directory = await scratch(t);
  const backend = await createFakeBackend({ challenged: true, humanCheckpointSeconds: 2 });
  t.after(() => backend.close());
  // Run 1: nobody clears the challenge; the job must stop, not restart the flow
  // or create anything.
  const first = await runSingleJob(options({ backend, directory }));
  assert.equal(first.result.status, 'waiting_for_human', JSON.stringify(first.result.transitions));
  assert.equal(first.result.reason, 'human_checkpoint_timeout');
  assert.equal(first.result.sameProfileAsPreviousRun, false);
  const profileId = first.result.profileId;
  assert.ok(profileId, 'a profile id is recorded');
  const stored = await readJson(join(first.result.jobDirectory, 'human-checkpoint.json'), null);
  assert.equal(stored.state, 'waiting');
  // The person now clears the challenge in the preserved profile's page.
  const page = await waitForChallengePage(backend);
  await page.locator('#human').click();
  await new Promise(resolve => setTimeout(resolve, 300));
  // Run 2: automatic resume detection reopens the SAME profile and finishes.
  const second = await runSingleJob(options({ backend, directory }));
  assert.equal(second.result.status, 'completed', JSON.stringify(second.result.transitions));
  assert.equal(second.result.resumedFrom, 'WAITING_FOR_HUMAN');
  assert.equal(second.result.sameProfileAsPreviousRun, true);
  assert.equal(second.result.profileId, profileId, 'the same Multilogin profile was reused');
  assert.equal(fixtureRecording.challengeRenders, 1, 'the cleared challenge was not presented again');
  assert.equal(fixtureRecording.challengeAnswers, 0);
  assert.equal(second.result.verification.reopen, true, 'restart persistence verified after resume');
  const journal = await readFile(join(first.result.jobDirectory, 'lifecycle.ndjson'), 'utf8');
  assert.equal(journal.includes('resumed_from_WAITING_FOR_HUMAN'), true,
    'the resume decision is durable evidence');
  const lifecycle = await loadLifecycle({ directory: first.result.jobDirectory });
  assert.equal(lifecycle.state, 'COMPLETE');
});

test('an authenticated profile resumes without resubmitting credentials', async t => {
  const directory = await scratch(t);
  const backend = await createFakeBackend({ challenged: false, humanCheckpointSeconds: 30 });
  t.after(() => backend.close());
  const first = await runSingleJob(options({ backend, directory }));
  assert.equal(first.result.status, 'completed', JSON.stringify(first.result.transitions));
  const postsAfterFirst = [...fixtureRecording.posts];
  assert.deepEqual(postsAfterFirst, ['password', 'totp']);
  // The second run reopens the same persisted session: the login URL redirects
  // to the signed-in home page and the identity verifies with zero actions.
  const second = await runSingleJob(options({ backend, directory }));
  assert.equal(second.result.status, 'completed');
  assert.equal(second.result.profileId, first.result.profileId);
  assert.deepEqual(fixtureRecording.posts, postsAfterFirst,
    'no credential was submitted again for an already authenticated profile');
  assert.equal(fixtureRecording.challengeRenders, 0);
  assert.equal(fixtureRecording.loginPageLoads, 0, 'the authenticated resume never loaded the login page');
});
