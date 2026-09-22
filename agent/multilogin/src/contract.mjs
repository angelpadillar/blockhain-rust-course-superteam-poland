import { createHash } from 'node:crypto';
import { requireThat } from './core.mjs';

// ONE browser execution contract. Deterministic adapters, Jev and a frontier
// advisor all return the same BrowserAction; none of them touches the browser.
export const actionKinds = ['click', 'fill', 'submit', 'choose', 'navigate', 'back', 'wait', 'dismiss'];
export const decisionSources = ['deterministic', 'jev', 'frontier', 'operator'];
// Risk is independent of model confidence. Confidence never authorizes.
export const riskClasses = ['read_only', 'reversible_navigation', 'form_preparation',
  'authentication', 'consequential_external_action'];
export const roleForRisk = { read_only: 'read', reversible_navigation: 'navigate',
  form_preparation: 'prepare', authentication: 'authenticate',
  consequential_external_action: 'consequential' };
export const postconditionTypes = ['url_matches', 'url_changed', 'control_present', 'control_absent',
  'control_state', 'visible_text', 'page_fingerprint_changed', 'identity_verified', 'custom_verifier'];
// An uncertain external side effect is never replayed merely because we hold an
// idempotency key: the platform may already have acted.
export const receiptStates = ['created', 'dispatched', 'certain', 'uncertain',
  'reconciled_not_occurred', 'verified', 'failed'];

const controlFields = ['id', 'signature', 'role', 'name', 'enabled', 'visible'];
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

// An observation is a numbered epoch. Control ids such as "e12" are meaningful
// only against the epoch that produced them; they are not globally stable.
export function createObservation({ url, title = null, text = '', controls = [], ttlMs = 15000,
  now = Date.now() } = {}) {
  const parsed = new URL(url);
  requireThat(Number.isInteger(ttlMs) && ttlMs >= 500 && ttlMs <= 60000, 'invalid_observation_ttl');
  const normalised = controls.map(control => {
    for (const field of controlFields) requireThat(control[field] !== undefined, 'invalid_control_shape');
    requireThat(typeof control.signature === 'string' && control.signature.length > 0, 'invalid_control_signature');
    return control;
  });
  const fingerprint = digest([parsed.origin, parsed.pathname, text,
    normalised.map(control => control.signature)]);
  return { epoch: digest([fingerprint, normalised.map(control => control.id), now]).slice(0, 16),
    observedAt: now, expiresAt: now + ttlMs, url: { origin: parsed.origin, pathname: parsed.pathname },
    title, text, fingerprint, controls: normalised };
}

export function observationToken(observation) {
  requireThat(observation?.epoch, 'observation_required');
  return { epoch: observation.epoch, fingerprint: observation.fingerprint, expiresAt: observation.expiresAt };
}

// Epoch + age + fingerprint validation, merging the historical observation-token
// model with the pilot's URL/signature checks. Fails closed with a distinct code.
export function validateObservation({ observation, epoch, fingerprint = null, now = Date.now() } = {}) {
  requireThat(observation?.epoch, 'observation_required');
  requireThat(epoch === observation.epoch, 'stale_observation');
  requireThat(now < observation.expiresAt, 'expired_observation');
  if (fingerprint !== null) requireThat(fingerprint === observation.fingerprint, 'changed_page');
  return true;
}

export function controlById(observation, controlId) {
  requireThat(observation?.controls, 'observation_required');
  return observation.controls.find(control => control.id === controlId) || null;
}

export function buildAction({ kind, controlId = null, valueRef = null, destination = null,
  observationEpoch, idempotencyKey, expectedPostcondition = null, expectedControlSignature = null,
  risk = 'read_only', decisionSource, justification = null } = {}) {
  requireThat(actionKinds.includes(kind), 'unsupported_action_kind');
  requireThat(decisionSources.includes(decisionSource), 'unsupported_decision_source');
  requireThat(riskClasses.includes(risk), 'unsupported_risk_class');
  requireThat(typeof observationEpoch === 'string' && observationEpoch.length > 0, 'observation_epoch_required');
  requireThat(typeof idempotencyKey === 'string' && idempotencyKey.length >= 8, 'invalid_idempotency_key');
  return { kind, controlId, valueRef, destination, observationEpoch, idempotencyKey,
    expectedPostcondition, expectedControlSignature, risk, decisionSource, justification };
}


