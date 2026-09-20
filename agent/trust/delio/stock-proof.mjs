const MAX_AGE_MS = 30_000;
const MAX_LINES = 1000;
const PROOF_KEYS = ['customerId', 'merchantAccountId', 'deliveryCommitment', 'regionId',
  'fulfillmentAreaId', 'observedAt', 'lines'];
const LINE_KEYS = ['productId', 'quantity', 'availableQuantity'];
const plain = value => value && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const integer = value => Number.isSafeInteger(value) && value >= 0 && !Object.is(value, -0);
const id = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)
  && !['constructor', 'prototype', '__proto__'].includes(value);
const commitment = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const fail = code => { throw Object.assign(new TypeError(code), { code }); };
function exact(value, keys, code) {
  if (!plain(value) || Reflect.ownKeys(value).length !== keys.length
      || keys.some(key => !Object.hasOwn(value, key))) fail(code);
}

/**
 * Validates an observation supplied by the trusted checkout worker, never HTTP
 * request input. Registry expectations must also be server-owned. Time is epoch
 * milliseconds; callers may shorten the 30-second ceiling, but cannot extend it.
 * A fulfillmentAreaId is mandatory; if quote metadata provides it, it must agree.
 * The proof records observed availability only. It does not reserve inventory,
 * guarantee future stock, or authorize substitutions or merchant execution.
 */
export function validateCheckoutStock({ quote, actor, expectedDeliveryCommitment, expectedRegionId,
  now = Date.now(), maxAgeMs = MAX_AGE_MS } = {}) {
  if (!plain(actor) || !id(actor.customerId) || !id(actor.merchantAccountId)
      || !commitment(expectedDeliveryCommitment) || !id(expectedRegionId)
      || !integer(now) || !integer(maxAgeMs) || maxAgeMs === 0 || maxAgeMs > MAX_AGE_MS) fail('stock_proof_invalid_context');
  if (!plain(quote)) fail('stock_proof_missing');
  const proof = quote.stockProof;
  if (proof == null) fail('stock_proof_missing');
  exact(proof, PROOF_KEYS, 'stock_proof_invalid_fields');
  if (!id(proof.customerId) || !id(proof.merchantAccountId)
      || proof.customerId !== actor.customerId || proof.merchantAccountId !== actor.merchantAccountId) fail('stock_proof_owner_mismatch');
  if (!commitment(proof.deliveryCommitment) || proof.deliveryCommitment !== expectedDeliveryCommitment) fail('stock_proof_delivery_mismatch');
  if (!id(proof.regionId) || proof.regionId !== expectedRegionId) fail('stock_proof_region_mismatch');
  if (!id(proof.fulfillmentAreaId)) fail('stock_proof_invalid_fulfillment_area');
  // Raw worker quotes need not carry normalized owner metadata yet. If present,
  // it cannot contradict either the independently configured context or proof.
  for (const key of ['customerId', 'merchantAccountId', 'deliveryCommitment', 'regionId', 'fulfillmentAreaId']) {
    if (Object.hasOwn(quote, key) && quote[key] !== proof[key]) fail('stock_proof_quote_binding_mismatch');
  }
  if (!integer(proof.observedAt) || proof.observedAt > now) fail('stock_proof_invalid_observation_time');
  if (now - proof.observedAt > maxAgeMs) fail('stock_proof_stale');
  if (!Array.isArray(quote.lines) || quote.lines.length === 0 || quote.lines.length > MAX_LINES
      || !Array.isArray(proof.lines) || proof.lines.length !== quote.lines.length) fail('stock_proof_lines_mismatch');
  const requested = new Map();
  for (const line of quote.lines) {
    if (!plain(line) || !id(line.productId) || !integer(line.quantity) || line.quantity === 0
        || requested.has(line.productId)) fail('stock_proof_invalid_quote_lines');
    requested.set(line.productId, line.quantity);
  }
  const seen = new Set(), lines = [];
  for (const line of proof.lines) {
    exact(line, LINE_KEYS, 'stock_proof_invalid_line_fields');
    if (!id(line.productId) || !integer(line.quantity) || line.quantity === 0
        || !integer(line.availableQuantity) || seen.has(line.productId)) fail('stock_proof_invalid_lines');
    if (requested.get(line.productId) !== line.quantity) fail('stock_proof_lines_mismatch');
    if (line.availableQuantity < line.quantity) fail('stock_proof_insufficient_stock');
    seen.add(line.productId);
    lines.push({ productId: line.productId, quantity: line.quantity, availableQuantity: line.availableQuantity });
  }
  return { customerId: proof.customerId, merchantAccountId: proof.merchantAccountId,
    deliveryCommitment: proof.deliveryCommitment, regionId: proof.regionId,
    fulfillmentAreaId: proof.fulfillmentAreaId, observedAt: proof.observedAt, lines };
}
