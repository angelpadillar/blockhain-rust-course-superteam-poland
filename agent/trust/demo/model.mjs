import { randomUUID } from 'node:crypto';
import { appendRecord, quoteHash, verifyEvidence } from '../evidence.mjs';

export const SCENARIOS = ['happy', 'price_increase', 'merchant_mismatch', 'expired', 'replay'];
const merchant = { id: 'paper-harbor', name: 'Paper Harbor' };
const product = { itemId: 'copper-finch-notebook', title: 'Copper Finch Notebook', quantity: 1, unitPriceMinor: 2490 };
const add = (state, record) => { state.chain = appendRecord(state.chain, record); };

export function createDemo({ scenario = 'happy', now = Date.now(), id = randomUUID() } = {}) {
  if (!SCENARIOS.includes(scenario)) throw new Error('invalid_scenario');
  const mandateId = `demo-mandate-${id}`;
  const mandate = { type: 'mandate', at: now, mandateId, currency: 'PLN', maxTotalMinor: 5000,
    expiresAt: now + 20 * 60_000, allowedMerchantIds: [merchant.id] };
  const quote = { type: 'quote', at: now, mandateId, quoteId: `quote-${id}`, merchantId: merchant.id,
    currency: 'PLN', totalMinor: 2990, items: [{ ...product }], feesMinor: 500, expiresAt: now + 10 * 60_000 };
  const state = { version: 1, sessionId: id, scenario, status: 'review', mandate, quote, quoteHash: quoteHash(quote),
    approval: null, execution: null, confirmation: null, rejection: null, observedQuote: null, chain: [],
    createdAt: now, clockOffsetMs: scenario === 'expired' ? 11 * 60_000 : 0, sequence: 0,
    scope: 'Local simulated trust demonstration. No payment, wallet signing, delivery, or on-chain deployment.' };
  add(state, mandate); add(state, quote);
  return state;
}

function reject(state, reason, now) {
  const record = { type: 'rejection', at: now, mandateId: state.mandate.mandateId,
    quoteId: state.quote.quoteId, rejectionId: `reject-${state.sessionId}-${++state.sequence}`, reason };
  add(state, record); state.rejection = record; state.status = 'rejected';
  return { ok: false, code: reason, state };
}

function mandateMatches(state, quote) {
  return quote.mandateId === state.mandate.mandateId && quote.currency === state.mandate.currency
    && state.mandate.allowedMerchantIds.includes(quote.merchantId)
    && quote.items.length === 1 && quote.items[0].itemId === product.itemId
    && quote.items[0].title === product.title && quote.items[0].quantity === product.quantity
    && quote.totalMinor <= state.mandate.maxTotalMinor;
}

// Pure state transition; server serializes and persists the returned chain before
// exposing it. The only execution below is a fictional local receipt.
export function transition(original, action, payload = {}, realNow = Date.now()) {
  const state = structuredClone(original), now = realNow + state.clockOffsetMs;
  if (!['approve', 'execute'].includes(action)) return reject(state, 'unsupported_action', now);
  if (state.execution) return reject(state, 'approval_already_consumed', now);
  if (state.rejection) return reject(state, 'review_required_after_rejection', now);
  if (now >= state.quote.expiresAt || now >= state.mandate.expiresAt) return reject(state, 'quote_expired', now);
  if (!mandateMatches(state, state.quote)) return reject(state, 'mandate_mismatch', now);
  if (action === 'approve') {
    if (state.approval) return reject(state, 'approval_already_exists', now);
    if (payload.quoteHash !== state.quoteHash || quoteHash(state.quote) !== state.quoteHash) return reject(state, 'quote_hash_mismatch', now);
    state.approval = { type: 'approval', at: now, mandateId: state.mandate.mandateId, quoteId: state.quote.quoteId,
      quoteHash: state.quoteHash, approvalId: `approval-${state.sessionId}`, decision: 'approved' };
    add(state, state.approval); state.status = 'approved';
    return { ok: true, code: 'approved', state };
  }
  if (!state.approval) return reject(state, 'approval_required', now);
  const observed = structuredClone(state.quote);
  if (state.scenario === 'price_increase') { observed.totalMinor += 600; observed.feesMinor += 600; }
  if (state.scenario === 'merchant_mismatch') observed.merchantId = 'different-merchant';
  state.observedQuote = observed;
  if (!mandateMatches(state, observed)) return reject(state, 'merchant_or_item_mismatch', now);
  if (quoteHash(observed) !== state.approval.quoteHash) return reject(state, 'price_or_quote_changed', now);
  state.execution = { type: 'execution', at: now, mandateId: state.mandate.mandateId, quoteId: state.quote.quoteId,
    quoteHash: state.quoteHash, approvalId: state.approval.approvalId,
    executionId: `execution-${state.sessionId}`, mode: 'simulated' };
  add(state, state.execution);
  state.confirmation = { type: 'confirmation', at: now, mandateId: state.mandate.mandateId, quoteId: state.quote.quoteId,
    quoteHash: state.quoteHash, approvalId: state.approval.approvalId, executionId: state.execution.executionId,
    confirmationId: `confirmation-${state.sessionId}`, merchantId: state.quote.merchantId,
    orderId: `SIM-${state.sessionId.slice(0, 8).toUpperCase()}`, currency: state.quote.currency,
    totalMinor: state.quote.totalMinor, mode: 'simulated' };
  add(state, state.confirmation); state.status = 'confirmed';
  return { ok: true, code: 'simulated_confirmation', state };
}

export function publicState(state, realNow = Date.now()) {
  return { ...structuredClone(state), now: realNow + state.clockOffsetMs,
    merchantName: merchant.name, recipient: 'Alex · welcome gift',
    verification: verifyEvidence({ chain: state.chain, requireBoundaryEvidence: true }) };
}
