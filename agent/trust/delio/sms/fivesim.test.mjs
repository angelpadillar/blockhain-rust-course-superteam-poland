import test from 'node:test';
import assert from 'node:assert/strict';
import { createFiveSimAdapter, createFiveSimStore, createManualOtp, priceToMinor } from './fivesim.mjs';

const TOKEN = 'private-provider-token-do-not-log';
const PHONE = '+48123123123';
const OTP = '735921';
function fixture({ paidEnabled = true, totalMinor = 20, perOrderMinor = 10, maxPurchases = 3, initial, persist, modify, requestTimeoutMs = 100 } = {}) {
  let time = 1_800_000_000_000;
  const calls = [], writes = [], orders = [];
  const budget = { currency: 'TEST_COIN', exponent: 2, totalMinor, perOrderMinor, currencyVerified: true,
    currencyEvidence: 'https://example.test/fictional-currency-evidence',
    authorization: { currency: 'USD', totalMinor: 20, maxPurchases },
    conversion: { usdMicrosPerUnit: 1_000_000, verified: true, includesFees: true, evidenceUrl: 'https://example.test/fictional-fx', validUntil: time + 600_000 } };
  const service = { country: 'poland', product: 'fictionalservice', verified: true, merchantCompatible: true,
    evidenceUrl: 'https://example.test/fictional-service', compatibilityEvidenceUrl: 'https://example.test/fictional-compatibility' };
  const store = createFiveSimStore({ initial, durableWrite: async s => { await persist?.(s); writes.push(structuredClone(s)); } });
  const fetchImpl = async (url, options) => {
    calls.push({ url, method: options.method, authorization: options.headers.Authorization });
    const u = new URL(url);
    if (modify) {
      const special = await modify({ url: u, options, orders, writes, calls, time, makeOrder });
      if (special !== undefined) return special;
    }
    if (u.pathname === '/v1/user/orders') return Response.json({ Data: orders, Total: orders.length });
    if (u.pathname.includes('/buy/activation/')) { const o = makeOrder(); orders.push(o); return Response.json(o); }
    const row = orders.find(o => String(o.id) === u.pathname.split('/').at(-1));
    if (row && u.pathname.startsWith('/v1/user/cancel/')) row.status = 'CANCELED';
    if (row && u.pathname.startsWith('/v1/user/finish/')) row.status = 'FINISHED';
    if (row) return Response.json(row);
    return new Response('not found', { status: 404 });
  };
  function makeOrder(extra = {}) {
    return { id: orders.length + 101, phone: PHONE, product: service.product, country: 'poland', operator: 'virtualtest', price: '0.10',
      status: 'RECEIVED', created_at: new Date(time).toISOString(), expires: new Date(time + 60_000).toISOString(), sms: [], ...extra };
  }
  const options = { paidEnabled, token: TOKEN, fetchImpl, store, budget, service, exclusiveProviderAccount: true,
    now: () => time, sleep: async ms => { time += ms; }, requestTimeoutMs, pollIntervalMs: 100, maxPollMs: 1000, maxPolls: 20 };
  const adapter = createFiveSimAdapter(options);
  return { adapter, options, store, budget, service, calls, writes, orders, makeOrder, advance: ms => { time += ms; } };
}
const buy = f => f.adapter.buy({ onPhone: async () => {} });
const buys = f => f.calls.filter(c => c.url.includes('/buy/activation/'));

test('disabled by default and disabled explicitly make no private requests', async () => {
  const f = fixture({ paidEnabled: false });
  await assert.rejects(buy(f), /paid_sms_disabled/);
  const disabled = createFiveSimAdapter({ fetchImpl: f.options.fetchImpl });
  await assert.rejects(disabled.buy({ onPhone() {} }), /paid_sms_disabled/);
  assert.equal(f.calls.length, 0);
});

test('requires real currency mapping, merchant compatibility and explicit USD authorization', async () => {
  const f = fixture();
  const cases = [
    { budget: { ...f.budget, conversion: undefined } },
    { budget: { ...f.budget, authorization: undefined } },
    { budget: { ...f.budget, authorization: { currency: 'USD', totalMinor: 19, maxPurchases: 1 } } },
    { service: { ...f.service, compatibilityEvidenceUrl: undefined } },
    { exclusiveProviderAccount: false },
  ];
  for (const extra of cases) {
    await assert.rejects(createFiveSimAdapter({ ...f.options, ...extra }).buy({ onPhone() {} }));
  }
  assert.equal(f.calls.length, 0);
});

