import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createReceiptStore } from '../src/receipts.mjs';
import { BrowserExecutionKernel, operationKinds, riskByOperation, loginWorkflowRoles,
  recoveryWorkflowRoles, decisionSourceFor, riskForOperation, receiptSummary } from '../src/execution.mjs';
import { observationFromSnapshot, controlIdFor, attachObservation } from '../src/observation.mjs';
import { evaluatePostcondition } from '../src/postcondition.mjs';
import { createValueResolver, findLeakedSecret, modelVisibleValueRefs } from '../src/secrets.mjs';
import { mayRetry, transitionReceipt } from '../src/contract.mjs';
import { verifyIdentity, sites } from '../src/login.mjs';
import { PilotError } from '../src/core.mjs';

const account = { platform: 'youtube', username: 'fixture@example.com', password: 'private-password',
  totp: 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ', id: 'fixture' };
const site = sites.youtube;

function pageFixture() {
  return { url: 'https://accounts.google.com/signin/v2/identifier', text: 'Sign in',
    fingerprint: 'fp-1', challengeFrame: false, controls: [
      { key: 'sig-user', tag: 'input', type: 'email', label: 'Username', enabled: true },
      { key: 'sig-pass', tag: 'input', type: 'password', label: 'Password', enabled: true },
      { key: 'sig-submit', tag: 'button', type: '', label: 'Next', enabled: true }] };
}

// `pages` is the sequence the browser hands out: the first reading is the page the
// decision was taken on (pre-dispatch freshness), later readings are what the
// postcondition sees.
function harness({ snapshot = pageFixture(), live = null, pages = null, workflow = 'login',
  allowedRoles = null, now = Date.now, identityVerified = null, verifiers = {}, store = null } = {}) {
  const calls = { dispatch: [], entries: [], observed: 0 };
  const changed = live || { url: snapshot.url, text: 'Two-step verification', fingerprint: 'fp-2',
    challengeFrame: false, controls: [{ key: 'sig-code', tag: 'input', type: 'tel', label: 'Enter code',
      enabled: true }] };
  const queue = [...(pages || [snapshot, changed])];
  const kernel = new BrowserExecutionKernel({ account, site, workflow, allowedRoles, runId: 'test-run',
    receipts: store, now, identityVerified, verifiers,
    observe: async () => { calls.observed++; return queue.length > 1 ? queue.shift() : queue[0]; },
    journal: async entry => { calls.entries.push(entry); } });
  return { kernel, calls, snapshot, changed };
}
test('the durable trail is on disk before dispatch, and after every outcome', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'kernel-receipts-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = createReceiptStore({ directory });
  const { kernel, snapshot } = harness({ store });
  let onDiskAtDispatch = null;

  const outcome = await kernel.execute({ candidate: { kind: 'submit_login', control: snapshot.controls[2] },
    snapshot, observation: kernel.observe(snapshot).observation, source: 'jev',
    dispatch: async () => { onDiskAtDispatch = (await store.entries()).map(entry => entry.state); return null; } });

  assert.deepEqual(onDiskAtDispatch, ['created', 'dispatched'],
    'created and dispatched are durable before the executor is called');
  assert.equal(outcome.receipt.state, 'verified');
  assert.deepEqual((await store.entries()).map(entry => entry.state),
    ['created', 'dispatched', 'certain', 'verified'], 'and the outcome is durable too');
  const restarted = createReceiptStore({ directory });
  assert.equal((await restarted.find({ id: outcome.receipt.id })).state, 'verified');
});

test('one kernel carries both a deterministic and a Jev decision to the same executor', async () => {
  const snapshot = pageFixture();
  // Two actions, so the page is read twice before either dispatch.
  const { kernel, calls } = harness({ snapshot, pages: [snapshot, snapshot] });
  const observation = kernel.observe(snapshot).observation;
  const dispatch = async ({ action }) => { calls.dispatch.push(action.decisionSource); return null; };
  const candidate = { kind: 'submit_login', control: snapshot.controls[2] };

  const deterministic = await kernel.execute({ candidate, snapshot, observation, expectedPostcondition: null,
    source: 'deterministic', dispatch });
  const jev = await kernel.execute({ candidate, snapshot, observation, source: 'jev', expectedPostcondition: null,
    dispatch });

  assert.deepEqual(calls.dispatch, ['deterministic', 'jev'], 'one dispatch path, two decision sources');
  assert.equal(deterministic.action.kind, 'submit', 'the shared browser contract kind');
  assert.equal(deterministic.action.operation, 'submit_login', 'and the workflow operation');
  assert.equal(jev.receipt.decisionSource, 'jev');
  assert.equal(kernel.receipts.length, 8, 'four states for each action');
});

