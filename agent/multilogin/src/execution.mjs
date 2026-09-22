import { randomUUID } from 'node:crypto';
import { PilotError, requireThat } from './core.mjs';
import { buildAction, authorizeAction, resolveAction, validateObservation, createReceipt,
  transitionReceipt, roleForRisk, riskClasses } from './contract.mjs';
import { observationFromSnapshot, controlIdFor, pageSignature } from './observation.mjs';
import { evaluatePostcondition } from './postcondition.mjs';
import { valueRefForOperation } from './secrets.mjs';

// ONE execution path. A deterministic decision and a Jev decision both produce
// the same BrowserAction, which is authorized against the WORKFLOW's roles,
// validated against the decision's observation epoch, receipted BEFORE dispatch,
// dispatched by the existing executor, then checked against its postcondition.
//
// Nothing in this module touches Playwright: `dispatch` is the existing
// executor, so there is exactly one place where a browser operation happens.

// The workflow vocabulary -> the small shared browser contract.
export const operationKinds = {
  fill_username: 'fill', fill_password: 'fill', fill_recovery_email: 'fill', fill_totp: 'fill',
  fill_verification_code: 'fill',
  submit_login: 'submit', choose_totp: 'choose', try_another_way: 'click', open_login: 'click',
  dismiss_cookies: 'dismiss', open_account_menu: 'click', open_switch_account: 'click',
  retry_observation: 'wait', wait: 'wait', navigate_home: 'navigate',
  reopen_account_menu: 'click', dismiss_onboarding: 'dismiss', escalate_security_checkpoint: 'wait',
  complete: 'wait',
  // The external surface (MCP) uses the same kernel with generic, OBSERVED
  // operations: they carry no selector, the control still comes from an epoch.
  click_observed: 'click', type_observed: 'fill', navigate_observed: 'navigate',
};

// Risk belongs to the OPERATION, never to a model's confidence and never to how
// many controls happen to be visible.
export const riskByOperation = {
  fill_username: 'form_preparation', fill_password: 'form_preparation',
  fill_recovery_email: 'form_preparation', fill_totp: 'form_preparation',
  fill_verification_code: 'form_preparation',
  submit_login: 'authentication',
  choose_totp: 'form_preparation', try_another_way: 'reversible_navigation', open_login: 'reversible_navigation',
  dismiss_cookies: 'reversible_navigation', open_account_menu: 'read_only', open_switch_account: 'read_only',
  retry_observation: 'read_only', wait: 'read_only', navigate_home: 'reversible_navigation',
  reopen_account_menu: 'read_only', dismiss_onboarding: 'reversible_navigation',
  escalate_security_checkpoint: 'read_only', complete: 'read_only',
  click_observed: 'reversible_navigation', type_observed: 'form_preparation',
  navigate_observed: 'reversible_navigation',
};

// Authorization is granted by the WORKFLOW, not by Jev, not by a frontier model
// and not by an operator's screenshot. A login workflow may authenticate; it may
// never perform a consequential external action. A recovery episode may not even
// authenticate - it only resumes navigation and prepares state.
export const loginWorkflowRoles = ['read', 'navigate', 'prepare', 'authenticate'];
export const recoveryWorkflowRoles = ['read', 'navigate', 'prepare'];
export const workflowRoles = { login: loginWorkflowRoles, recovery: recoveryWorkflowRoles };

// A dispatch that may have reached the platform is uncertain when it fails, even
// if the local call reported an error. Local, repeatable edits are certain.
const uncertainOnFailure = new Set(['submit_login', 'dismiss_cookies', 'open_login', 'try_another_way',
  'choose_totp', 'open_account_menu', 'open_switch_account', 'reopen_account_menu', 'dismiss_onboarding']);

// What a visible browser action must be able to show afterwards. Reads, waits and
// navigation have their own error handling in the executor and declare none.
export const defaultPostconditions = {
  submit_login: { type: 'page_fingerprint_changed', timeoutMs: 10000 },
  dismiss_cookies: { type: 'page_fingerprint_changed', timeoutMs: 10000 },
  open_login: { type: 'page_fingerprint_changed', timeoutMs: 10000 },
  try_another_way: { type: 'page_fingerprint_changed', timeoutMs: 10000 },
  choose_totp: { type: 'page_fingerprint_changed', timeoutMs: 10000 },
  open_account_menu: { type: 'page_fingerprint_changed', timeoutMs: 10000 },
  open_switch_account: { type: 'page_fingerprint_changed', timeoutMs: 10000 },
  reopen_account_menu: { type: 'page_fingerprint_changed', timeoutMs: 2000 },
  dismiss_onboarding: { type: 'page_fingerprint_changed', timeoutMs: 2000 },
  click_observed: { type: 'page_fingerprint_changed', timeoutMs: 2000 },
};