test('reservation is durable before paid GET and costs before phone delivery', async () => {
  const f = fixture({ modify({ url, writes }) {
    if (url.pathname.includes('/buy/')) {
      assert.equal(writes.at(-1).entries[0].phase, 'buy_pending');
      assert.equal(url.searchParams.get('maxPrice'), '0.10');
      assert.match(url.pathname, /\/poland\/any\/fictionalservice$/);
    }
  } });
  const result = await f.adapter.buy({ onPhone(phone) {
    assert.equal(phone, PHONE);
    assert.equal(f.writes.at(-1).entries[0].costMinor, 10);
  } });
  assert.equal(result.costMinor, 10);
  assert.equal(buys(f)[0].method, 'GET');
  assert.equal(buys(f)[0].authorization, `Bearer ${TOKEN}`);
});

test('shared store serializes concurrent buyers and enforces total budget', async () => {
  const f = fixture();
  const sibling = createFiveSimAdapter(f.options);
  const results = await Promise.allSettled([buy(f), sibling.buy({ onPhone() {} }), buy(f)]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 2);
  assert.equal(buys(f).length, 2);
  assert.equal(results.find(r => r.status === 'rejected').reason.message, 'sms_budget_exceeded');
  assert.equal((await f.adapter.publicStatus()).knownCostMinor, 20);
});

test('one-test purchase authorization is enforced separately from currency budget', async () => {
  const f = fixture({ maxPurchases: 1 });
  await buy(f);
  await assert.rejects(buy(f), /sms_purchase_limit/);
  assert.equal(buys(f).length, 1);
});

test('durability failure prevents purchase and poisons further mutations', async () => {
  const f = fixture({ persist() { throw new Error(`disk: ${TOKEN}`); } });
  await assert.rejects(buy(f), /^Error: sms_journal_failed$/);
  await assert.rejects(buy(f), /^Error: sms_journal_failed$/);
  assert.equal(buys(f).length, 0);
});

test('uncertain purchase blocks retry across restart; explicit history reconciliation recovers actual cost', async () => {
  let first = true;
  const f = fixture({ modify({ url, orders, makeOrder }) {
    if (url.pathname.includes('/buy/') && first) {
      first = false; orders.push(makeOrder()); throw new Error(`lost response ${PHONE} ${TOKEN}`);
    }
  } });
  await assert.rejects(buy(f), /^Error: purchase_uncertain_reconcile_required$/);
  await assert.rejects(buy(f), /reconciliation_required/);
  const pending = (await f.adapter.publicStatus()).entries[0].reservationId;
  const recoveryStore = createFiveSimStore({ initial: f.writes.at(-1), durableWrite: async () => {} });
  const recovered = createFiveSimAdapter({ ...f.options, store: recoveryStore });
  await assert.rejects(recovered.buy({ onPhone() {} }), /reconciliation_required/);
  const candidates = await recovered.reconcile({ reservationId: pending });
  assert.deepEqual(candidates.candidateOrderIds, ['101']);
  assert.equal(candidates.reconciled, false);
  await recovered.reconcile({ reservationId: pending, providerOrderId: '101' });
  assert.equal((await recovered.publicStatus()).knownCostMinor, 10);
  await recovered.buy({ onPhone() {} });
  assert.equal(buys(f).length, 2);
});

test('empty history does not release uncertain reservation or authorize a retry', async () => {
  const f = fixture({ modify({ url }) { if (url.pathname.includes('/buy/')) return new Response('no free phones', { status: 200 }); } });
  await assert.rejects(buy(f), /purchase_uncertain/);
  const s = await f.adapter.publicStatus();
  const r = await f.adapter.reconcile({ reservationId: s.entries[0].reservationId });
  assert.deepEqual(r.candidateOrderIds, []);
  await assert.rejects(buy(f), /reconciliation_required/);
  assert.equal((await f.adapter.publicStatus()).reservedMinor, 10);
  assert.equal(buys(f).length, 1);
});

test('purchase timeout has no blind retry, even when injected fetch ignores abort', async () => {
  const f = fixture({ requestTimeoutMs: 10, modify({ url }) { if (url.pathname.includes('/buy/')) return new Promise(() => {}); } });
  await assert.rejects(buy(f), /purchase_uncertain/);
  await assert.rejects(buy(f), /reconciliation_required/);
  assert.equal(buys(f).length, 1);
});