test('a receipt is persisted as created before the executor is called', async () => {
  const { kernel, calls, snapshot } = harness();
  const observation = kernel.observe(snapshot).observation;
  const outcome = await kernel.execute({ candidate: { kind: 'submit_login', control: snapshot.controls[2] },
    snapshot, observation, source: 'jev',
    dispatch: async () => { calls.dispatch.push('submit_login'); return null; } });

  assert.deepEqual(kernel.receipts.map(receipt => receipt.state),
    ['created', 'dispatched', 'certain', 'verified']);
  assert.deepEqual(calls.entries.map(entry => entry.state),
    ['created', 'dispatched', 'certain', 'verified'], 'the journal shows the same order');
  assert.equal(calls.entries[0].state, 'created', 'created is written before dispatch');
  assert.equal(calls.dispatch.length, 1);
  assert.equal(outcome.receipt.state, 'verified');
  assert.equal(outcome.receipt.postconditionMet, true);
  assert.equal(outcome.action.controlId, 'e2', 'an epoch-scoped control id, never a selector');
  assert.equal(outcome.action.expectedControlSignature, 'sig-submit');
  assert.equal(outcome.action.risk, 'authentication');
  assert.equal(riskForOperation('submit_login'), 'authentication');
  assert.equal(outcome.action.valueRef, null);
  assert.equal(outcome.action.idempotencyKey.startsWith('test-run-s1-'), true);
  assert.equal(outcome.postcondition.type, 'page_fingerprint_changed');
});

test('a fill action names a valueRef and no resolved secret enters the receipt or journal', async () => {
  const { kernel, calls, snapshot } = harness();
  const observation = kernel.observe(snapshot).observation;
  let seen = null;
  const outcome = await kernel.execute({ candidate: { kind: 'fill_password', control: snapshot.controls[1] },
    snapshot, observation, source: 'deterministic', expectedPostcondition: null,
    dispatch: async ({ action }) => { seen = action.valueRef; return null; } });
  const payload = { receipt: JSON.stringify(outcome.receipt), journal: JSON.stringify(calls.entries),
    summary: JSON.stringify(receiptSummary(outcome.receipt)) };
  assert.equal(JSON.stringify(payload).includes('private-password'), false);
  assert.equal(findLeakedSecret({ payload, secrets: [account.password, account.totp, account.username] }), null);
});

test('a model cannot grant itself authorization', async () => {
  const { kernel, snapshot } = harness();
  const observation = kernel.observe(snapshot).observation;
  // A claimed risk class is dropped: the operation defines the class.
  const claimed = kernel.plan({ candidate: { kind: 'submit_login', control: snapshot.controls[2],
    claimedRisk: 'read_only' }, snapshot, observation });
  assert.equal(claimed.action.risk, 'authentication');
  const escalated = kernel.plan({ candidate: { kind: 'submit_login', control: snapshot.controls[2],
    claimedRisk: 'consequential_external_action' }, snapshot, observation });
  assert.equal(escalated.action.risk, 'authentication', 'a claimed class cannot change the outcome');
  // An operation outside the workflow vocabulary cannot be invented at all.
  assert.throws(() => kernel.plan({ candidate: { kind: 'post_content' }, snapshot, observation }),
    /unsupported_action/);
  assert.equal(Object.keys(operationKinds).includes('consequential_external_action'), false);
  assert.equal(Object.values(riskByOperation).includes('consequential_external_action'), false,
    'no login operation is consequential, so the class is never reachable');
});

