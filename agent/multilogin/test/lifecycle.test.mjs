import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLifecycle, loadLifecycle, isResumableLifecycle, isTerminalLifecycleState,
  allowedLifecycleTransitions, actionSourceForMethod } from '../src/lifecycle.mjs';
import { createRedactor } from '../src/core.mjs';

const scratch = async t => {
  const directory = await mkdtemp(join(tmpdir(), 'lifecycle-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
};
const job = { id: 'yt-live-05', platform: 'youtube', accountRef: 'yt-live-05', profileRef: 'yt-live-05' };

test('the lifecycle only moves along declared transitions', async t => {
  const directory = await scratch(t);
  const lifecycle = createLifecycle({ directory, job });
  await assert.rejects(lifecycle.transition('COMPLETE'), /illegal_lifecycle_transition:PENDING->COMPLETE/);
  await lifecycle.transition('PROFILE_READY', { action: 'resolve_profile', actionSource: 'deterministic' });
  await lifecycle.transition('BROWSER_ATTACHED');
  await lifecycle.transition('AUTH_CHECK');
  await lifecycle.transition('LOGIN_IN_PROGRESS');
  await lifecycle.transition('WAITING_FOR_HUMAN', { reason: 'human_verification_required' });
  await lifecycle.transition('LOGIN_IN_PROGRESS', { reason: 'checkpoint_cleared' });
  await lifecycle.transition('AUTHENTICATED', { verification: 'signed_in_identity_verified' });
  await lifecycle.transition('STUDIO_VERIFIED', { verification: 'studio_authenticated' });
  await lifecycle.transition('PERSISTENCE_CHECK');
  await lifecycle.finish('COMPLETE', { verification: 'restart_persistence_verified' });
  assert.equal(lifecycle.state, 'COMPLETE');
  // Every state has a declared successor list, and a terminal state has none.
  assert.deepEqual(allowedLifecycleTransitions.COMPLETE, []);
  assert.equal(isTerminalLifecycleState('COMPLETE'), true);
  assert.equal(isTerminalLifecycleState('WAITING_FOR_HUMAN'), false);
});

test('every transition carries observation, action source, result, verification and counters', async t => {
  const directory = await scratch(t);
  const redact = createRedactor(['private-password']);
  const lifecycle = createLifecycle({ directory, job, redact });
  await lifecycle.transition('PROFILE_READY', { action: 'resolve_profile', actionSource: 'deterministic',
    observation: { profileRef: 'yt-live-05' }, result: 'profile_bound', retries: 0 });
  await lifecycle.recordAction({ action: 'fill_password', actionSource: 'deterministic', result: 'selected',
    observation: { label: 'private-password' } });
  await lifecycle.transition('BROWSER_ATTACHED', { observation: { port: 51001 }, result: 'cdp_attached' });
  await lifecycle.addCounters({ recoverySteps: 2, modelCalls: 1 });
  const [first, second] = lifecycle.transitions;
  assert.equal(first.observation.profileRef, 'yt-live-05');
  assert.equal(first.action, 'resolve_profile');
  assert.equal(first.actionSource, 'deterministic');
  assert.equal(first.result, 'profile_bound');
  assert.equal(first.verification, null);
  assert.equal(typeof first.elapsedMs, 'number');
  assert.equal(first.retries, 0);
  assert.equal(second.state, 'BROWSER_ATTACHED');
  assert.deepEqual(lifecycle.counters.recoverySteps, 2);
  assert.deepEqual(lifecycle.counters.modelCalls, 1);
  // The action journal never carries a secret: the redactor rewrites the label.
  const journal = await readFile(lifecycle.journalPath, 'utf8');
  assert.equal(journal.includes('private-password'), false);
  assert.equal(journal.includes('[secret]'), true);
});

test('the snapshot survives a restart and decides resumability', async t => {
  const directory = await scratch(t);
  const lifecycle = createLifecycle({ directory, job });
  await lifecycle.transition('PROFILE_READY');
  await lifecycle.transition('BROWSER_ATTACHED');
  await lifecycle.transition('AUTH_CHECK');
  await lifecycle.transition('LOGIN_IN_PROGRESS');
  await lifecycle.transition('WAITING_FOR_HUMAN', { reason: 'human_verification_required' });
  await lifecycle.finish('WAITING_FOR_HUMAN', { reason: 'human_checkpoint_timeout' });
  const restored = await loadLifecycle({ directory });
  assert.equal(restored.state, 'WAITING_FOR_HUMAN');
  assert.equal(restored.jobId, 'yt-live-05');
  // The latest evidence for the settled state, including the same-state update
  // the finish() call recorded.
  assert.equal(restored.lastTransition.reason, 'human_checkpoint_timeout');
  assert.equal(restored.lastTransition.state, 'WAITING_FOR_HUMAN');
  assert.equal(isResumableLifecycle(restored), true, 'a waiting job resumes on the same profile');
  // A terminal run is not resumed.
  const doneDirectory = await scratch(t);
  const done = createLifecycle({ directory: doneDirectory, job });
  await done.transition('PROFILE_READY');
  await done.transition('BROWSER_ATTACHED');
  await done.transition('AUTH_CHECK');
  await done.transition('AUTHENTICATED');
  await done.transition('COMPLETE');
  assert.equal(isResumableLifecycle(await loadLifecycle({ directory: doneDirectory })), false);
  assert.equal(await loadLifecycle({ directory: join(doneDirectory, 'absent') }), null);
});

test('the action source reflects who decided, never the model’s own claim', () => {
  assert.equal(actionSourceForMethod('exact-single-match'), 'deterministic');
  assert.equal(actionSourceForMethod('typesafe-choice'), 'jev');
  assert.equal(actionSourceForMethod('frontier-vision'), 'frontier');
  assert.equal(actionSourceForMethod('operator-command'), 'operator');
  assert.equal(actionSourceForMethod(null), 'none');
});

test('a same-state update records evidence without inventing a transition', async t => {
  const directory = await scratch(t);
  const lifecycle = createLifecycle({ directory, job });
  await lifecycle.transition('PROFILE_READY');
  await lifecycle.transition('PROFILE_READY', { result: 'profile_reused', verification: 'registry_match' });
  assert.equal(lifecycle.transitions.length, 1);
  const snapshot = lifecycle.snapshot();
  assert.equal(snapshot.transitions.length, 1);
  const journal = await readFile(lifecycle.journalPath, 'utf8');
  const entries = journal.trim().split('\n').map(line => JSON.parse(line));
  assert.equal(entries.length, 2);
  assert.equal(entries[1].kind, 'state_update');
  assert.equal(entries[1].verification, 'registry_match');
});