test('poll is bounded, stops at provider expiry and never automatically cancels', async () => {
  const f = fixture();
  const e = await buy(f);
  const timed = await f.adapter.poll({ reservationId: e.reservationId, onOtp() {}, timeoutMs: 250 });
  assert.equal(timed.state, 'poll_timeout');
  assert.equal(timed.polls, 3);
  f.advance(60_000);
  const calls = f.calls.length;
  assert.deepEqual(await f.adapter.poll({ reservationId: e.reservationId, onOtp() {} }), { state: 'expired', polls: 0 });
  assert.equal(f.calls.length, calls);
  assert.equal(f.calls.some(c => c.url.includes('/cancel/')), false);
});

test('OTP, phone, raw message and token stay out of public status and durable metadata', async () => {
  const f = fixture();
  const e = await buy(f);
  f.orders[0].sms = [{ code: OTP, text: `private OTP ${OTP}`, sender: 'private-sender' }];
  let received;
  const result = await f.adapter.poll({ reservationId: e.reservationId, onOtp(code) { received = code; } });
  assert.equal(received, OTP);
  await assert.rejects(f.adapter.poll({ reservationId: e.reservationId, onOtp() {} }), /otp_already_dispatched/);
  const safe = JSON.stringify([result, await f.adapter.publicStatus(), f.writes]);
  for (const secret of [OTP, PHONE, TOKEN, 'private-sender', 'private OTP']) assert.equal(safe.includes(secret), false);
});

test('owned reconciliation exposes only observed SMS count/time without consuming or serializing private messages', async () => {
  const f = fixture(), entry = await buy(f);
  const empty = await f.adapter.reconcile({ reservationId: entry.reservationId });
  assert.equal(empty.smsCount, 0); assert.equal(empty.observedAt, 1_800_000_000_000);
  f.advance(500);
  f.orders[0].sms = [{ code: OTP, text: 'private authentication body', sender: 'private merchant sender' },
    { code: '654321', text: 'second private body', phone: PHONE }];
  const result = await f.adapter.reconcile({ reservationId: entry.reservationId });
  assert.equal(result.smsCount, 2); assert.equal(Number.isSafeInteger(result.smsCount), true);
  assert.equal(result.observedAt, 1_800_000_000_500); assert.equal(result.reconciled, true);
  assert.equal(f.writes.at(-1).entries[0].otpDispatched, undefined);
  const safe = JSON.stringify([empty, result, await f.adapter.publicStatus(), f.writes]);
  for (const secret of [OTP, '654321', PHONE, TOKEN, 'private authentication body', 'private merchant sender', 'second private body']) {
    assert.equal(safe.includes(secret), false);
  }
  f.orders[0].sms = 'private malformed SMS response';
  const unknown = await f.adapter.reconcile({ reservationId: entry.reservationId });
  assert.equal(unknown.smsCount, null); assert.equal(JSON.stringify(unknown).includes(f.orders[0].sms), false);
});

test('cancel/finish require owned orders and explicit operations; uncertain cancellation is reconciled not retried', async () => {
  let cancelFirst = true;
  const f = fixture({ modify({ url, orders }) {
    if (url.pathname.includes('/cancel/') && cancelFirst) { cancelFirst = false; orders[0].status = 'CANCELED'; throw new Error(TOKEN); }
  } });
  await assert.rejects(f.adapter.mutateOwned({ reservationId: 'external', operation: 'cancel' }), /order_not_owned/);
  const e = await buy(f);
  await assert.rejects(f.adapter.mutateOwned({ reservationId: e.reservationId, operation: 'ban' }), /explicit_cancel_or_finish_required/);
  await assert.rejects(f.adapter.mutateOwned({ reservationId: e.reservationId, operation: 'cancel' }), /mutation_uncertain/);
  await assert.rejects(f.adapter.mutateOwned({ reservationId: e.reservationId, operation: 'cancel' }), /reconciliation_required/);
  const reconciled = await f.adapter.reconcile({ reservationId: e.reservationId });
  assert.equal(reconciled.reconciled, true);
  assert.equal(reconciled.status, 'CANCELED');
  assert.equal((await f.adapter.publicStatus()).knownCostMinor, 10); // No assumed refund.
  assert.equal(f.calls.filter(c => c.url.includes('/cancel/')).length, 1);
  const second = await buy(f);
  assert.equal((await f.adapter.mutateOwned({ reservationId: second.reservationId, operation: 'finish' })).status, 'FINISHED');
});