test('an operation the workflow does not authorize never reaches the browser', async () => {
  const { kernel, calls, snapshot } = harness({ workflow: 'recovery' });
  const observation = kernel.observe(snapshot).observation;
  assert.deepEqual(kernel.authorizedRoles(), recoveryWorkflowRoles);
  assert.equal(kernel.authorizedRoles().includes('authenticate'), false);
  assert.equal(kernel.permittedOperations().includes('submit_login'), false);
  assert.equal(kernel.permittedOperations().includes('open_switch_account'), true);

  await assert.rejects(kernel.execute({ candidate: { kind: 'submit_login', control: snapshot.controls[2] },
    snapshot, observation, source: 'jev',
    dispatch: async () => { calls.dispatch.push('submit_login'); } }), /risk_not_authorized/);
  assert.equal(calls.dispatch.length, 0, 'an unauthorized operation is never dispatched');
  assert.deepEqual(kernel.receipts, [], 'and it is never receipted');
});

test('a failed submit dispatch is uncertain, and an uncertain effect cannot replay', async () => {
  const { kernel, snapshot } = harness();
  const observation = kernel.observe(snapshot).observation;
  const error = await kernel.execute({ candidate: { kind: 'submit_login', control: snapshot.controls[2] },
    snapshot, observation, source: 'jev',
    dispatch: async () => { throw new PilotError('stale_control'); } }).then(() => null, thrown => thrown);

  assert.equal(error.code, 'stale_control', 'the executor error keeps its code');
  assert.deepEqual(kernel.receipts.map(receipt => receipt.state),
    ['created', 'dispatched', 'uncertain', 'failed']);
  assert.equal(error.receipt.state, 'failed');
  assert.equal(mayRetry(error.receipt), false, 'an uncertain effect is not replayed on its key');
  assert.throws(() => transitionReceipt(error.receipt, 'dispatched'), /illegal_receipt_transition/);
});

test('a failed local fill is certain: nothing reached the platform', async () => {
  const { kernel, snapshot } = harness();
  const observation = kernel.observe(snapshot).observation;
  const error = await kernel.execute({ candidate: { kind: 'fill_username', control: snapshot.controls[0] },
    snapshot, observation, expectedPostcondition: null,
    dispatch: async () => { throw new PilotError('page_closed'); } }).then(() => null, thrown => thrown);
  assert.deepEqual(kernel.receipts.map(receipt => receipt.state),
    ['created', 'dispatched', 'certain', 'failed']);
  assert.equal(error.receipt.state, 'failed');
  assert.equal(mayRetry(error.receipt), false);
});


test('the identity_verified postcondition reuses the specialized identity check', async () => {
  const identified = { url: 'https://www.youtube.com/', challengeFrame: false, fingerprint: 'fp-id',
    text: 'Accounts fixture@example.com Switch account Sign out Google Account', controls: [] };
  const snapshot = { url: 'https://www.youtube.com/', challengeFrame: false, fingerprint: 'fp-home',
    text: 'Home', controls: [{ key: 'sig-menu', tag: 'button', type: '', label: 'Account menu', enabled: true }] };
  const { kernel } = harness({ snapshot, live: identified,
    identityVerified: value => verifyIdentity(account, value, site) });
  const observation = kernel.observe(snapshot).observation;
  const outcome = await kernel.execute({ candidate: { kind: 'open_account_menu', control: snapshot.controls[0] },
    snapshot, observation, source: 'jev', expectedPostcondition: { type: 'identity_verified', verifier: 'identity' },
    dispatch: async () => null });

  assert.equal(verifyIdentity(account, identified, site), true, 'the fixture really is the expected identity');
  assert.equal(outcome.postcondition.met, true);
  assert.equal(outcome.receipt.state, 'verified');

  const wrong = { ...identified, text: 'Accounts someone.else@example.com Switch account Sign out' };
  const other = harness({ snapshot, live: wrong, identityVerified: value => verifyIdentity(account, value, site) });
  const failed = await other.kernel.execute({ candidate: { kind: 'open_account_menu', control: snapshot.controls[0] },
    snapshot, observation: other.kernel.observe(snapshot).observation, source: 'jev',
    expectedPostcondition: { type: 'identity_verified', verifier: 'identity', timeoutMs: 500 },
    dispatch: async () => null });
  assert.equal(failed.postcondition.met, false, 'another account never verifies this identity');
});