// A decision taken by the exact single-permitted-action shortcut never called a
// model, so it is deterministic by construction.
export function decisionSourceFor(decision) {
  return decision?.method === 'exact-single-match' ? 'deterministic' : 'jev';
}

// A model's own risk claim can never lower or raise the operation's class.
export function riskForOperation(operation, claimed = null) {
  const risk = riskByOperation[operation];
  requireThat(risk, 'unsupported_action');
  if (claimed !== null && claimed !== undefined) requireThat(riskClasses.includes(claimed), 'unsupported_risk_class');
  return risk;
}

export class BrowserExecutionKernel {
  constructor({ browser = null, account, site = null, workflow = 'login', allowedRoles = null,
    receipts = null, journal = null, ttlMs = 15000, runId = 'session', now = Date.now,
    observe = null, identityVerified = null, verifiers = {}, scope = null, screenshot = null } = {}) {
    requireThat(account && typeof account === 'object', 'account_required');
    requireThat(typeof runId === 'string' && runId.length >= 4, 'invalid_run_id');
    requireThat(workflowRoles[workflow] || Array.isArray(allowedRoles), 'unknown_workflow');
    this.browser = browser; this.account = account; this.site = site;
    this.workflow = workflow;
    // Roles come from the workflow configuration and nowhere else.
    this.allowedRoles = allowedRoles ? [...allowedRoles] : [...workflowRoles[workflow]];
    this.store = receipts || null; this.journal = journal;
    // Which profile/session this run belongs to, so a restart can attach the same
    // one read-only when it reconciles an in-flight receipt.
    this.scope = scope;
    this.ttlMs = ttlMs; this.runId = runId; this.now = now;
    this.observeImpl = observe || (browser ? () => browser.observe() : null);
    this.identityVerified = identityVerified; this.verifiers = verifiers;
    this.screenshot = screenshot;
    this.sequence = 0; this.receipts = []; this.storeFailures = []; this.journalFailures = [];
  }

  // Only operations the workflow's roles can authorize are ever offered.
  permittedOperations() {
    return Object.keys(operationKinds)
      .filter(operation => this.allowedRoles.includes(roleForRisk[riskByOperation[operation]]));
  }

  authorizedRoles() { return [...this.allowedRoles]; }

  nextKey(operation) { this.sequence++; return `${this.runId}-s${this.sequence}-${operation}`; }

  // One screenshot for an external caller, taken against this epoch only. The
  // injected source owns the credential-entry rule.
  async screenshotFor({ observation = null } = {}) {
    requireThat(observation?.epoch, 'observation_required');
    requireThat(this.screenshot, 'screenshot_source_required');
    const shot = await this.screenshot({ observation });
    return { ...shot, epoch: observation.epoch };
  }

  // The live browser path already emitted the contract (attachObservation), so
  // its epoch-scoped ids are reused verbatim: the decision epoch and the ids the
  // decision quotes are the same observation.
  observe(snapshot) {
    requireThat(snapshot, 'observation_required');
    const own = snapshot.observation;
    if (own?.epoch && own.epoch === snapshot.epoch) return { snapshot, observation: own };
    return { snapshot, observation: observationFromSnapshot({ snapshot, ttlMs: this.ttlMs, now: this.now() }) };
  }

  // Immediately before dispatch: the decision's own epoch is still valid and
  // unexpired, and the page is re-read so the control is re-resolved instead of
  // acting on a stale reference. Anything materially changed fails closed with
  // stale_observation / expired_observation / changed_control / changed_page /
  // control_not_usable, and the caller re-observes.
  //
  // "Materially changed" is the page IDENTITY (document + control set/order), not
  // the visible text: on a live dynamic page the text keeps moving (recommendations,
  // timestamps, animations) while the control the decision named is still the same
  // control, in the same enabled state, on the same page.
  async refresh({ action, decided, control }) {
    validateObservation({ observation: decided, epoch: action.observationEpoch, now: this.now() });
    if (!action.controlId) return { snapshot: null, observation: null, control: null };
    requireThat(this.observeImpl, 'observation_source_required');
    let liveSnapshot;
    try { liveSnapshot = await this.observeImpl(); }
    catch (cause) {
      // Without a fresh reading we cannot confirm the reference, so it counts as
      // stale rather than being acted on.
      const stale = new PilotError('stale_observation');
      stale.cause = cause;
      throw stale;
    }
    const live = this.observe(liveSnapshot).observation;
    const resolved = resolveLiveControl({ action, live, liveSnapshot });
    // The document or the control set moved on since the decision, so the
    // decision is not acted on.
    requireThat(pageSignature(live) === pageSignature(decided), 'changed_page');
    return { snapshot: liveSnapshot, observation: live, control: resolved };
  }

