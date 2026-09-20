import test from 'node:test';
import assert from 'node:assert/strict';
import { discoverFiveSimOffers, assessFiveSimOffers } from './discovery.mjs';

const now = 1_800_000_000_000;
const budget = { currency: 'TEST_COIN', exponent: 2, totalMinor: 20, perOrderMinor: 20,
  currencyVerified: true, currencyEvidence: 'https://example.test/synthetic-currency',
  authorization: { currency: 'USD', totalMinor: 20, maxPurchases: 1 },
  conversion: { verified: true, includesFees: true, usdMicrosPerUnit: 1_000_000,
    evidenceUrl: 'https://example.test/synthetic-conversion', validUntil: now + 1000 } };
async function report() {
  return discoverFiveSimOffers({ now: () => now, fetchImpl: async (url, options) => {
    assert.equal(new URL(url).origin, 'https://5sim.net');
    assert.equal(options.headers.Authorization, undefined);
    assert.equal(options.method, 'GET');
    assert.equal(options.redirect, 'error');
    return Response.json(url.includes('/products/') ? {
      zabkajush: { Category: 'activation', Qty: 4, Price: '0.10', privateField: 'do-not-export' },
      delio: { Category: 'activation', Qty: 0, Price: '0.10' }, unrelated: { Category: 'activation', Qty: 1, Price: '0.01' },
    } : { poland: { zabkajush: {
      virtualbest: { cost: '0.18', count: 2, rate: 99 }, virtualcheap: { cost: '0.10', count: 1, rate: 92 },
      virtualunknown: { cost: '0.10', count: 1 }, virtualsoldout: { cost: '0.10', count: 0, rate: 100 },
      virtualexpensive: { cost: '0.21', count: 5, rate: 100 }, virtualinvalid: { cost: 'secret', count: 2, rate: 100 },
    }, unrelated: { virtualsecret: { cost: '0.10', count: 2, rate: 100 } } } });
  } });
}

test('discovery is two credential-free fixed-origin requests and exports only candidate offer fields', async () => {
  const r = await report();
  assert.equal(r.requests.length, 2);
  assert.equal(r.complete, true);
  assert.equal(r.currency, null);
  assert.equal(r.conversionVerified, false);
  assert.deepEqual(r.candidates.map(c => c.product), ['delio', 'zabkajush']);
  assert.equal(r.candidates[1].merchantCompatible, null);
  assert.equal(r.candidates[1].offers.find(o => o.operator === 'virtualunknown').rate, null);
  for (const secret of ['do-not-export', 'secret', 'unrelated']) assert.equal(JSON.stringify(r).includes(secret), false);
});

test('exact HTTP status survives without raw body, auth or a false unsupported-service claim', async () => {
  const r = await discoverFiveSimOffers({ fetchImpl: async () => new Response('private diagnostic body', { status: 403 }) });
  assert.equal(r.complete, false);
  assert.deepEqual(r.candidates, []);
  assert.deepEqual(r.requests.map(x => [x.httpStatus, x.code]), [[403, 'public_http_error'], [403, 'public_http_error']]);
  assert.equal(JSON.stringify(r).includes('private diagnostic'), false);
});

test('timeouts remain bounded even for fetch that ignores abort; no automatic retry', async () => {
  let calls = 0;
  const r = await discoverFiveSimOffers({ requestTimeoutMs: 5, fetchImpl: () => { calls++; return new Promise(() => {}); } });
  assert.equal(calls, 2);
  assert.deepEqual(r.requests.map(x => x.code), ['public_request_timeout', 'public_request_timeout']);
});

test('ranking respects stock, minimum rate and exact attested cap without authorizing a purchase', async () => {
  const r = assessFiveSimOffers(await report(), { product: 'zabkajush', budget, now });
  assert.deepEqual(r.rankedOffers.map(o => o.operator), ['virtualbest', 'virtualcheap']);
  assert.deepEqual(r.blockers, []);
  assert.equal(r.purchaseOperator, 'any');
  assert.equal(r.purchaseAuthorized, false);
  assert.equal(r.operatorRateEnforceable, false);
  assert.equal(r.merchantCompatibilityVerified, false);
});

test('explicit named operator cannot be bought under documented maxPrice contract', async () => {
  const r = assessFiveSimOffers(await report(), { product: 'zabkajush', operator: 'virtualbest', budget, now });
  assert.equal(r.recommendedOffer.operator, 'virtualbest');
  assert.equal(r.purchaseOperator, null);
  assert.equal(r.observedCriteriaMet, false);
  assert.ok(r.blockers.includes('named_operator_price_cap_unsupported'));
});

test('unverified or expired denomination/conversion and rounded USD excess cannot qualify', async () => {
  const data = await report();
  const cases = [
    [undefined, 'verified_explicit_budget_required'],
    [{ ...budget, currencyVerified: false }, 'verified_explicit_budget_required'],
    [{ ...budget, conversion: { ...budget.conversion, validUntil: now } }, 'verified_currency_conversion_required'],
    [{ ...budget, conversion: { ...budget.conversion, includesFees: false } }, 'verified_currency_conversion_required'],
    [{ ...budget, conversion: { ...budget.conversion, usdMicrosPerUnit: 1_000_001 } }, 'usd_authorization_exceeded'],
  ];
  for (const [b, code] of cases) {
    const selected = assessFiveSimOffers(data, { product: 'zabkajush', budget: b, now });
    assert.ok(selected.blockers.includes(code));
    assert.deepEqual(selected.rankedOffers, []);
  }
});

test('stale, incomplete and absent service results fail closed; absence is not merchant incompatibility', async () => {
  const data = await report();
  assert.ok(assessFiveSimOffers(data, { product: 'zabkajush', budget, now: now + 60_001 }).blockers.includes('public_offers_stale'));
  assert.ok(assessFiveSimOffers({ ...data, complete: false }, { product: 'zabkajush', budget, now }).blockers.includes('public_discovery_incomplete'));
  const missing = assessFiveSimOffers(data, { product: 'missing', budget, now });
  assert.ok(missing.blockers.includes('activation_identifier_unverified'));
  assert.equal(missing.merchantCompatibilityVerified, false);
});

test('six-place provider USD accounting retains fractional-cent precision inside the 20-cent cap', async () => {
  const data = await report();
  data.candidates[1].offers = [
    { operator: 'virtualwithin', count: 1, price: '0.199999', rate: 95 },
    { operator: 'virtualover', count: 1, price: '0.200001', rate: 100 },
  ];
  const usd = { ...budget, currency: 'USD', exponent: 6, totalMinor: 200000, perOrderMinor: 200000 };
  const result = assessFiveSimOffers(data, { product: 'zabkajush', budget: usd, now });
  assert.deepEqual(result.rankedOffers.map(o => [o.operator, o.priceMinor]), [['virtualwithin', 199999]]);
  assert.equal(result.maximumProviderMinor, 200000);
  assert.deepEqual(result.blockers, []);
});
