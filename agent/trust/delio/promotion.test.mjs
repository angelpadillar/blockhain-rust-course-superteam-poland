import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { bindReceiptPromotion, evaluatePromotion } from './promotion.mjs';

const actor = { customerId: 'fixture-customer', merchantAccountId: 'fixture-account' };
const promotion = bindReceiptPromotion({ ...actor, code: 'z5913' });
const now = Date.parse('2026-09-19T12:00:00Z');
const cart = { version: 3, lines: [{ productId: 'coffee', quantity: 2 }], itemSubtotalMinor: 15000 };
const customerFacts = { priorCompletedOrders: 0, hasExistingAccount: false };
function quote() {
  return { ...actor, quoteId: 'fixture-quote', version: 3, status: 'verified', currency: 'PLN',
    observedAt: now - 1000, expiresAt: now + 60000, evidenceRefs: [{ id: 'fixture-checkout', observedAt: now - 1500 }],
    lines: [{ productId: 'coffee', quantity: 2, unitPriceMinor: 7500, lineTotalMinor: 15000 }],
    couponResults: [{ code: 'z5913', accepted: true, discountMinor: 7500 }], amounts: { discountMinor: 7500 } };
}
const evaluate = changes => evaluatePromotion({ promotion, actor, now, cart, customerFacts, ...changes });

test('only the exact receipt code binds, and both customer and merchant account must match', () => {
  assert.equal(Object.isFrozen(promotion), true);
  for (const code of ['Z5913', 'z5913 ', 'another']) {
    assert.throws(() => bindReceiptPromotion({ ...actor, code }), { code: 'unsupported_receipt_code' });
  }
  for (const changed of [{ customerId: 'other' }, { merchantAccountId: 'other' }]) {
    assert.throws(() => evaluate({ actor: { ...actor, ...changed } }), { code: 'promotion_account_not_owned' });
  }
});

test('receipt claims never become accepted savings or a guessed Warsaw expiry', () => {
  for (const at of [now, Date.parse('2026-11-18T22:59:59Z'), Date.parse('2026-11-18T23:00:00Z'), Date.parse('2027-01-01T00:00:00Z')]) {
    const result = evaluate({ now: at });
    assert.equal(result.advertisedDiscountMinor, 7500); assert.equal(result.minimumBasketMinor, 15000);
    assert.equal(result.reportedExpiryDate, '2026-11-18'); assert.equal(result.expiryVerified, false);
    assert.equal(result.expiresAt, null); assert.equal(result.expiryTimeZone, null);
    assert.equal(result.merchantAccepted, false); assert.equal(result.discountMinor, 0);
    assert.equal(result.acceptance, 'not_checked'); assert.equal(result.eligibility, 'provisional');
  }
});

test('new legitimate customers can register, existing customers sign in, and phone changes do not establish eligibility', () => {
  assert.equal(evaluate().onboarding, 'register_new_customer');
  const existing = evaluate({ customerFacts: { priorCompletedOrders: 0, hasExistingAccount: true } });
  assert.equal(existing.onboarding, 'sign_in_existing_account'); assert.equal(existing.eligibility, 'provisional');
  const returning = evaluate({ customerFacts: { priorCompletedOrders: 1, hasExistingAccount: true } });
  assert.equal(returning.eligibility, 'conditions_not_met'); assert.ok(returning.eligibilityReasons.includes('prior_completed_order'));
  assert.equal(evaluate({ customerFacts: {} }).eligibility, 'unknown');
  assert.equal(evaluate({ customerFacts: {} }).onboarding, 'verify_account_status');
  assert.throws(() => evaluate({ customerFacts: { newPhoneNumber: true } }), { code: 'invalid_customer_facts' });
});

test('the reported minimum is only a provisional product subtotal check with exclusions left unknown', () => {
  const below = evaluate({ cart: { ...cart, itemSubtotalMinor: 14999 } });
  assert.equal(below.eligibility, 'conditions_not_met'); assert.ok(below.eligibilityReasons.includes('below_reported_minimum'));
  const unknown = evaluate({ cart: { version: cart.version, lines: cart.lines } });
  assert.equal(unknown.eligibility, 'unknown'); assert.equal(unknown.discountMinor, 0);
  assert.ok(evaluate().eligibilityReasons.includes('qualifying_products_not_verified'));
});

test('only current observed checkout acceptance supplies discount, including an amount different from the receipt', () => {
  const observed = quote(); observed.couponResults[0].discountMinor = 6000; observed.amounts.discountMinor = 6000;
  const result = evaluate({ quote: observed });
  assert.equal(result.acceptance, 'merchant_accepted'); assert.equal(result.merchantAccepted, true);
  assert.equal(result.discountMinor, 6000); assert.equal(result.quoteId, observed.quoteId);
  assert.equal(result.eligibility, 'provisional'); assert.equal(result.advertisedDiscountMinor, 7500);
  assert.equal(observed.amounts.discountMinor, 6000);
});

test('estimates, stale cart/time, another owner/code, mismatched quantities or discount and missing evidence cannot report accepted savings', () => {
  for (const mutate of [
    q => { q.status = 'estimate'; }, q => { q.version--; }, q => { q.customerId = 'someone-else'; },
    q => { q.merchantAccountId = 'another-account'; }, q => { q.currency = 'EUR'; },
    q => { q.couponResults[0].code = 'Z5913'; }, q => { q.couponResults.push({ ...q.couponResults[0] }); },
    q => { q.lines[0].quantity++; }, q => { q.expiresAt = now; }, q => { q.observedAt = now + 1; },
    q => { q.evidenceRefs = []; }, q => { q.evidenceRefs[0].observedAt = now + 1; },
    q => { q.amounts.discountMinor--; }, q => { q.couponResults[0].accepted = 'true'; },
  ]) {
    const observed = quote(); mutate(observed);
    const result = evaluate({ quote: observed });
    assert.equal(result.merchantAccepted, false); assert.equal(result.discountMinor, 0);
  }
});

test('a merchant rejection with observed zero discount remains a rejection', () => {
  const observed = quote(); observed.couponResults[0] = { code: 'z5913', accepted: false, discountMinor: 0, reason: 'not_eligible' };
  observed.amounts.discountMinor = 0;
  const result = evaluate({ quote: observed });
  assert.equal(result.acceptance, 'merchant_rejected'); assert.equal(result.discountMinor, 0); assert.equal(result.merchantAccepted, false);
});

test('sanitized provenance distinguishes user report, unmatched ended offer and unknown expiry', async () => {
  const provenance = JSON.parse(await readFile(new URL('./promotion.provenance.json', import.meta.url), 'utf8'));
  assert.equal(provenance.receiptReport.code, 'z5913'); assert.equal(provenance.receiptReport.expiryVerified, false);
  assert.equal(provenance.researchLimits.matchingOfficialTermsFound, false);
  assert.equal(provenance.officialSources[1].appliedToReceipt, false);
  assert.ok(provenance.officialSources.every(source => new URL(source.url).origin === 'https://jush.pl'));
});
