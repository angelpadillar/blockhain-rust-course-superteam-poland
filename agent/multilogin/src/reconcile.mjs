import { requireThat } from './core.mjs';
import { mayRetry, transitionReceipt, recordReconciliation } from './contract.mjs';
import { evaluatePostcondition } from './postcondition.mjs';
import { isInFlight } from './receipts.mjs';

// Restart reconciliation. It is READ-ONLY: it re-attaches the same profile and
// session, re-observes, and then decides whether the action occurred, definitely
// did not occur, or is still uncertain. It never replays anything, and the only
// outcome that may authorize a retry is a proof that the effect did NOT happen.
export const reconciliationOutcomes = ['action_occurred', 'not_occurred', 'still_uncertain'];
export const retryableOutcome = 'not_occurred';
export const reconciliationProbeMs = 500;

export async function reconcileReceipt({ receipt, probe = null, verifyOccurred = {}, verifyNotOccurred = {},
  now = Date.now, sleep = null, pollMs = 250 } = {}) {
  requireThat(receipt?.state, 'invalid_receipt');
  requireThat(isInFlight(receipt), 'receipt_not_in_flight');

  // A receipt that never reached dispatch proves the effect did not occur: the
  // crash happened between persisting it and dispatching.
  if (receipt.state === 'created') {
    return { outcome: 'not_occurred', evidence: 'never_dispatched', receipt };
  }
  requireThat(probe && typeof probe === 'object', 'reconciliation_probe_required');

  const context = { url: receipt.observationUrl ?? null, fingerprint: receipt.observationFingerprint ?? null };
  // 1. A read-only check of what the action promised it would achieve.
  if (receipt.action?.expectedPostcondition) {
    const met = await evaluatePostcondition({
      postcondition: { ...receipt.action.expectedPostcondition, timeoutMs: reconciliationProbeMs },
      probe, context, now, pollMs, ...(sleep ? { sleep } : {}),
    });
    if (met.met) return { outcome: 'action_occurred', evidence: 'postcondition_met', postcondition: met, receipt };
  }
  // 2. A domain verifier that proves the effect is present.
  for (const [name, verify] of Object.entries(verifyOccurred)) {
    if (await verify({ receipt, probe, now })) {
      return { outcome: 'action_occurred', evidence: `verifier:${name}`, receipt };
    }
  }
  // 3. A verifier that proves the effect is absent. Only this may authorize a
  //    retry: "the page looks the same" is not a proof that a website did not
  //    execute the action.
  for (const [name, verify] of Object.entries(verifyNotOccurred)) {
    if (await verify({ receipt, probe, now })) {
      return { outcome: 'not_occurred', evidence: `verifier:${name}`, receipt };
    }
  }
  return { outcome: 'still_uncertain', evidence: 'no_read_only_proof', receipt };
}

// Persist the outcome. A receipt found mid-flight is uncertain by definition, so
// it is marked uncertain before it can be resolved either way.
export async function applyReconciliation({ store, receipt, outcome, evidence = null,
  now = Date.now } = {}) {
  const at = new Date(now()).toISOString();
  let next = receipt.state === 'dispatched'
    ? transitionReceipt(receipt, 'uncertain', { reason: 'restart_reconciliation' }) : receipt;
  if (outcome === 'still_uncertain') {
    // Inconclusive: the effect stays exactly as uncertain as it was, and the
    // attempt is recorded so a later pass does not have to repeat it blindly.
    next = recordReconciliation(next, { at, outcome, evidence });
  } else if (outcome === 'action_occurred') {
    next = transitionReceipt(next, 'verified', { reconciliation: { at, outcome, evidence },
      postconditionMet: true });
  } else {
    next = transitionReceipt(next, 'reconciled_not_occurred', { reconciliation: { at, outcome, evidence } });
  }
  await store.write(next);
  return next;
}

// The restart entry point: reconcile every receipt that may still have an effect
// in flight, attaching the same profile/session read-only for each scope.
export async function reconcileOnRestart({ store, attach = null, probe = null, verifyOccurred = {},
  verifyNotOccurred = {}, now = Date.now, sleep = null, pollMs = 250,
  states = ['created', 'dispatched', 'uncertain'] } = {}) {
  requireThat(store?.write && store?.inFlight, 'receipt_store_required');
  const inFlight = await store.inFlight({ states });
  const results = [];
  for (const receipt of inFlight) {
    // Same profile, same session, read-only observation only.
    const scoped = attach && receipt.scope ? await attach(receipt.scope) : probe;
    const reconciled = await reconcileReceipt({ receipt, probe: scoped, verifyOccurred,
      verifyNotOccurred, now, sleep, pollMs });
    const persisted = await applyReconciliation({ store, receipt, outcome: reconciled.outcome,
      evidence: reconciled.evidence, now });
    results.push({ ...reconciled, persisted, attachedScope: receipt.scope ?? null });
  }
  return {
    outcomes: results.map(result => result.outcome),
    occurred: results.filter(result => result.outcome === 'action_occurred').map(result => result.persisted),
    notOccurred: results.filter(result => result.outcome === 'not_occurred').map(result => result.persisted),
    uncertain: results.filter(result => result.outcome === 'still_uncertain').map(result => result.persisted),
    // Only a read-only proof that the effect did not occur authorizes a retry.
    retryAuthorized: results.filter(result => result.persisted.state === 'reconciled_not_occurred')
      .map(result => result.persisted),
    results,
  };
}

// The idempotency key is our own dedupe mechanism. It never proves that the
// website did not execute the action, so it can never authorize a replay.
export function retryAuthorized(receipt) { return mayRetry(receipt); }