test('manual OTP needs no provider, is one-use and redacts callback errors', async () => {
  let received;
  const m = createManualOtp({ now: () => 100, expiresAt: 1000, onOtp: code => { received = code; } });
  assert.deepEqual(await m.submit(OTP), { accepted: true, mode: 'manual' });
  assert.equal(received, OTP);
  await assert.rejects(m.submit(OTP), /otp_expired_or_consumed/);
  const bad = createManualOtp({ onOtp() { throw new Error(OTP); } });
  await assert.rejects(bad.submit(OTP), /^Error: private_otp_consumer_failed$/);
  const f = fixture();
  const e = await buy(f);
  f.orders[0].sms = [{ code: OTP }];
  await assert.rejects(f.adapter.poll({ reservationId: e.reservationId, onOtp() { throw new Error(`${OTP} ${PHONE}`); } }), /^Error: private_otp_consumer_failed$/);
});

test('offer ranking ignores no-stock rows; missing rate remains unknown, not zero', async () => {
  const f = fixture({ paidEnabled: false, modify({ url, options }) {
    if (url.pathname === '/v1/guest/prices') {
      assert.equal(options.headers.Authorization, undefined);
      return Response.json({ poland: { fictionalservice: {
        virtualone: { count: 2, cost: 1, rate: 80 }, virtualtwo: { count: 1, cost: 3, rate: 95 },
        virtualthree: { count: 1, cost: 1 }, virtualfour: { count: 0, cost: 0.1, rate: 100 },
      } } });
    }
  } });
  const r = await f.adapter.offers({ product: 'fictionalservice' });
  assert.deepEqual(r.offers.map(o => o.operator), ['virtualtwo', 'virtualone', 'virtualthree']);
  assert.equal(r.offers.at(-1).rate, null);
  assert.equal(r.currency, null);
});

test('minor-unit conversion is exact and rejects excessive precision or unsafe numbers', () => {
  assert.equal(priceToMinor('0.17', 2), 17);
  assert.equal(priceToMinor(1.01, 2), 101);
  assert.throws(() => priceToMinor('0.001', 2));
  assert.throws(() => priceToMinor('9e99', 2));
  assert.throws(() => priceToMinor('-1', 2));
});

test('explicit named operator is rejected before history, reservation or paid request', async () => {
  const f = fixture();
  await assert.rejects(f.adapter.buy({ operator: 'virtualbest', onPhone() {} }), /^Error: named_operator_price_cap_unsupported$/);
  assert.equal(f.calls.length, 0);
  assert.equal(f.writes.length, 0);
});

test('public preflight keeps HTTP blockers precise and never makes an authenticated call', async () => {
  const f = fixture({ paidEnabled: false });
  const result = await f.adapter.publicPreflight({ product: 'zabkajush' });
  assert.equal(result.purchaseAuthorized, false);
  assert.equal(result.purchaseBlocker, 'paid_sms_disabled');
  assert.equal(f.calls.length, 2);
  assert.ok(f.calls.every(c => c.authorization === undefined));
  assert.deepEqual(result.discovery.requests.map(r => r.httpStatus), [404, 404]);
  assert.ok(result.selection.blockers.includes('public_discovery_incomplete'));
});

test('public preflight preserves uncertain purchase reservation and requires reconciliation', async () => {
  const f = fixture({ modify({ url }) { if (url.pathname.includes('/buy/')) throw new Error('lost reply'); } });
  await assert.rejects(buy(f), /purchase_uncertain/);
  const before = await f.adapter.publicStatus();
  const preflight = await f.adapter.publicPreflight({ product: 'fictionalservice', terms: ['fictionalservice'] });
  assert.equal(preflight.purchaseBlocker, 'reconciliation_required');
  assert.deepEqual(await f.adapter.publicStatus(), before);
  assert.equal(buys(f).length, 1);
});