test('every postcondition type is evaluated against the live page', async () => {
  const probes = { url: async () => 'https://www.youtube.com/watch', text: async () => 'Switch account Sign out',
    fingerprint: async () => 'fp-now', control: async target => (target === 'sig-menu' ? { enabled: false } : null),
    identityVerified: async () => true, verifiers: { quotedTotal: async () => true } };
  const context = { url: 'https://www.youtube.com/', fingerprint: 'fp-before' };
  const cases = [
    { postcondition: { type: 'url_matches', value: 'https://www.youtube.com/watch' }, met: true },
    { postcondition: { type: 'url_matches', value: 'https://www.youtube.com/other' }, met: false },
    { postcondition: { type: 'url_changed' }, met: true },
    { postcondition: { type: 'control_present', signature: 'sig-menu' }, met: true },
    { postcondition: { type: 'control_absent', signature: 'sig-menu' }, met: false },
    { postcondition: { type: 'control_state', signature: 'sig-menu', state: false }, met: true },

    { postcondition: { type: 'visible_text', value: 'Switch account' }, met: true },
    { postcondition: { type: 'page_fingerprint_changed' }, met: true },
    { postcondition: { type: 'identity_verified', verifier: 'identity' }, met: true },
    { postcondition: { type: 'custom_verifier', verifier: 'quotedTotal' }, met: true },
    { postcondition: { type: 'custom_verifier', verifier: 'missingVerifier' }, met: false },
  ];
  for (const item of cases) {
    const clock = { value: 1_000_000 };
    const result = await evaluatePostcondition({ postcondition: { ...item.postcondition, timeoutMs: 500 },
      probe: probes, context, now: () => { clock.value += 5000; return clock.value; }, sleep: async () => {} });
    assert.equal(result.met, item.met, `${item.postcondition.type} (${item.postcondition.verifier || ''})`);
    assert.equal(result.type, item.postcondition.type);
  }
  assert.equal((await evaluatePostcondition({ postcondition: null, probe: probes })).type, null);
});

test('one visible control is not permission: the workflow grants authority, not the page', async () => {
  const snapshot = { url: 'https://www.youtube.com/', text: 'Continue', fingerprint: 'fp-only',
    challengeFrame: false,
    controls: [{ key: 'sig-only', tag: 'button', type: '', label: 'Continue', enabled: true }] };
  const { kernel, calls } = harness({ snapshot, allowedRoles: ['read'] });
  const observation = kernel.observe(snapshot).observation;

  await assert.rejects(kernel.execute({ candidate: { kind: 'submit_login', control: snapshot.controls[0] },
    snapshot, observation, dispatch: async () => { calls.dispatch.push('submit_login'); } }),
  /risk_not_authorized/);
  assert.equal(calls.dispatch.length, 0);
  // A read-only operation is still permitted by the same workflow.
  assert.equal(kernel.plan({ candidate: { kind: 'open_account_menu', control: snapshot.controls[0] },
    snapshot, observation }).role, 'read');
  assert.deepEqual(loginWorkflowRoles, ['read', 'navigate', 'prepare', 'authenticate']);
});

test('a decision made on epoch N fails closed when executed against epoch N+1', async () => {
  const { kernel, calls, snapshot } = harness();
  const decidedOn = kernel.observe(snapshot).observation;
  const live = kernel.observe({ ...snapshot, text: 'a different page' }).observation;
  assert.notEqual(decidedOn.epoch, live.epoch);
  assert.notEqual(decidedOn.fingerprint, live.fingerprint);

  await assert.rejects(kernel.execute({ candidate: { kind: 'submit_login', control: snapshot.controls[2] },
    snapshot, observation: live, decisionObservation: decidedOn, source: 'jev',
    dispatch: async () => { calls.dispatch.push('submit_login'); } }), /stale_observation/);
  assert.equal(calls.dispatch.length, 0, 'a stale epoch is never dispatched');
});

test('epoch-scoped ids only resolve against the epoch that produced them', () => {
  const snapshot = pageFixture();
  const observation = observationFromSnapshot({ snapshot, now: 1000, ttlMs: 5000 });
  assert.deepEqual(observation.controls.map(control => control.id), ['e0', 'e1', 'e2']);
  assert.equal(observation.controls[2].signature, 'sig-submit');
  assert.equal(controlIdFor({ snapshot, observation, control: snapshot.controls[2] }), 'e2');
  assert.equal(controlIdFor({ snapshot, observation, control: { key: 'not-observed' } }), null);
  const later = observationFromSnapshot({ snapshot, now: 2000, ttlMs: 5000 });
  assert.notEqual(later.epoch, observation.epoch, 'a new observation is a new epoch');
});