// Resolve against a live observation: epoch valid, control present, retained
// signature unchanged. A materially changed page returns stale_observation.
export function resolveAction({ action, observation, expectedSignature = null, now = Date.now() } = {}) {
  requireThat(action && typeof action === 'object', 'invalid_action');
  requireThat(actionKinds.includes(action.kind), 'unsupported_action_kind');
  requireThat(decisionSources.includes(action.decisionSource), 'unsupported_decision_source');
  requireThat(riskClasses.includes(action.risk), 'unsupported_risk_class');
  requireThat(action.idempotencyKey, 'idempotency_key_required');
  validateObservation({ observation, epoch: action.observationEpoch, now });
  if (!action.controlId) {
    requireThat(['navigate', 'back', 'wait'].includes(action.kind), 'control_required_for_action');
    return { control: null };
  }
  const control = controlById(observation, action.controlId);
  requireThat(control, 'stale_observation');
  requireThat(control.enabled && control.visible, 'control_not_usable');
  const signature = expectedSignature ?? action.expectedControlSignature ?? control.signature;
  requireThat(control.signature === signature, 'changed_control');
  return { control };
}

// Decision and authorization are separate: authorization is about risk class.
// A consequential action needs its workflow role whatever a model believes.
export function authorizeAction(action, { allowedRoles = [] } = {}) {
  const role = roleForRisk[action.risk];
  requireThat(role, 'unsupported_risk_class');
  requireThat(allowedRoles.includes(role), `risk_not_authorized:${action.risk}`);
  return role;
}

export function validatePostcondition(postcondition) {
  if (postcondition === null || postcondition === undefined) return null;
  requireThat(postcondition && typeof postcondition === 'object', 'invalid_postcondition');
  requireThat(postconditionTypes.includes(postcondition.type), 'unsupported_postcondition');
  const timeout = postcondition.timeoutMs ?? 5000;
  requireThat(Number.isInteger(timeout) && timeout >= 500 && timeout <= 60000, 'invalid_postcondition_timeout');
  if (['url_matches', 'visible_text'].includes(postcondition.type)) {
    requireThat(typeof postcondition.value === 'string', 'invalid_postcondition_value');
  }
  if (['control_present', 'control_absent', 'control_state'].includes(postcondition.type)) {
    requireThat(typeof postcondition.signature === 'string' || typeof postcondition.controlId === 'string',
      'invalid_postcondition_target');
  }
  if (postcondition.type === 'control_state') {
    requireThat(typeof postcondition.state === 'boolean', 'invalid_postcondition_state');
  }
  if (['identity_verified', 'custom_verifier'].includes(postcondition.type)) {
    requireThat(typeof postcondition.verifier === 'string', 'invalid_postcondition_verifier');
  }
  return postcondition;
}

// Receipt written BEFORE dispatch, carrying its decision source.
export function createReceipt({ id, idempotencyKey, action, now = Date.now() } = {}) {
  requireThat(typeof id === 'string' && id.length > 0, 'invalid_receipt_id');
  requireThat(typeof idempotencyKey === 'string' && idempotencyKey.length >= 8, 'invalid_idempotency_key');
  requireThat(action?.decisionSource, 'unsupported_decision_source');
  validatePostcondition(action.expectedPostcondition);
  return { id, idempotencyKey, action, decisionSource: action.decisionSource, risk: action.risk,
    observationEpoch: action.observationEpoch, state: 'created', createdAt: new Date(now).toISOString(),
    dispatchedAt: null, resolvedAt: null, postconditionMet: null, reconciliations: [] };
}

export function transitionReceipt(receipt, state, detail = {}) {
  requireThat(receipt && receiptStates.includes(receipt.state), 'invalid_receipt');
  requireThat(receiptStates.includes(state), 'unknown_receipt_state');
  const allowed = { created: ['dispatched', 'failed'], dispatched: ['certain', 'uncertain'],
    uncertain: ['reconciled_not_occurred', 'verified', 'failed'],
    reconciled_not_occurred: ['dispatched', 'failed'], certain: ['verified', 'failed'],
    verified: [], failed: [] };
  requireThat(allowed[receipt.state].includes(state), `illegal_receipt_transition:${receipt.state}->${state}`);
  const next = { ...receipt, state, ...detail, resolvedAt: new Date().toISOString() };
  if (state === 'dispatched') next.dispatchedAt = next.resolvedAt;
  return next;
}

// Only a read-only reconciliation establishing that the effect did NOT occur
// permits a retry. The historical bridge's stronger rule, kept deliberately.
export function mayRetry(receipt) { return receipt?.state === 'reconciled_not_occurred'; }

// The advisor seam: internal interface first, MCP is a later adapter. Every
// advisor returns a BrowserAction or abstains; none acts on the browser.
export function validateAdvisorResult({ result, permitted, observation, now = Date.now() } = {}) {
  if (result === null || result?.abstain === true) return { abstained: true };
  const action = buildAction(result);
  requireThat(permitted.includes(action.kind), 'advisor_action_not_permitted');
  validatePostcondition(action.expectedPostcondition);
  resolveAction({ action, observation, now });
  return { abstained: false, action };
}