  // Build, authorize and resolve a candidate. Separate from execute() so an
  // advisor can be validated by exactly the same rules before anything runs.
  // `decisionObservation` is the epoch the decision was actually taken on. When
  // it differs from `observation`, the decision is stale and resolution fails
  // closed: a screenshot decision from epoch N can never run against epoch N+1.
  plan({ candidate, snapshot, observation, decisionObservation = null, source = 'deterministic',
    justification = null, expectedPostcondition } = {}) {
    requireThat(candidate?.kind, 'invalid_action');
    requireThat(observation?.epoch, 'observation_required');
    const decided = decisionObservation || observation;
    requireThat(decided?.epoch, 'observation_required');
    const operation = candidate.kind;
    const kind = operationKinds[operation];
    requireThat(kind, 'unsupported_action');
    // Navigation is only ever to an origin this site already allows. An operation
    // without a destination (navigate_home) uses the site's own home url, which is
    // already an allowed origin.
    if (kind === 'navigate' && candidate.destination) {
      const origin = new URL(candidate.destination).origin;
      requireThat(this.site?.origins?.includes(origin), 'unexpected_navigation_destination');
    }
    const control = candidate.control || null;
    const controlId = control ? controlIdFor({ snapshot, observation, control }) : null;
    requireThat(!control || controlId, 'control_not_observed');
    const action = buildAction({
      kind, operation, controlId,
      valueRef: candidate.valueRef ?? valueRefForOperation[operation] ?? null,
      observationEpoch: decided.epoch,
      destination: candidate.destination ?? null,
      idempotencyKey: this.nextKey(operation),
      expectedPostcondition: expectedPostcondition === undefined
        ? (defaultPostconditions[operation] ?? null) : expectedPostcondition,
      expectedControlSignature: control?.key ?? null,
      risk: riskForOperation(operation, candidate.claimedRisk ?? null),
      decisionSource: source,
      justification: justification ?? candidate.justification ?? null,
    });
    // Authorization first (the workflow's roles), then freshness (this epoch).
    const role = authorizeAction(action, { allowedRoles: this.allowedRoles });
    resolveAction({ action, observation, now: this.now() });
    return { action, role, control, controlId };
  }

  // A probe over the live page for postcondition evaluation. The ambient
  // snapshot (already observed by the executor) is used for the first attempt so
  // a proven change costs no extra browser round-trip; later attempts re-read.
  probeFor({ ambientSnapshot = null } = {}) {
    const source = this.observeImpl;
    let cache = null; let ambient = ambientSnapshot;
    const load = async () => {
      if (cache) return cache;
      if (ambient && Array.isArray(ambient.controls)) { cache = ambient; return cache; }
      requireThat(source, 'observation_source_required');
      cache = await source();
      return cache;
    };
    return {
      refresh: () => { cache = null; ambient = null; },
      url: async () => { const parsed = new URL((await load()).url); return `${parsed.origin}${parsed.pathname}`; },
      text: async () => (await load()).text,
      fingerprint: async () => observationFromSnapshot({ snapshot: await load(), ttlMs: this.ttlMs,
        now: this.now() }).fingerprint,
      control: async target => {
        const control = (await load()).controls.find(item => item.key === target || item.id === target) || null;
        return control ? { signature: control.key, enabled: control.enabled === true } : null;
      },
      identityVerified: async () => (this.identityVerified ? (await this.identityVerified(await load())) === true : false),
      verifiers: this.verifiers,
    };
  }