test('fresh-store status reports effective validated authorization without writes, HTTP requests or secrets', async () => {
  const f=fixture({maxPurchases:1});
  const result=await f.adapter.publicStatus();
  assert.equal(result.purchaseConfigurationValid,true);
  assert.deepEqual(result.usdAuthorization,{currency:'USD',totalMinor:20,maxPurchases:1});
  assert.equal(result.purchaseBlocker,null);
  assert.equal(f.calls.length,0);assert.equal(f.writes.length,0);
  assert.equal((await f.store.exclusive(a=>a.read())).policy,null);
  for(const secret of [TOKEN,PHONE,OTP])assert.equal(JSON.stringify(result).includes(secret),false);
});

test('read-only status rejects missing/expired conversion and changed policy before treating any cap as validated',async()=>{
  const f=fixture({maxPurchases:1});
  f.advance(600_000);
  const expired=await f.adapter.publicStatus();
  assert.equal(expired.purchaseConfigurationValid,false);
  assert.equal(expired.usdAuthorization,null);
  assert.equal(expired.purchaseBlocker,'verified_currency_conversion_required');
  assert.equal(f.calls.length,0);assert.equal(f.writes.length,0);
  const valid=fixture({maxPurchases:1});
  await buy(valid);
  const changed=createFiveSimAdapter({...valid.options,budget:{...valid.budget,authorization:{currency:'USD',totalMinor:50,maxPurchases:1}}});
  const beforeCalls=valid.calls.length,beforeWrites=valid.writes.length;
  const status=await changed.publicStatus();
  assert.equal(status.purchaseConfigurationValid,false);
  assert.equal(status.purchaseBlocker,'store_policy_mismatch');
  assert.equal(status.usdAuthorization,null);
  assert.equal(status.knownCostMinor,10);
  assert.equal(valid.calls.length,beforeCalls);assert.equal(valid.writes.length,beforeWrites);
});

test('disabled status never presents an effective purchase authorization',async()=>{
  const f=fixture({paidEnabled:false});
  const status=await f.adapter.publicStatus();
  assert.equal(status.paidEnabled,false);assert.equal(status.purchaseConfigurationValid,false);
  assert.equal(status.usdAuthorization,null);assert.equal(status.purchaseBlocker,'paid_sms_disabled');
  assert.equal(f.calls.length,0);assert.equal(f.writes.length,0);
});

const historyRows = (count, offset = 0) => Array.from({ length: count }, (_, i) => ({ id: 1001 + offset + i }));
const historyCalls = f => f.calls.filter(c => new URL(c.url).pathname === '/v1/user/orders');
const knownPrePurchaseFailure = error => {
  assert.equal(error.message, 'provider_pre_purchase_check_failed');
  assert.equal(error.code, 'provider_pre_purchase_check_failed');
  assert.equal(error.dispatched, false);
  return true;
};

test('observed 14-row sentinel history permits one durably reserved purchase', async () => {
  const f = fixture({ maxPurchases: 1, modify({ url }) {
    if (url.pathname === '/v1/user/orders') return Response.json({ Data: historyRows(14), Total: 999999 });
  } });
  await buy(f);
  assert.equal(historyCalls(f).length, 1);
  assert.equal(buys(f).length, 1);
  assert.equal(f.writes[0].entries[0].phase, 'buy_pending');
  assert.deepEqual(f.writes[0].entries[0].baselineOrderIds, historyRows(14).map(o => String(o.id)));
  await assert.rejects(buy(f), /sms_purchase_limit/);
  assert.equal(buys(f).length, 1);
});

test('full sentinel page follows bounded offsets until a short page', async () => {
  const f = fixture({ modify({ url }) {
    if (url.pathname === '/v1/user/orders') {
      const offset = Number(url.searchParams.get('offset'));
      assert.equal(url.searchParams.get('limit'), '100');
      return Response.json({ Data: historyRows(offset === 0 ? 100 : 14, offset), Total: 999999 });
    }
  } });
  await buy(f);
  assert.deepEqual(historyCalls(f).map(c => new URL(c.url).searchParams.get('offset')), ['0', '100']);
  assert.equal(f.writes[0].entries[0].baselineOrderIds.length, 114);
  assert.equal(buys(f).length, 1);
});

