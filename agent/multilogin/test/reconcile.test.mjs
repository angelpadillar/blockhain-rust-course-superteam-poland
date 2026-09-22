import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BrowserExecutionKernel } from '../src/execution.mjs';
import { createReceiptStore } from '../src/receipts.mjs';
import { reconcileReceipt, reconcileOnRestart, retryAuthorized, reconciliationOutcomes } from '../src/reconcile.mjs';
import { mayRetry } from '../src/contract.mjs';

const site = { origins: ['https://accounts.google.com'], credentialOrigins: ['https://accounts.google.com'],
  homeUrl: 'https://www.youtube.com/' };
const account = { platform: 'youtube', username: 'fixture@example.com', password: 'private-password',
  totp: 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ', id: 'fixture' };

function page(text = 'Sign in', fingerprint = 'fp-before') {
  return { url: 'https://accounts.google.com/signin/v2/identifier', text, fingerprint, challengeFrame: false,
    controls: [{ key: 'sig-submit', tag: 'button', type: '', label: 'Next', enabled: true }] };
}

async function directory(t) {
  const path = await mkdtemp(join(tmpdir(), 'reconcile-'));
  t.after(() => rm(path, { recursive: true, force: true }));
  return path;
}

// A read-only probe: it observes and never dispatches.
function probe({ url = 'https://accounts.google.com/signin/v2/identifier', text = 'Sign in',
  fingerprint = 'fp-before', control = { enabled: true } } = {}) {
  const calls = { reads: 0 };
  return { calls, url: async () => url, text: async () => text, fingerprint: async () => fingerprint,
    control: async () => control, identityVerified: async () => false, verifiers: {} };
}

// A clock that keeps moving, so a postcondition poll cannot sit on its deadline.
const tickingClock = () => { let value = 2000; return () => { value += 1000; return value; }; };
const tick = () => tickingClock();

// The page the decision saw: the page fingerprint the receipt recorded is what
// "nothing changed since the decision" means.
const unchangedProbe = receipt => probe({ url: receipt.observationUrl,
  fingerprint: receipt.observationFingerprint });
// A page that moved on: the action left its mark.
const changedProbe = receipt => probe({ url: receipt.observationUrl, text: 'Two-step verification',
  fingerprint: `${receipt.observationFingerprint}-after` });

// Kills a kernel mid-flight: the dispatch starts and never returns, exactly like a
// process that died after the durable state said "dispatched".
async function crashDuringDispatch({ store, text = 'Sign in', fingerprint = 'fp-before' }) {
  const snapshot = page(text, fingerprint);
  let entered = null;
  const enteredDispatch = new Promise(resolve => { entered = resolve; });
  const kernel = new BrowserExecutionKernel({ account, site, workflow: 'login', runId: 'job-1',
    receipts: store, scope: { jobId: 'job-1', profileId: 'profile-1' },
    observe: async () => snapshot });
  const pending = kernel.execute({ candidate: { kind: 'submit_login', control: snapshot.controls[0] },
    snapshot, observation: kernel.observe(snapshot).observation, source: 'jev',
    dispatch: async () => { entered(); return new Promise(() => {}); } });
  pending.catch(() => {});
  await enteredDispatch;
  return { kernel, pending, receipt: (await store.inFlight())[0] };
}

test('a crash during dispatch leaves a durable in-flight receipt that is not replayed', async t => {
  const store = createReceiptStore({ directory: await directory(t) });
  const crashed = await crashDuringDispatch({ store });

  // A new process reads the journal.
  const restarted = createReceiptStore({ directory: store.path.replace(/\/receipts\.ndjson$/, '') });
  const inFlight = await restarted.inFlight();
  assert.equal(inFlight.length, 1);
  assert.equal(inFlight[0].state, 'dispatched', 'the crash left the dispatched state on disk');
  assert.equal(inFlight[0].action.operation, 'submit_login');
  assert.equal(inFlight[0].scope.profileId, 'profile-1');
  assert.equal(inFlight[0].observationFingerprint, crashed.receipt.observationFingerprint,
    'the decision page fingerprint is durable evidence');
  assert.match(inFlight[0].observationFingerprint, /^[0-9a-f]{64}$/);
  assert.equal(inFlight[0].observationUrl, 'https://accounts.google.com/signin/v2/identifier');

  // No read-only proof: the effect stays uncertain and may not be replayed.
  const result = await reconcileOnRestart({ store: restarted, probe: unchangedProbe(inFlight[0]),
    now: tick() });
  assert.deepEqual(result.outcomes, ['still_uncertain']);
  assert.equal(result.uncertain[0].state, 'uncertain', 'a restart marks in-flight work uncertain');
  assert.equal(result.uncertain[0].reconciliations.length, 1, 'the attempt is recorded');
  assert.equal(result.retryAuthorized.length, 0);
  assert.equal(retryAuthorized(result.uncertain[0]), false);
  assert.equal((await restarted.find({ id: inFlight[0].id })).state, 'uncertain', 'persisted');
});

test('a receipt that never reached dispatch is reconciled as not-occurred, and only that authorizes a retry', async t => {
  const store = createReceiptStore({ directory: await directory(t) });
  await crashDuringDispatch({ store });
  // Rewrite the journal as the crash would have left it before the dispatched line:
  // a receipt that exists but was never dispatched.
  const journalPath = store.path;
  const lines = (await readFile(journalPath, 'utf8')).trim().split('\n');
  const { writeFile, chmod } = await import('node:fs/promises');
  await writeFile(journalPath, `${lines[0]}\n`, { mode: 0o600 });
  await chmod(journalPath, 0o600);

  const restarted = createReceiptStore({ directory: journalPath.replace(/\/receipts\.ndjson$/, '') });
  const result = await reconcileOnRestart({ store: restarted, probe: probe(), now: tick() });
  assert.deepEqual(result.outcomes, ['not_occurred']);
  assert.deepEqual(result.outcomes.every(outcome => reconciliationOutcomes.includes(outcome)), true);
  assert.equal(result.retryAuthorized.length, 1);
  assert.equal(result.retryAuthorized[0].state, 'reconciled_not_occurred');
  assert.equal(result.retryAuthorized[0].reconciliation.evidence, 'never_dispatched');
  assert.equal(mayRetry(result.retryAuthorized[0]), true, 'a retry is authorized only by a proof');
  // A retry then starts from dispatched again, never from the same key alone.
  assert.equal(retryAuthorized(result.retryAuthorized[0]), true);
});

test('a read-only proof that the effect occurred verifies the receipt and never replays it', async t => {
  const store = createReceiptStore({ directory: await directory(t) });
  const crashed = await crashDuringDispatch({ store });
  const restarted = createReceiptStore({ directory: store.path.replace(/\/receipts\.ndjson$/, '') });

  // The page the action promised to leave behind is what we now observe.
  const result = await reconcileOnRestart({ store: restarted,
    probe: changedProbe(crashed.receipt), now: tick() });
  assert.deepEqual(result.outcomes, ['action_occurred']);
  assert.equal(result.occurred[0].state, 'verified');
  assert.equal(result.occurred[0].postconditionMet, true);
  assert.equal(result.retryAuthorized.length, 0, 'an action that did occur is never replayed');
  assert.equal(retryAuthorized(result.occurred[0]), false);
  assert.equal(await restarted.inFlight({ states: ['created', 'dispatched', 'uncertain'] }).then(items => items.length), 0);
});

test('a read-only verifier that proves the effect is absent permits a retry', async t => {
  const store = createReceiptStore({ directory: await directory(t) });
  const crashed = await crashDuringDispatch({ store });
  const restarted = createReceiptStore({ directory: store.path.replace(/\/receipts\.ndjson$/, '') });
  const seen = [];

  const result = await reconcileOnRestart({ store: restarted, probe: unchangedProbe(crashed.receipt),
    now: tick(),
    verifyNotOccurred: { session_unchanged: async ({ receipt, probe: scoped }) => {
      seen.push({ operation: receipt.action.operation, readOnly: typeof scoped.fingerprint === 'function' });
      return (await scoped.fingerprint()) === receipt.observationFingerprint;
    } } });

  assert.deepEqual(seen, [{ operation: 'submit_login', readOnly: true }]);
  assert.deepEqual(result.outcomes, ['not_occurred']);
  assert.equal(result.retryAuthorized.length, 1, 'a read-only proof of absence authorizes a retry');
});

test('reconciliation attaches the same profile/session read-only and never dispatches', async t => {
  const store = createReceiptStore({ directory: await directory(t) });
  const crashed = await crashDuringDispatch({ store });
  const restarted = createReceiptStore({ directory: store.path.replace(/\/receipts\.ndjson$/, '') });
  const attached = [];

  const result = await reconcileOnRestart({ store: restarted, now: tick(),
    attach: async scope => { attached.push(scope); return unchangedProbe(crashed.receipt); } });

  assert.deepEqual(attached, [{ jobId: 'job-1', profileId: 'profile-1' }],
    'the restart re-attaches the profile the receipt names');
  assert.equal(result.results[0].attachedScope.profileId, 'profile-1');
  assert.deepEqual(result.outcomes, ['still_uncertain'], 'no verifier means no read-only proof');
});

test('reconciliation refuses a receipt that is not in flight', async () => {
  const verified = { state: 'verified', id: 'r1', action: { decisionSource: 'jev' } };
  await assert.rejects(reconcileReceipt({ receipt: verified, probe: probe() }), /receipt_not_in_flight/);
  await assert.rejects(reconcileReceipt({ receipt: { state: 'uncertain', id: 'r2' } }), /reconciliation_probe_required/);
});

test('an idempotency key is a dedupe mechanism, never proof that a website did not act', async () => {
  const store = createReceiptStore({ directory: await mkdtemp(join(tmpdir(), 'reconcile-keys-')) });
  await crashDuringDispatch({ store });
  const receipt = (await store.inFlight())[0];
  assert.equal(receipt.idempotencyKey.startsWith('job-1-s1-submit_login'), true);
  // Holding the same key changes nothing: only a reconciliation outcome does.
  assert.equal(retryAuthorized({ ...receipt, state: 'dispatched' }), false);
  assert.equal(retryAuthorized({ ...receipt, state: 'uncertain' }), false);
  assert.equal(retryAuthorized({ ...receipt, state: 'failed' }), false);
  assert.equal(retryAuthorized({ ...receipt, state: 'reconciled_not_occurred' }), true);
});

