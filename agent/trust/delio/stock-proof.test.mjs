import test from 'node:test';
import assert from 'node:assert/strict';
import { validateCheckoutStock } from './stock-proof.mjs';

const actor = { customerId: 'fixture-customer', merchantAccountId: 'fixture-merchant-account' };
const expectedDeliveryCommitment = 'ab'.repeat(32), expectedRegionId = 'warsaw-region', now = 1_000_000;
function fixture() {
  return { actor, expectedDeliveryCommitment, expectedRegionId, now, quote: {
    lines: [{ productId: 'coffee', quantity: 2, unitPriceMinor: 1500 }, { productId: 'tea', quantity: 1 }],
    stockProof: { ...actor, deliveryCommitment: expectedDeliveryCommitment, regionId: expectedRegionId,
      fulfillmentAreaId: 'fixture-warehouse-1', observedAt: now - 1000,
      lines: [{ productId: 'tea', quantity: 1, availableQuantity: 3 }, { productId: 'coffee', quantity: 2, availableQuantity: 2 }] },
  } };
}
function rejects(mutate, code) {
  const input = fixture(); mutate(input);
  assert.throws(() => validateCheckoutStock(input), { code });
}

test('exact available inventory validates independently of row order and returns a detached sanitized proof', () => {
  const input = fixture(), validated = validateCheckoutStock(input);
  assert.deepEqual(validated, input.quote.stockProof);
  assert.notEqual(validated, input.quote.stockProof); assert.notEqual(validated.lines, input.quote.stockProof.lines);
  input.quote.stockProof.lines[0].availableQuantity = 0;
  assert.equal(validated.lines[0].availableQuantity, 3);
  validated.lines[1].quantity = 99;
  assert.equal(input.quote.stockProof.lines[1].quantity, 2);
  assert.equal(Object.hasOwn(validated, 'reserved'), false);
});

test('missing proof, partial proof or invented reservation/substitution fields fail closed', () => {
  rejects(input => { delete input.quote.stockProof; }, 'stock_proof_missing');
  rejects(input => { delete input.quote.stockProof.fulfillmentAreaId; }, 'stock_proof_invalid_fields');
  rejects(input => { input.quote.stockProof.reserved = true; }, 'stock_proof_invalid_fields');
  rejects(input => { input.quote.stockProof.lines[0].substituteFor = 'other'; }, 'stock_proof_invalid_line_fields');
});

test('customer, merchant account, delivery commitment and region bind to independent server expectations', () => {
  for (const key of ['customerId', 'merchantAccountId']) {
    rejects(input => { input.quote.stockProof[key] = 'other'; }, 'stock_proof_owner_mismatch');
  }
  rejects(input => { input.quote.stockProof.deliveryCommitment = 'cd'.repeat(32); }, 'stock_proof_delivery_mismatch');
  rejects(input => { input.quote.stockProof.regionId = 'other-region'; }, 'stock_proof_region_mismatch');
  for (const value of ['', 'a'.repeat(129), 'https://example.test/region', 123, null]) {
    rejects(input => { input.quote.stockProof.fulfillmentAreaId = value; }, 'stock_proof_invalid_fulfillment_area');
  }
});

test('normalized quote binding fields cannot contradict stock proof', () => {
  for (const key of ['customerId', 'merchantAccountId', 'deliveryCommitment', 'regionId', 'fulfillmentAreaId']) {
    rejects(input => { input.quote[key] = 'different'; }, 'stock_proof_quote_binding_mismatch');
  }
  const input = fixture();
  for (const key of ['customerId', 'merchantAccountId', 'deliveryCommitment', 'regionId', 'fulfillmentAreaId']) {
    input.quote[key] = input.quote.stockProof[key];
  }
  assert.deepEqual(validateCheckoutStock(input), input.quote.stockProof);
});

test('proof must match every unique SKU and exact requested quantity with sufficient stock', () => {
  rejects(input => { input.quote.stockProof.lines.pop(); }, 'stock_proof_lines_mismatch');
  rejects(input => { input.quote.stockProof.lines.push({ productId: 'extra', quantity: 1, availableQuantity: 1 }); }, 'stock_proof_lines_mismatch');
  rejects(input => { input.quote.stockProof.lines[0].productId = 'substitute-tea'; }, 'stock_proof_lines_mismatch');
  rejects(input => { input.quote.stockProof.lines[0].quantity = 2; }, 'stock_proof_lines_mismatch');
  rejects(input => { input.quote.stockProof.lines[1] = { ...input.quote.stockProof.lines[0] }; }, 'stock_proof_invalid_lines');
  rejects(input => { input.quote.lines[1] = { ...input.quote.lines[0] }; }, 'stock_proof_invalid_quote_lines');
  rejects(input => { input.quote.stockProof.lines[0].availableQuantity = 0; }, 'stock_proof_insufficient_stock');
  rejects(input => { input.quote.stockProof.lines[1].availableQuantity = 1; }, 'stock_proof_insufficient_stock');
  rejects(input => { input.quote.lines = []; input.quote.stockProof.lines = []; }, 'stock_proof_lines_mismatch');
});

test('quantities must be explicit safe integers; unknown, fractional and negative availability cannot pass', () => {
  for (const value of [undefined, null, '3', -1, -0, 1.5, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1]) {
    rejects(input => { input.quote.stockProof.lines[0].availableQuantity = value; }, 'stock_proof_invalid_lines');
  }
  for (const value of [0, -1, 1.5, '2']) {
    rejects(input => { input.quote.lines[0].quantity = value; }, 'stock_proof_invalid_quote_lines');
    rejects(input => { input.quote.stockProof.lines[0].quantity = value; }, 'stock_proof_invalid_lines');
  }
});

test('future/stale proof is rejected, with an inclusive maximum age and an optional shorter window', () => {
  rejects(input => { input.quote.stockProof.observedAt = now + 1; }, 'stock_proof_invalid_observation_time');
  rejects(input => { input.quote.stockProof.observedAt = now - 30_001; }, 'stock_proof_stale');
  const boundary = fixture(); boundary.quote.stockProof.observedAt = now - 30_000;
  assert.equal(validateCheckoutStock(boundary).observedAt, now - 30_000);
  rejects(input => { input.maxAgeMs = 999; }, 'stock_proof_stale');
  const shortened = fixture(); shortened.maxAgeMs = 1000;
  assert.equal(validateCheckoutStock(shortened).observedAt, now - 1000);
  for (const value of [null, -1, 1.5, '1000', NaN]) {
    rejects(input => { input.quote.stockProof.observedAt = value; }, 'stock_proof_invalid_observation_time');
  }
});

test('invalid expected context and age limits cannot disable freshness or owner binding', () => {
  for (const value of [0, -1, 1.5, '30000', 30_001, Infinity, null]) {
    rejects(input => { input.maxAgeMs = value; }, 'stock_proof_invalid_context');
  }
  rejects(input => { input.now = -1; }, 'stock_proof_invalid_context');
  rejects(input => { input.expectedDeliveryCommitment = 'unbound-address'; }, 'stock_proof_invalid_context');
  rejects(input => { input.expectedRegionId = ''; }, 'stock_proof_invalid_context');
  rejects(input => { input.actor = { customerId: actor.customerId }; }, 'stock_proof_invalid_context');
});