test('duplicate IDs and repeated sentinel pages fail before intent or paid dispatch', async () => {
  for (const makePage of [
    () => ({ Data: [{ id: 1001 }, { id: '1001' }], Total: 999999 }),
    () => ({ Data: historyRows(100), Total: 999999 }),
  ]) {
    const f = fixture({ modify({ url }) {
      if (url.pathname === '/v1/user/orders') return Response.json(makePage());
    } });
    await assert.rejects(buy(f), knownPrePurchaseFailure);
    assert.equal(buys(f).length, 0);
    assert.equal(f.writes.length, 0);
    assert.equal((await f.adapter.publicStatus()).entries.length, 0);
    assert.ok(historyCalls(f).length <= 2);
  }
});

test('sentinel pagination stops at 500 rows without treating a full last page as complete', async () => {
  const f = fixture({ modify({ url }) {
    if (url.pathname === '/v1/user/orders') {
      return Response.json({ Data: historyRows(100, Number(url.searchParams.get('offset'))), Total: 999999 });
    }
  } });
  await assert.rejects(buy(f), knownPrePurchaseFailure);
  assert.deepEqual(historyCalls(f).map(c => new URL(c.url).searchParams.get('offset')), ['0', '100', '200', '300', '400']);
  assert.equal(buys(f).length, 0);
  assert.equal(f.writes.length, 0);
});

test('other malformed history totals, rows and changed totals fail closed before purchase', async () => {
  const responses = [
    { Data: historyRows(14), Total: 999998 }, { Data: historyRows(14), Total: '999999' },
    { Data: historyRows(14), Total: 501 }, { Data: historyRows(14), Total: 15 },
    { Data: historyRows(14), Total: 13 }, { Data: historyRows(101), Total: 999999 },
    { Data: [null], Total: 999999 }, { Data: [{ id: 0 }], Total: 999999 },
    { Data: {}, Total: 999999 },
  ];
  for (const result of responses) {
    const f = fixture({ modify({ url }) {
      if (url.pathname === '/v1/user/orders') return Response.json(result);
    } });
    await assert.rejects(buy(f), knownPrePurchaseFailure);
    assert.equal(buys(f).length, 0);
    assert.equal(f.writes.length, 0);
  }
  const f = fixture({ modify({ url }) {
    if (url.pathname === '/v1/user/orders') {
      const offset = Number(url.searchParams.get('offset'));
      return Response.json({ Data: historyRows(offset === 0 ? 100 : 14, offset), Total: offset === 0 ? 999999 : 114 });
    }
  } });
  await assert.rejects(buy(f), knownPrePurchaseFailure);
  assert.equal(buys(f).length, 0);
  assert.equal(f.writes.length, 0);
});

test('ordinary history preserves exact totals through the 500-row limit', async () => {
  for (const total of [0, 14, 100, 114, 500]) {
    const f = fixture({ modify({ url }) {
      if (url.pathname === '/v1/user/orders') {
        const offset = Number(url.searchParams.get('offset'));
        return Response.json({ Data: historyRows(Math.min(100, total - offset), offset), Total: total });
      }
    } });
    await buy(f);
    assert.equal(f.writes[0].entries[0].baselineOrderIds.length, total);
    assert.equal(buys(f).length, 1);
  }
});

test('history transport error is a redacted known non-dispatch with no automatic retry', async () => {
  const f = fixture({ modify({ url }) {
    if (url.pathname === '/v1/user/orders') throw new Error(`${TOKEN} ${PHONE}`);
  } });
  await assert.rejects(buy(f), error => {
    knownPrePurchaseFailure(error);
    for (const secret of [TOKEN, PHONE]) assert.equal(String(error).includes(secret), false);
    return true;
  });
  assert.equal(f.calls.length, 1);
  assert.equal(f.writes.length, 0);
  assert.equal(buys(f).length, 0);
});

test('an uncertain paid response after sentinel history still reserves budget and blocks rebuy', async () => {
  const f = fixture({ modify({ url }) {
    if (url.pathname === '/v1/user/orders') return Response.json({ Data: historyRows(14), Total: 999999 });
    if (url.pathname.includes('/buy/')) throw new Error('lost response');
  } });
  await assert.rejects(buy(f), error => {
    assert.equal(error.message, 'purchase_uncertain_reconcile_required');
    assert.notEqual(error.dispatched, false);
    return true;
  });
  await assert.rejects(buy(f), /reconciliation_required/);
  const status = await f.adapter.publicStatus();
  assert.equal(status.reservedMinor, 10);
  assert.equal(status.needsReconciliation, true);
  assert.equal(buys(f).length, 1);
});

