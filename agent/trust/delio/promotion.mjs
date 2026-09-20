// This module only assesses server-owned evidence. It never registers accounts,
// submits a coupon, edits a cart, computes checkout totals, or places an order.
// The receipt's 75/150 offer has not been matched to published official terms.
const CODE = 'z5913';
const TERMS_URL = 'https://jush.pl/regulaminy/';
const RECEIPT = Object.freeze({ currency: 'PLN', advertisedDiscountMinor: 7500,
  minimumBasketMinor: 15000, firstOrderOnly: true,
  reportedExpiryDate: '2026-11-18', expiryVerified: false, expiresAt: null,
  expiryTimeZone: null, termsStatus: 'matching_official_terms_not_found' });
const integer = value => Number.isSafeInteger(value) && value >= 0 && !Object.is(value, -0);
const plain = value => value && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const id = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
const fail = code => { throw Object.assign(new TypeError(code), { code }); };
function owner(value) {
  if (!plain(value) || !id(value.customerId) || !id(value.merchantAccountId)) fail('invalid_promotion_owner');
}
function sameOwner(left, right) {
  return left.customerId === right.customerId && left.merchantAccountId === right.merchantAccountId;
}
function cartLines(value) {
  if (!Array.isArray(value) || value.length > 50) return null;
  const seen = new Set();
  for (const line of value) {
    if (!plain(line) || !id(line.productId) || !integer(line.quantity) || line.quantity === 0 || seen.has(line.productId)) return null;
    seen.add(line.productId);
  }
  return value.map(({ productId, quantity }) => [productId, quantity]).sort(([a], [b]) => a.localeCompare(b));
}

/** Bind only in the server account registry; never accept this binding from HTTP input. */
export function bindReceiptPromotion({ customerId, merchantAccountId, code } = {}) {
  owner({ customerId, merchantAccountId });
  if (code !== CODE) fail('unsupported_receipt_code');
  return Object.freeze({ customerId, merchantAccountId, code });
}

function checkoutEvidence(promotion, cart, quote, now) {
  const result = (acceptance, detail = {}) => ({ acceptance, merchantAccepted: acceptance === 'merchant_accepted',
    discountMinor: 0, quoteId: null, observedAt: null, ...detail });
  if (!quote) return result('not_checked');
  if (!plain(quote) || quote.status !== 'verified') return result('unverified_evidence');
  if (!sameOwner(promotion, quote) || quote.currency !== 'PLN' || !id(quote.quoteId)) return result('mismatched_evidence');
  if (!integer(quote.version) || quote.version !== cart?.version) return result('stale_evidence');
  const expectedLines = cartLines(cart?.lines), observedLines = cartLines(quote.lines);
  if (!expectedLines || !observedLines || JSON.stringify(expectedLines) !== JSON.stringify(observedLines)) return result('mismatched_evidence');
  if (!integer(quote.observedAt) || !integer(quote.expiresAt) || quote.observedAt > now
      || quote.expiresAt <= now || quote.expiresAt <= quote.observedAt) return result('stale_evidence');
  if (!Array.isArray(quote.evidenceRefs) || quote.evidenceRefs.length === 0
      || quote.evidenceRefs.some(ref => !plain(ref) || !id(ref.id) || !integer(ref.observedAt)
        || ref.observedAt > now)) return result('unverified_evidence');
  if (!Array.isArray(quote.couponResults) || quote.couponResults.length !== 1) return result('unverified_evidence');
  const coupon = quote.couponResults[0];
  if (!plain(coupon) || coupon.code !== promotion.code || typeof coupon.accepted !== 'boolean'
      || !integer(coupon.discountMinor) || !integer(quote.amounts?.discountMinor)
      || coupon.discountMinor !== quote.amounts.discountMinor
      || (!coupon.accepted && coupon.discountMinor !== 0)) return result('mismatched_evidence');
  // Observed discount is authoritative, even if it differs from the receipt claim.
  // Do not subtract the advertised 7500 from anything or add this amount twice.
  return result(coupon.accepted ? 'merchant_accepted' : 'merchant_rejected', {
    discountMinor: coupon.discountMinor, quoteId: quote.quoteId, observedAt: quote.observedAt,
  });
}

/**
 * actor is authenticated externally; promotion/customerFacts/cart/quote must be
 * server-owned. priorCompletedOrders covers this person across the shared Jush/
 * Delio platform, not just a newly supplied phone number or a fresh local ID.
 * Its absence is unknown; a fresh phone number is not an eligibility signal.
 * cart.itemSubtotalMinor is only a necessary threshold check: qualifying product
 * exclusions and this receipt's exact terms remain unverified. Legitimate new
 * customers may register; existing customers should use their existing account.
 * This is a pilot one-account-per-person policy, not a newly inferred promo term.
 */
export function evaluatePromotion({ promotion, actor, customerFacts = {}, cart = null, quote = null, now = Date.now() } = {}) {
  owner(promotion); owner(actor);
  if (promotion.code !== CODE) fail('unsupported_receipt_code');
  if (!sameOwner(promotion, actor)) fail('promotion_account_not_owned');
  if (!integer(now)) fail('invalid_promotion_time');
  if (!plain(customerFacts) || Object.keys(customerFacts).some(key => !['priorCompletedOrders', 'hasExistingAccount'].includes(key))
      || (customerFacts.priorCompletedOrders != null && !integer(customerFacts.priorCompletedOrders))
      || (customerFacts.hasExistingAccount != null && typeof customerFacts.hasExistingAccount !== 'boolean')) fail('invalid_customer_facts');
  if (cart !== null && (!plain(cart) || !integer(cart.version) || !cartLines(cart.lines)
      || (cart.itemSubtotalMinor != null && !integer(cart.itemSubtotalMinor)))) fail('invalid_promotion_cart');
  const reasons = ['matching_official_terms_not_found', 'qualifying_products_not_verified'];
  const priorOrders = customerFacts.priorCompletedOrders;
  let eligibility = 'provisional';
  if (priorOrders == null) { eligibility = 'unknown'; reasons.push('first_order_not_verified'); }
  else if (priorOrders > 0) { eligibility = 'conditions_not_met'; reasons.push('prior_completed_order'); }
  if (cart?.itemSubtotalMinor == null) {
    if (eligibility !== 'conditions_not_met') eligibility = 'unknown';
    reasons.push('basket_value_not_observed');
  } else if (cart.itemSubtotalMinor < RECEIPT.minimumBasketMinor) {
    eligibility = 'conditions_not_met'; reasons.push('below_reported_minimum');
  }
  const onboarding = customerFacts.hasExistingAccount === true ? 'sign_in_existing_account'
    : customerFacts.hasExistingAccount === false ? 'register_new_customer' : 'verify_account_status';
  return { code: CODE, ...RECEIPT, termsUrl: TERMS_URL, eligibility, eligibilityReasons: reasons,
    eligibilityBasis: 'receipt_report_and_server_customer_facts', onboarding, oneAccountPerPerson: true,
    ...checkoutEvidence(promotion, cart, quote, now) };
}