  async execute({ candidate, snapshot, observation, decisionObservation = null,
    source = 'deterministic', dispatch = null, ambientSnapshot = null, justification = null,
    expectedPostcondition } = {}) {
    const { action, role, control } = this.plan({ candidate, snapshot, observation, decisionObservation,
      source, justification, expectedPostcondition });
    const decided = decisionObservation || observation;
    // Persisted BEFORE dispatch: a crash mid-flight leaves evidence that the
    // action may already have been sent.
    const receipt = createReceipt({ id: randomUUID(), idempotencyKey: action.idempotencyKey, action,
      now: this.now(), observationFingerprint: decided.fingerprint,
      observationUrl: `${decided.url.origin}${decided.url.pathname}`, scope: this.scope });
    const created = await this.record(receipt);
    // Freshness immediately before dispatch: the page is re-read and the control
    // re-resolved, so execution never acts on a stale reference.
    let fresh;
    try { fresh = await this.refresh({ action, decided, control }); }
    catch (error) {
      const failed = await this.transition(created, 'failed',
        { reason: error?.code || 'stale_reference', postconditionMet: false });
      error.receipt = failed;
      throw error;
    }
    const dispatched = await this.transition(created, 'dispatched');
    let effect = null;
    try {
      effect = dispatch ? await dispatch({ action, candidate, observation: fresh.observation || observation,
        control: fresh.control || control, snapshot: fresh.snapshot || snapshot }) : null;
    } catch (error) {
      // A dispatch that may have reached the platform is uncertain, and an
      // uncertain action is never replayed on the strength of its key.
      const state = uncertainOnFailure.has(action.operation) ? 'uncertain' : 'certain';
      const settled = await this.transition(await this.transition(dispatched, state), 'failed',
        { reason: error?.code || error?.name || 'dispatch_failed', postconditionMet: false });
      error.receipt = settled;
      throw error;
    }
    const postcondition = await evaluatePostcondition({
      postcondition: action.expectedPostcondition,
      probe: this.probeFor({ ambientSnapshot: ambientSnapshotOf(effect) || ambientSnapshot }),
      context: { url: `${decided.url.origin}${decided.url.pathname}`, fingerprint: decided.fingerprint },
      now: this.now,
    });
    const certain = await this.transition(dispatched, 'certain');
    const settled = await this.transition(certain, postcondition.met ? 'verified' : 'failed',
      { postconditionMet: postcondition.met, postconditionType: postcondition.type,
        postconditionDetail: postcondition.detail });
    return { action, role, control, effect, postcondition, receipt: settled };
  }

  async record(receipt) {
    this.receipts.push(receipt);
    if (this.store) {
      try { await this.store.write(receipt); }
      catch { this.storeFailures.push('receipt_store_unavailable'); }
    }
    await this.journalSafely(receipt);
    return receipt;
  }

  async transition(receipt, state, detail = {}) {
    return this.record(transitionReceipt(receipt, state, detail));
  }

  // Journal entries carry metadata only: never a resolved secret, never page
  // text, never a screenshot.
  async journalSafely(receipt) {
    if (!this.journal) return;
    try { await this.journal({ event: 'receipt', ...receiptSummary(receipt) }); }
    catch { this.journalFailures.push('receipt_journal_unavailable'); }
  }
}

// Re-resolve the control against the freshly observed page. The contract's own
// resolver is reused, retargeted at the live epoch: the control must still be
// present at the same id, still carry the retained signature, and still be
// visible and enabled. The LIVE handle is what gets executed.
function resolveLiveControl({ action, live, liveSnapshot }) {
  const check = { ...action, observationEpoch: live.epoch };
  resolveAction({ action: check, observation: live });
  const index = live.controls.findIndex(control => control.id === check.controlId);
  requireThat(index >= 0 && liveSnapshot.controls[index], 'stale_observation');
  return { ...liveSnapshot.controls[index], id: check.controlId, epoch: live.epoch };
}

// A dispatch may hand back the snapshot it already observed (waitForChange does),
// which saves a browser round-trip when checking the postcondition.
function ambientSnapshotOf(effect) {
  if (!effect || typeof effect !== 'object') return null;
  if (Array.isArray(effect.controls) && effect.url) return effect;
  if (Array.isArray(effect.ambientSnapshot?.controls)) return effect.ambientSnapshot;
  return null;
}

export function receiptSummary(receipt) {
  return { receiptId: receipt.id, idempotencyKey: receipt.idempotencyKey, state: receipt.state,
    operation: receipt.action?.operation ?? null, kind: receipt.action?.kind ?? null,
    risk: receipt.risk, decisionSource: receipt.decisionSource, observationEpoch: receipt.observationEpoch,
    valueRef: receipt.action?.valueRef ?? null, postconditionMet: receipt.postconditionMet ?? null };
}