test('the valueRef vocabulary the model may name holds no secret values', () => {
  assert.deepEqual(modelVisibleValueRefs, ['account_username', 'account_password', 'current_totp',
    'verification_code', 'authorized_shipping_address']);
  const resolver = createValueResolver({ account });
  assert.deepEqual(resolver.refs.filter(ref => modelVisibleValueRefs.includes(ref)), modelVisibleValueRefs);
  assert.equal(findLeakedSecret({ payload: JSON.stringify(modelVisibleValueRefs), secrets: [account.password] }), null);
});

// --- D: real observation epochs on the live path ------------------------------

test('the live observation path emits an epoch-scoped id for every control', () => {
  const snapshot = pageFixture();
  const observation = attachObservation({ snapshot, now: 1000, ttlMs: 5000 });
  assert.equal(snapshot.epoch, observation.epoch);
  assert.deepEqual(snapshot.controls.map(control => control.id), ['e0', 'e1', 'e2']);
  assert.equal(snapshot.controls[2].epoch, observation.epoch);
  assert.equal(snapshot.observation, observation);
  // The kernel reuses the live observation instead of minting another epoch, so
  // the ids the decision quotes belong to the epoch it quotes.
  const { observation: reused } = harness({ snapshot }).kernel.observe(snapshot);
  assert.equal(reused.epoch, observation.epoch);
  assert.deepEqual(reused.controls.map(control => control.id), ['e0', 'e1', 'e2']);
});

test('the same epoch resolves the same control immediately before dispatch', async () => {
  const { kernel, calls, snapshot } = harness();
  const observation = kernel.observe(snapshot).observation;
  const outcome = await kernel.execute({ candidate: { kind: 'fill_username', control: snapshot.controls[0] },
    snapshot, observation, expectedPostcondition: null,
    dispatch: async ({ control, snapshot: live, action }) => {
      calls.dispatch.push({ id: control.id, epoch: control.epoch, live: live === snapshot,
        actionId: action.controlId });
      return null;
    } });
  assert.equal(calls.observed, 1, 'the page was re-read exactly once before dispatch');
  assert.equal(calls.dispatch.length, 1);
  assert.deepEqual({ id: calls.dispatch[0].id, actionId: calls.dispatch[0].actionId, live: calls.dispatch[0].live },
    { id: 'e0', actionId: 'e0', live: true }, 'the LIVE snapshot and control are what get executed');
  assert.equal(typeof calls.dispatch[0].epoch, 'string',
    'the resolved control is bound to the epoch of the page it was read from');
  assert.equal(outcome.receipt.observationEpoch, observation.epoch, 'the receipt records the DECISION epoch');
});

test('an expired observation epoch fails closed', async () => {
  const clock = { value: 1_000_000 };
  const { kernel, calls, snapshot } = harness({ now: () => clock.value });
  const observation = kernel.observe(snapshot).observation;
  clock.value = observation.expiresAt;
  await assert.rejects(kernel.execute({ candidate: { kind: 'fill_username', control: snapshot.controls[0] },
    snapshot, observation, expectedPostcondition: null,
    dispatch: async () => { calls.dispatch.push('fill_username'); } }), /expired_observation/);
  assert.equal(calls.dispatch.length, 0, 'an expired epoch is never dispatched');
});


test('a changed page fails closed before dispatch', async () => {
  const snapshot = pageFixture();
  // The control set is identical but the page text moved on: the decision was
  // taken on a page that no longer exists.
  const movedOn = { ...snapshot, text: 'Sign in (your session is about to expire)' };
  const { kernel, calls } = harness({ snapshot, pages: [movedOn, movedOn] });
  const observation = kernel.observe(snapshot).observation;
  const error = await kernel.execute({ candidate: { kind: 'submit_login', control: snapshot.controls[2] },
    snapshot, observation, source: 'jev',
    dispatch: async () => { calls.dispatch.push('submit_login'); } }).then(() => null, thrown => thrown);

  assert.equal(error.code, 'changed_page');
  assert.equal(calls.dispatch.length, 0);
  assert.equal(error.receipt.state, 'failed', 'the receipt records that nothing was dispatched');
  assert.deepEqual(calls.entries.map(entry => entry.state), ['created', 'failed']);
});