function namedFixture({ modify, approval, configure, persist } = {}) {
  const f = fixture({ maxPurchases: 1, persist, modify: async context => {
    const override = await modify?.(context);
    if (override !== undefined) return override;
    if (context.url.pathname === '/v1/guest/prices') {
      return Response.json({ poland: { zabkajush: { virtual53: { cost: '0.1538', count: 4, rate: 69.01 } } } });
    }
    if (context.url.pathname.includes('/buy/')) {
      const row = context.makeOrder({ price: '0.1538', operator: 'virtual53' });
      context.orders.push(row);
      return Response.json(row);
    }
  } });
  Object.assign(f.budget, { currency: 'USD', exponent: 6, totalMinor: 200000, perOrderMinor: 200000 });
  f.service.product = 'zabkajush';
  f.options.approvedNamedOperator = approval ?? { operator: 'virtual53', expectedPriceMinor: 153800,
    approvalId: 'virtual53-test', priceCapNotEnforcedAcknowledged: true };
  configure?.(f);
  f.adapter = createFiveSimAdapter(f.options);
  return f;
}
const buyNamed = f => f.adapter.buy({ operator: 'virtual53', onPhone() {} });

test('explicit named approval uses fresh exact offer after history, durable quote and no maxPrice', async () => {
  const f = namedFixture({ modify({ url, options, writes }) {
    if (url.pathname === '/v1/guest/prices') {
      assert.equal(options.headers.Authorization, undefined);
      assert.equal(url.searchParams.get('country'), 'poland');
      assert.equal(url.searchParams.get('product'), 'zabkajush');
    }
    if (url.pathname.includes('/buy/')) {
      assert.equal(url.pathname, '/v1/user/buy/activation/poland/virtual53/zabkajush');
      assert.equal(url.search, '');
      const e = writes.at(-1).entries[0];
      assert.equal(e.phase, 'buy_pending');
      assert.equal(e.operator, 'virtual53');
      assert.equal(e.approvalId, 'virtual53-test');
      assert.equal(e.capMechanism, 'fresh_quote_only_not_provider_enforced');
      assert.equal(e.quotedPriceMinor, 153800);
      assert.equal(e.quotedAt, 1_800_000_000_000);
    }
  } });
  const result = await buyNamed(f);
  assert.deepEqual(f.calls.map(c => new URL(c.url).pathname), [
    '/v1/user/orders', '/v1/guest/prices', '/v1/user/buy/activation/poland/virtual53/zabkajush',
  ]);
  assert.equal(result.costMinor, 153800);
  assert.equal(result.priceVariance, false);
  await assert.rejects(buyNamed(f), /sms_purchase_limit/);
  assert.equal(buys(f).length, 1);
});

test('named approval must match operator, explicit risk acceptance, cap and one-purchase policy', async () => {
  const invalid = [
    { priceCapNotEnforcedAcknowledged: false }, { operator: 'virtual51' },
    { expectedPriceMinor: 200001 }, { expectedPriceMinor: -1 }, { approvalId: '' },
  ];
  for (const patch of invalid) {
    const f = namedFixture({ configure(f) { Object.assign(f.options.approvedNamedOperator, patch); } });
    await assert.rejects(buyNamed(f), /invalid_named_operator_approval/);
    assert.equal(f.calls.length, 0);
  }
  const multi = namedFixture({ configure(f) { f.budget.authorization.maxPurchases = 2; } });
  await assert.rejects(buyNamed(multi), /invalid_named_operator_approval/);
  const approved = namedFixture();
  await assert.rejects(buy(approved), /approved_operator_required/);
  await assert.rejects(approved.adapter.buy({ operator: 'virtual51', onPhone() {} }), /named_operator_price_cap_unsupported/);
  assert.equal(approved.calls.length, 0);
});

test('named quote mismatch or missing stock blocks without paid intent or fallback', async () => {
  for (const offer of [{ cost: '0.1539', count: 4 }, { cost: '0.1537', count: 4 },
    { cost: '0.1538', count: 0 }, { cost: '0.1538' }, undefined]) {
    const f = namedFixture({ modify({ url }) {
      if (url.pathname === '/v1/guest/prices') return Response.json({ poland: { zabkajush: { virtual53: offer } } });
    } });
    await assert.rejects(buyNamed(f), knownPrePurchaseFailure);
    assert.equal(buys(f).length, 0);
    assert.equal(f.writes.length, 0);
    assert.equal(f.calls.length, 2);
  }
});

