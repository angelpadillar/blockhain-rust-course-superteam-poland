import test from 'node:test';
import assert from 'node:assert/strict';
import { createObservation, observationToken, validateObservation, buildAction, resolveAction,
  authorizeAction, validatePostcondition, createReceipt, transitionReceipt, mayRetry,
  validateAdvisorResult, riskClasses } from '../src/contract.mjs';

const control = (id, signature, extra = {}) => ({ id, signature, role: 'button', name: `name-${id}`,
  enabled: true, visible: true, ...extra });
const page = (controls, { now = 1000, text = 'page text' } = {}) => createObservation({
  url: 'https://www.youtube.com/watch?v=1', text, controls, now, ttlMs: 5000 });

const fresh = page([control('e1', 'sig-a'), control('e2', 'sig-b')], { now: 1000 });
const action = (overrides = {}) => buildAction({ kind: 'click', controlId: 'e1', observationEpoch: fresh.epoch,
  idempotencyKey: 'job-1-step-1', decisionSource: 'deterministic', risk: 'read_only', ...overrides });

test('a same-epoch action against an unchanged control resolves', () => {
  const { control: resolved } = resolveAction({ action: action(), observation: fresh, now: 2000 });
  assert.equal(resolved.id, 'e1');
});

test('an expired observation epoch fails closed', () => {
  assert.throws(() => resolveAction({ action: action(), observation: fresh, now: 12000 }), /expired_observation/);
});

test('an action from an older epoch fails closed with stale_observation', () => {
  const later = page([control('e1', 'sig-a')], { now: 2000, text: 'page text' });
  assert.notEqual(later.epoch, fresh.epoch);
  assert.throws(() => resolveAction({ action: action(), observation: later, now: 2500 }), /stale_observation/);
});

test('a changed control signature fails closed with changed_control', () => {
  const mutated = page([control('e1', 'sig-CHANGED')], { now: 1000 });
  const carried = action({ expectedControlSignature: 'sig-a', observationEpoch: mutated.epoch });
  assert.throws(() => resolveAction({ action: carried, observation: mutated, now: 2000 }), /changed_control/);
});

test('a stale screenshot is rejected by its observation token', () => {
  const token = observationToken(fresh);
  const changed = page([control('e1', 'sig-a'), control('e2', 'sig-b')], { now: 1000, text: 'different text' });
  assert.throws(() => validateObservation({ observation: changed, epoch: token.epoch, fingerprint: token.fingerprint }),
    /stale_observation/);
  assert.throws(() => validateObservation({ observation: fresh, epoch: fresh.epoch,
    fingerprint: changed.fingerprint, now: 2000 }), /changed_page/);
});

test('one control is not authority: risk must be authorized independently of confidence', () => {
  assert.equal(authorizeAction(action(), { allowedRoles: ['read'] }), 'read');
  const purchase = action({ risk: 'consequential_external_action' });
  assert.throws(() => authorizeAction(purchase, { allowedRoles: ['read', 'prepare', 'authenticate', 'navigate'] }),
    /risk_not_authorized/);
  assert.equal(authorizeAction(purchase, { allowedRoles: ['consequential'] }), 'consequential');
  for (const risk of riskClasses) {
    assert.ok(buildAction({ kind: 'click', controlId: 'e1', observationEpoch: fresh.epoch,
      idempotencyKey: 'k-12345678', decisionSource: 'jev', risk }));
  }
});

test('postconditions are validated as a union, not only text', () => {
  for (const postcondition of [
    { type: 'url_changed' }, { type: 'url_matches', value: 'https://www.youtube.com/' },
    { type: 'control_present', signature: 'sig-password' }, { type: 'control_absent', signature: 'sig-skip' },
    { type: 'control_state', signature: 'sig-toggle', state: false },
    { type: 'page_fingerprint_changed' }, { type: 'identity_verified', verifier: 'identity' },
    { type: 'custom_verifier', verifier: 'quotedTotal' },
  ]) assert.deepEqual(validatePostcondition(postcondition), postcondition);
  assert.throws(() => validatePostcondition({ type: 'visible_text' }), /invalid_postcondition_value/);
  assert.throws(() => validatePostcondition({ type: 'control_state', signature: 's' }), /invalid_postcondition_state/);
  assert.throws(() => validatePostcondition({ type: 'made_up' }), /unsupported_postcondition/);
  assert.throws(() => validatePostcondition({ type: 'url_changed', timeoutMs: 999999 }),
    /invalid_postcondition_timeout/);
});

test('a receipt is created before dispatch and never replays an uncertain effect', () => {
  const receipt = createReceipt({ id: 'r1', idempotencyKey: 'job-1-step-1', action: action() });
  assert.equal(receipt.state, 'created');
  assert.equal(receipt.decisionSource, 'deterministic');

  const uncertain = transitionReceipt(transitionReceipt(receipt, 'dispatched'), 'uncertain');
  assert.equal(mayRetry(uncertain), false, 'an uncertain effect is not retried on the key alone');
  assert.throws(() => transitionReceipt(uncertain, 'dispatched'), /illegal_receipt_transition/);

  const reconciled = transitionReceipt(uncertain, 'reconciled_not_occurred');
  assert.equal(mayRetry(reconciled), true, 'only a reconciliation proving it did not occur permits a retry');

  const certain = transitionReceipt(transitionReceipt(receipt, 'dispatched'), 'certain');
  assert.equal(transitionReceipt(certain, 'verified').state, 'verified');
  assert.throws(() => transitionReceipt(certain, 'dispatched'), /illegal_receipt_transition/);
});

test('the advisor seam returns a validated action or abstains, and never acts', () => {
  const permitted = ['click', 'fill'];
  const advised = validateAdvisorResult({ result: { kind: 'click', controlId: 'e2', observationEpoch: fresh.epoch,
    idempotencyKey: 'adv-12345678', decisionSource: 'frontier', risk: 'read_only' },
  permitted, observation: fresh, now: 2000 });
  assert.equal(advised.abstained, false);
  assert.equal(advised.action.controlId, 'e2');
  assert.deepEqual(validateAdvisorResult({ result: { abstain: true }, permitted, observation: fresh }),
    { abstained: true });
  assert.throws(() => validateAdvisorResult({ result: { kind: 'navigate', observationEpoch: fresh.epoch,
    idempotencyKey: 'adv-12345678', decisionSource: 'frontier' }, permitted, observation: fresh, now: 2000 }),
  /advisor_action_not_permitted/);
  assert.throws(() => validateAdvisorResult({ result: { kind: 'click', controlId: 'e9', observationEpoch: fresh.epoch,
    idempotencyKey: 'adv-12345678', decisionSource: 'frontier' }, permitted, observation: fresh, now: 2000 }),
  /stale_observation/);
});