test('a changed control signature fails closed with changed_control', async () => {
  const snapshot = pageFixture();
  const mutated = { ...snapshot, controls: [snapshot.controls[0], snapshot.controls[1],
    { key: 'sig-submit-v2', tag: 'button', type: '', label: 'Next', enabled: true }] };
  const { kernel, calls } = harness({ snapshot, pages: [mutated, mutated] });
  const observation = kernel.observe(snapshot).observation;
  await assert.rejects(kernel.execute({ candidate: { kind: 'submit_login', control: snapshot.controls[2] },
    snapshot, observation, source: 'jev',
    dispatch: async () => { calls.dispatch.push('submit_login'); } }), /changed_control/);
  assert.equal(calls.dispatch.length, 0);
});


test('a removed control fails closed, and a disabled control is not usable', async () => {
  const snapshot = pageFixture();
  const shortened = { ...snapshot, controls: [snapshot.controls[0], snapshot.controls[1]] };
  const removed = harness({ snapshot, pages: [shortened, shortened] });
  await assert.rejects(removed.kernel.execute({ candidate: { kind: 'submit_login',
    control: snapshot.controls[2] }, snapshot, observation: removed.kernel.observe(snapshot).observation,
    dispatch: async () => { removed.calls.dispatch.push('submit_login'); } }), /stale_observation/);
  assert.equal(removed.calls.dispatch.length, 0);

  const disabled = { ...snapshot, controls: [snapshot.controls[0], snapshot.controls[1],
    { key: 'sig-submit', tag: 'button', type: '', label: 'Next', enabled: false }] };
  const unusable = harness({ snapshot, pages: [disabled, disabled] });
  await assert.rejects(unusable.kernel.execute({ candidate: { kind: 'submit_login',
    control: snapshot.controls[2] }, snapshot, observation: unusable.kernel.observe(snapshot).observation,
    dispatch: async () => { unusable.calls.dispatch.push('submit_login'); } }), /control_not_usable/);
  assert.equal(unusable.calls.dispatch.length, 0);
});

test('when the live page cannot be re-read the reference counts as stale', async () => {
  const snapshot = pageFixture();
  const { kernel, calls } = harness({ snapshot });
  kernel.observeImpl = async () => { throw new PilotError('page_closed'); };
  const error = await kernel.execute({ candidate: { kind: 'submit_login', control: snapshot.controls[2] },
    snapshot, observation: kernel.observe(snapshot).observation,
    dispatch: async () => { calls.dispatch.push('submit_login'); } }).then(() => null, thrown => thrown);
  assert.equal(error.code, 'stale_observation');
  assert.equal(error.cause.code, 'page_closed', 'the original failure is retained as a cause');
  assert.equal(calls.dispatch.length, 0);
});

test('a dispatch that cannot show its postcondition is receipted failed, not verified', async () => {
  const { kernel, calls, snapshot } = harness();
  const observation = kernel.observe(snapshot).observation;
  const outcome = await kernel.execute({ candidate: { kind: 'open_account_menu', control: snapshot.controls[2] },
    snapshot, observation, source: 'jev',
    expectedPostcondition: { type: 'control_present', signature: 'sig-never', timeoutMs: 500 },
    dispatch: async () => { calls.dispatch.push('open_account_menu'); return null; } });
  assert.equal(calls.dispatch.length, 1, 'the operation was still dispatched once');
  assert.equal(outcome.postcondition.met, false);
  assert.equal(outcome.receipt.state, 'failed');
  assert.equal(outcome.receipt.postconditionMet, false);
});

test('an ambiguous single-control page cannot become a consequential action', async () => {
  const { kernel, calls } = harness();
  assert.equal(kernel.authorizedRoles().includes('consequential'), false);
  const reachable = Object.keys(operationKinds).map(operation => riskByOperation[operation])
    .filter(risk => risk === 'consequential_external_action');
  assert.deepEqual(reachable, []);
  assert.equal(decisionSourceFor({ method: 'exact-single-match' }), 'deterministic');
  assert.equal(decisionSourceFor({ method: 'typesafe-choice' }), 'jev');
  assert.equal(decisionSourceFor(null), 'jev');
  assert.equal(calls.dispatch.length, 0);
});