test('slow named quote and quote expired during durable write never dispatch a purchase', async () => {
  let slow;
  slow = namedFixture({ modify({ url }) {
    if (url.pathname === '/v1/guest/prices') slow.advance(5001);
  } });
  await assert.rejects(buyNamed(slow), error => {
    knownPrePurchaseFailure(error); assert.equal(error.reason, 'named_operator_quote_stale'); return true;
  });
  assert.equal(slow.writes.length, 0); assert.equal(buys(slow).length, 0);
  let delayed;
  delayed = namedFixture({ persist(s) { if (s.entries[0]?.phase === 'buy_pending') delayed.advance(5001); } });
  await assert.rejects(buyNamed(delayed), knownPrePurchaseFailure);
  assert.equal(buys(delayed).length, 0);
  const status = await delayed.adapter.publicStatus();
  assert.equal(status.entries[0].state, 'not_dispatched');
  assert.equal(status.knownCostMinor, 0);
  assert.equal(status.needsReconciliation, true);
  await assert.rejects(buyNamed(delayed), /reconciliation_required/);
});

test('named approval and exact price bind the durable policy across restarts', async () => {
  const f = namedFixture();
  await buyNamed(f);
  assert.deepEqual(f.writes[0].policy.approvedNamedOperator, f.options.approvedNamedOperator);
  for (const patch of [{ approvalId: 'different-approval' }, { expectedPriceMinor: 153900 }]) {
    const sibling = createFiveSimAdapter({ ...f.options, approvedNamedOperator: { ...f.options.approvedNamedOperator, ...patch } });
    const calls = f.calls.length;
    await assert.rejects(sibling.buy({ operator: 'virtual53', onPhone() {} }), /store_policy_mismatch/);
    assert.equal(f.calls.length, calls);
  }
  const absent = createFiveSimAdapter({ ...f.options, approvedNamedOperator: undefined });
  await assert.rejects(absent.buy({ onPhone() {} }), /store_policy_mismatch/);
  const regular = fixture(); await buy(regular);
  assert.equal(Object.hasOwn(regular.writes[0].policy, 'approvedNamedOperator'), false);
});

test('actual named price or operator variance retains charge, blocks phone delivery and survives reconciliation', async () => {
  for (const patch of [{ price: '0.1540' }, { price: '0.1500' }, { operator: 'virtual51' }]) {
    let phoneCalls = 0;
    const f = namedFixture({ modify({ url, makeOrder, orders }) {
      if (url.pathname.includes('/buy/')) {
        const raw = makeOrder({ price: '0.1538', operator: 'virtual53', ...patch });
        orders.push(raw); return Response.json(raw);
      }
    } });
    await assert.rejects(f.adapter.buy({ operator: 'virtual53', onPhone() { phoneCalls++; } }), /purchase_price_variance_reconcile_required/);
    assert.equal(phoneCalls, 0);
    let status = await f.adapter.publicStatus();
    assert.equal(status.knownCostMinor, priceToMinor(patch.price ?? '0.1538', 6));
    assert.equal(status.needsReconciliation, true);
    const result = await f.adapter.reconcile({ reservationId: status.entries[0].reservationId });
    assert.equal(result.reconciled, false);
    await assert.rejects(buyNamed(f), /reconciliation_required/);
    assert.equal(buys(f).length, 1);
  }
});

test('lost named purchase reply reserves full cap and keeps variance on explicit recovery', async () => {
  const f = namedFixture({ modify({ url, makeOrder, orders }) {
    if (url.pathname.includes('/buy/')) {
      orders.push(makeOrder({ operator: 'virtual53', price: '0.1540' }));
      throw new Error(TOKEN);
    }
  } });
  await assert.rejects(buyNamed(f), /purchase_uncertain_reconcile_required/);
  let status = await f.adapter.publicStatus();
  assert.equal(status.reservedMinor, 200000);
  await assert.rejects(buyNamed(f), /reconciliation_required/);
  const recovered = await f.adapter.reconcile({ reservationId: status.entries[0].reservationId, providerOrderId: '101' });
  assert.equal(recovered.costMinor, 154000);
  assert.equal(recovered.priceVariance, true);
  assert.equal(recovered.reconciled, false);
  await assert.rejects(buyNamed(f), /reconciliation_required/);
  assert.equal(buys(f).length, 1);
});
