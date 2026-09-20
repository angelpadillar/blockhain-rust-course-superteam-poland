import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPilot } from './core.mjs';
import { createHash } from 'node:crypto';

const actor = { customerId: 'customer-a', merchantAccountId: 'account-a' };
const other = { customerId: 'customer-b', merchantAccountId: 'account-b' };
const allowance = { liveQuotes: 10, cartUpdates: 10, modelCalls: 10, runtimeMs: 100000 };
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const rejectCode = (fn, code) => assert.rejects(async () => fn(), { code });

function fixture(options = {}) {
  let now = 1_000_000;
  const cart = new Map([['account-a', [{ productId: 'coffee', quantity: 1 }]], ['account-b', [{ productId: 'coffee', quantity: 1 }]]]);
  const calls = { observe: 0, mutate: 0, quote: 0 };
  const hooks = {};
  const observed = accountId => ({ verified: true, observedAt: now, evidenceRefs: [{ id: `observation-${now}`, observedAt: now }],
    lines: structuredClone(cart.get(accountId)), usage: { modelCalls: 0, modelCostUsd: 0 } });
  const adapter = {
    async catalog() { return { location: null, cacheRetrievedAt: now - 1000, items: [{ productId: 'coffee', title: 'Fixture coffee', priceMinor: 500, currency: 'PLN', privateAccount: 'must-not-leak' }] }; },
    async observeCart(args) { calls.observe++; now++; if (hooks.observe) return hooks.observe(args); return observed(args.accountId); },
    async mutateCart(args) { calls.mutate++; now++; if (hooks.mutate) return hooks.mutate(args); cart.set(args.accountId, structuredClone(args.lines)); return observed(args.accountId); },
    async quote(args) {
      calls.quote++; now++; if (hooks.quote) return hooks.quote(args);
      const value = observed(args.accountId);
      const configured = accounts.find(account => account.merchantAccountId === args.accountId);
      const delivery = configured.deliveryCommitment ?? configured.delivery;
      value.deliveryCommitment = typeof delivery === 'string' && /^[a-f0-9]{64}$/.test(delivery) ? delivery
        : createHash('sha256').update('delio-server-delivery:v1\0').update(JSON.stringify(delivery)).digest('hex');
      value.lines = value.lines.map(line => ({ ...line, unitPriceMinor: 500, lineTotalMinor: line.quantity * 500 }));
      const subtotal = value.lines.reduce((sum, line) => sum + line.lineTotalMinor, 0);
      return { ...value, currency: 'PLN', expiresAt: now + 60000,
        couponResults: args.coupon ? [{ code: args.coupon, accepted: true, discountMinor: 60 }] : [], amounts: { itemSubtotalMinor: subtotal,
        deliveryFeeMinor: 100, serviceFeeMinor: 20, smallOrderFeeMinor: 30, otherFeesMinor: 0,
        depositsMinor: 10, discountMinor: 60, merchantTotalMinor: subtotal + 100 } };
    },
  };
  const accounts = options.accounts || [actor, other].map(a => ({ ...a, allowance: { ...allowance },
    deliveryCommitment: { privateAddress: 'private-fixture-address' }, couponCode: 'private-fixture-coupon' }));
  const config = { adapter, accounts, clock: () => now, buenaFeeMinor: 49, ...options };
  const pilot = createPilot(config);
  return { pilot, config, adapter, hooks, calls, cart, observed, now: () => now, advance: ms => { now += ms; } };
}

async function quoted(f, a = actor) { const s = await f.pilot.reconcile(a); return f.pilot.refreshQuote(a, { version: s.version }); }

test('public catalogue is explicitly cached/non-personalized and every cart method enforces registry ownership', async () => {
  const f = fixture();
  const catalog = await f.pilot.catalog();
  assert.equal(catalog.source, 'cached_public_catalog'); assert.equal(catalog.personalized, false); assert.equal(catalog.verified, false);
  assert.equal(catalog.location, null); assert.equal(catalog.cacheRetrievedAt, f.now() - 1000);
  assert.equal(catalog.items[0].privateAccount, undefined);
  const forged = { ...actor, merchantAccountId: other.merchantAccountId, allowance: { liveQuotes: 999999 } };
  for (const invoke of [() => f.pilot.getState(forged), () => f.pilot.reconcile(forged),
    () => f.pilot.updateCart(forged, { version: 0, lines: [] }), () => f.pilot.refreshQuote(forged, { version: 0 }),
    () => f.pilot.authorizeQuote(forged, { quoteId: 'q', version: 0 }, () => {})]) await rejectCode(invoke, 'account_not_owned');
  assert.deepEqual(f.calls, { observe: 0, mutate: 0, quote: 0 });
});

test('client prices, ownership, scripts, coupons and delivery fields cannot enter trusted requests', async () => {
  const f = fixture(); await f.pilot.reconcile(actor);
  for (const extra of [{ priceMinor: 1 }, { customerId: 'customer-b' }, { coupon: 'CLIENT' }, { delivery: 'elsewhere' }, { script: 'click()' }]) {
    await rejectCode(() => f.pilot.updateCart(actor, { version: 1, lines: [], ...extra }), 'invalid_request_fields');
    await rejectCode(() => f.pilot.refreshQuote(actor, { version: 1, ...extra }), 'invalid_request_fields');
  }
  await rejectCode(() => f.pilot.updateCart(actor, { version: 1, lines: [{ productId: 'coffee', quantity: 1, unitPriceMinor: 1 }] }), 'invalid_request_fields');
  await rejectCode(() => f.pilot.updateCart(actor, { version: 1, lines: [{ productId: 'https://evil.test/script', quantity: 1 }] }), 'invalid_cart_lines');
  assert.equal(f.calls.mutate, 0); assert.equal(f.calls.quote, 0);
});

test('full observed fee arithmetic, deposits, discount and Buena fee bind a verified expiring quote', async () => {
  const f = fixture(); const state = await quoted(f);
  assert.deepEqual(state.quote.amounts, { itemSubtotalMinor: 500, deliveryFeeMinor: 100, serviceFeeMinor: 20,
    smallOrderFeeMinor: 30, otherFeesMinor: 0, depositsMinor: 10, discountMinor: 60, merchantTotalMinor: 600, buenaFeeMinor: 49, totalMinor: 649 });
  assert.equal(state.quote.status, 'verified'); assert.equal(state.usage.liveQuotes, 1);
  assert.equal(state.quote.customerId, actor.customerId); assert.equal(state.quote.merchantAccountId, actor.merchantAccountId);
  assert.match(state.quote.deliveryCommitment, /^[a-f0-9]{64}$/);
  assert.deepEqual(state.quote.couponResults, [{ code: 'private-fixture-coupon', accepted: true, discountMinor: 60 }]);
  let invoked = 0;
  const authorized = await f.pilot.authorizeQuote(actor, { quoteId: state.quote.quoteId, version: state.version }, async quote => {
    invoked++; assert.equal(Object.isFrozen(quote.amounts), true); assert.equal(quote.amounts.totalMinor, 649);
    return { accepted: true, proof: { backend: 'local-fixture-only' } };
  });
  assert.equal(authorized.authorization.status, 'authorized');
  await rejectCode(() => f.pilot.authorizeQuote(actor, { quoteId: state.quote.quoteId, version: state.version }, () => { invoked++; }), 'quote_already_authorized');
  assert.equal(invoked, 1);
});

test('quantity change/removal invalidate authorization and old quote/version; concurrent edits cannot overwrite silently', async () => {
  const f = fixture(); const initial = await quoted(f);
  const entered = deferred(), gate = deferred();
  f.hooks.mutate = async args => { entered.resolve(); await gate.promise; f.cart.set(args.accountId, args.lines); return f.observed(args.accountId); };
  const first = f.pilot.updateCart(actor, { version: initial.version, lines: [{ productId: 'coffee', quantity: 2 }] });
  await entered.promise;
  const stale = f.pilot.updateCart(actor, { version: initial.version, lines: [{ productId: 'coffee', quantity: 3 }] });
  const rejected = rejectCode(() => stale, 'stale_cart_version');
  gate.resolve(); const state = await first; await rejected;
  assert.equal(f.calls.mutate, 1); assert.equal(state.version, initial.version + 1); assert.equal(state.quote, null);
  await rejectCode(() => f.pilot.authorizeQuote(actor, { quoteId: initial.quote.quoteId, version: initial.version }, () => {}), 'stale_cart_version');
  delete f.hooks.mutate;
  const empty = await f.pilot.updateCart(actor, { version: state.version, lines: [{ productId: 'coffee', quantity: 0 }] });
  assert.deepEqual(empty.cart.lines, []); assert.equal(empty.authorization, null);
});

test('uncertain mutation is never repeated automatically and requires a new observed reconciliation', async () => {
  const f = fixture(); await f.pilot.reconcile(actor);
  f.hooks.mutate = async args => { f.cart.set(args.accountId, args.lines); throw new Error('response lost after application'); };
  await rejectCode(() => f.pilot.updateCart(actor, { version: 1, lines: [{ productId: 'coffee', quantity: 2 }] }), 'worker_outcome_uncertain');
  let state = f.pilot.getState(actor);
  assert.equal(state.cart.status, 'needs_reconciliation'); assert.equal(f.calls.mutate, 1); assert.equal(state.version, 2);
  await rejectCode(() => f.pilot.updateCart(actor, { version: state.version, lines: [] }), 'cart_requires_reconciliation');
  await rejectCode(() => f.pilot.refreshQuote(actor, { version: state.version }), 'cart_requires_reconciliation');
  state = await f.pilot.reconcile(actor);
  assert.equal(state.version, 3); assert.deepEqual(state.cart.lines, [{ productId: 'coffee', quantity: 2 }]);
  assert.equal(f.calls.mutate, 1); assert.equal(f.calls.observe, 2);
  delete f.hooks.mutate;
  await f.pilot.updateCart(actor, { version: 3, lines: [] }); assert.equal(f.calls.mutate, 2);
});

test('estimates and incomplete/unobserved components cannot be authorized as an actual quote', async () => {
  for (const mode of ['estimate', 'missing-fee', 'bad-total', 'no-timestamp', 'missing-evidence']) {
    const f = fixture(); await f.pilot.reconcile(actor);
    const original = f.adapter.quote.bind(f.adapter);
    f.adapter.quote = async args => {
      const q = await original(args);
      if (mode === 'estimate') { q.verified = false; q.amounts.deliveryFeeMinor = null; q.amounts.merchantTotalMinor = null; }
      if (mode === 'missing-fee') delete q.amounts.depositsMinor;
      if (mode === 'bad-total') q.amounts.merchantTotalMinor++;
      if (mode === 'no-timestamp') delete q.evidenceRefs[0].observedAt;
      if (mode === 'missing-evidence') q.evidenceRefs = [];
      return q;
    };
    if (mode === 'estimate') {
      const state = await f.pilot.refreshQuote(actor, { version: 1 });
      assert.equal(state.quote.status, 'estimate'); assert.equal(state.quote.amounts.totalMinor, null);
      await rejectCode(() => f.pilot.authorizeQuote(actor, { version: 1, quoteId: state.quote.quoteId }, () => {}), 'verified_quote_required');
    } else {
      await assert.rejects(() => f.pilot.refreshQuote(actor, { version: 1 }));
      assert.equal(f.pilot.getState(actor).quote, null);
    }
  }
});

test('quote age/expiry and merchant cart drift are checked before authorization', async () => {
  const f = fixture(); const state = await quoted(f);
  f.advance(state.quote.expiresAt - f.now());
  let calls = 0;
  await rejectCode(() => f.pilot.authorizeQuote(actor, { quoteId: state.quote.quoteId, version: state.version }, () => { calls++; }), 'quote_expired');
  assert.equal(calls, 0);
  f.cart.set(actor.merchantAccountId, [{ productId: 'coffee', quantity: 2 }]);
  await rejectCode(() => f.pilot.refreshQuote(actor, { version: 1 }), 'quote_cart_mismatch');
  assert.equal(f.pilot.getState(actor).cart.status, 'needs_reconciliation');
});

test('account lock excludes cart edits throughout authorization callback', async () => {
  const f = fixture(); const state = await quoted(f), entered = deferred(), gate = deferred();
  const auth = f.pilot.authorizeQuote(actor, { version: 1, quoteId: state.quote.quoteId }, async () => { entered.resolve(); await gate.promise; return { accepted: true, proof: { local: true } }; });
  await entered.promise;
  const edit = f.pilot.updateCart(actor, { version: 1, lines: [{ productId: 'coffee', quantity: 2 }] });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(f.calls.mutate, 0);
  gate.resolve(); assert.equal((await auth).authorization.status, 'authorized');
  const changed = await edit; assert.equal(changed.authorization, null); assert.equal(changed.quote, null);
});

test('uncertain authorization preserves its identity and blocks further changes', async () => {
  const f = fixture(); const state = await quoted(f);
  await rejectCode(() => f.pilot.authorizeQuote(actor, { version: 1, quoteId: state.quote.quoteId }, async () => { throw new Error('signed but response lost'); }), 'worker_outcome_uncertain');
  assert.equal(f.pilot.getState(actor).authorization.status, 'uncertain');
  assert.equal(f.pilot.getState(actor).authorization.quoteId, state.quote.quoteId);
  await rejectCode(() => f.pilot.updateCart(actor, { version: 1, lines: [] }), 'authorization_requires_review');
});

test('global quote/cart/concurrency and shared customer model/runtime caps reserve before launching workers', async () => {
  const f = fixture({ limits: { maxConcurrent: 2, cartUpdates: 1 } });
  await f.pilot.reconcile(actor); await f.pilot.reconcile(other);
  const entered = deferred(), gate = deferred();
  f.hooks.mutate = async args => { entered.resolve(); await gate.promise; f.cart.set(args.accountId, args.lines); return f.observed(args.accountId); };
  const first = f.pilot.updateCart(actor, { version: 1, lines: [] }); await entered.promise;
  await rejectCode(() => f.pilot.updateCart(other, { version: 1, lines: [] }), 'cartUpdates_budget_exhausted');
  assert.equal(f.calls.mutate, 1); gate.resolve(); await first;
  const q = fixture({ limits: { liveQuotes: 1 } }); await quoted(q);
  await rejectCode(() => q.pilot.refreshQuote(actor, { version: 1 }), 'liveQuotes_budget_exhausted'); assert.equal(q.calls.quote, 1);
  const limited = fixture({ limits: { modelCalls: 0, modelCallsPerOperation: { quote: 1 } } }); await limited.pilot.reconcile(actor);
  await rejectCode(() => limited.pilot.refreshQuote(actor, { version: 1 }), 'modelCalls_budget_exhausted'); assert.equal(limited.calls.quote, 0);
  const noRuntime = fixture({ accounts: [{ ...actor, allowance: { ...allowance, runtimeMs: 0 } }] });
  await rejectCode(() => noRuntime.pilot.reconcile(actor), 'runtime_budget_exhausted'); assert.equal(noRuntime.calls.observe, 0);
  const busy = fixture(); const busyGate = deferred(), busyEntered = deferred();
  busy.hooks.observe = async args => { busyEntered.resolve(); await busyGate.promise; return busy.observed(args.accountId); };
  const work = busy.pilot.reconcile(actor); await busyEntered.promise;
  await rejectCode(() => busy.pilot.reconcile(other), 'global_concurrency_exhausted'); busyGate.resolve(); await work;
});

test('private delivery stays out of public state and cost journal distinguishes known/estimated/unknown', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'delio-core-'));
  try {
    const f = fixture({ storeDir: directory, limits: { modelCallsPerOperation: { quote: 1 } } });
    await f.pilot.reconcile(actor);
    const original = f.adapter.quote.bind(f.adapter);
    f.adapter.quote = async args => {
      assert.equal(args.coupon, 'private-fixture-coupon'); assert.deepEqual(args.delivery, { privateAddress: 'private-fixture-address' });
      const q = await original(args); q.usage = { modelCalls: 1, estimatedModelCostUsd: 0.002 }; return q;
    };
    await f.pilot.refreshQuote(actor, { version: 1 });
    f.adapter.quote = async args => { const q = await original(args); delete q.usage; return q; };
    await f.pilot.refreshQuote(actor, { version: 1 });
    const state = f.pilot.getState(actor), text = JSON.stringify(state), journal = await readFile(join(directory, 'attempts.jsonl'), 'utf8');
    assert.equal(state.costs.estimatedModelCostUsd, 0.002); assert.equal(state.costs.unknownAttempts, 1); assert.equal(state.usage.modelCalls, 2);
    assert.equal(text.includes('private-fixture-address'), false); assert.equal(journal.includes('private-fixture'), false);
    assert.match(journal, /"status":"estimated"/); assert.match(journal, /"status":"unknown"/);
    const reopened = createPilot(f.config);
    assert.equal(reopened.getState(actor).usage.liveQuotes, 2); assert.equal(reopened.getState(actor).usage.modelCalls, 2);
    reopened.stop('test_stop');
    await rejectCode(() => reopened.refreshQuote(actor, { version: 1 }), 'pilot_stopped');
    assert.equal(createPilot(f.config).getState(actor).stopped.reason, 'test_stop');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('configured coupons need explicit observed acceptance/rejection and exact discount attribution', async () => {
  for (const mode of ['missing', 'different', 'mismatch', 'rejected']) {
    const f = fixture(); await f.pilot.reconcile(actor);
    const original = f.adapter.quote.bind(f.adapter);
    f.adapter.quote = async args => {
      const q = await original(args);
      if (mode === 'missing') delete q.couponResults;
      if (mode === 'different') q.couponResults[0].code = 'another-coupon';
      if (mode === 'mismatch') q.couponResults[0].discountMinor = 75;
      if (mode === 'rejected') {
        q.couponResults = [{ code: args.coupon, accepted: false, discountMinor: 0, reason: 'not_eligible' }];
        q.amounts.discountMinor = 0; q.amounts.merchantTotalMinor = 660;
      }
      return q;
    };
    if (mode === 'rejected') {
      const state = await f.pilot.refreshQuote(actor, { version: 1 });
      assert.equal(state.quote.amounts.discountMinor, 0); assert.equal(state.quote.amounts.totalMinor, 709);
      assert.equal(state.quote.couponResults[0].accepted, false);
    } else await assert.rejects(() => f.pilot.refreshQuote(actor, { version: 1 }));
  }
  const f = fixture({ accounts: [{ ...actor, allowance, delivery: 'private configured delivery', deliveryCommitment: 'ab'.repeat(32) }] });
  const q = await quoted(f);
  assert.equal(q.quote.deliveryCommitment, 'ab'.repeat(32));
  assert.equal(q.quote.couponStatus, 'not_provided'); assert.deepEqual(q.quote.couponResults, []);
});

test('known pre-dispatch blockers retain their codes and do not falsely require cart reconciliation', async () => {
  const f = fixture();
  f.hooks.observe = async () => { throw Object.assign(new Error('private detail must not escape'), { code: 'merchant_session_required', dispatched: false }); };
  await rejectCode(() => f.pilot.reconcile(actor), 'merchant_session_required');
  assert.equal(f.pilot.getState(actor).cart.status, 'unobserved');
  delete f.hooks.observe; await f.pilot.reconcile(actor);
  f.hooks.mutate = async () => { throw Object.assign(new Error('unknown_product_id'), { code: 'unknown_product_id', dispatched: false }); };
  await rejectCode(() => f.pilot.updateCart(actor, { version: 1, lines: [] }), 'unknown_product_id');
  const state = f.pilot.getState(actor);
  assert.equal(state.cart.status, 'observed'); assert.deepEqual(state.cart.lines, [{ productId: 'coffee', quantity: 1 }]);
  assert.equal(state.version, 2); assert.equal(state.costs.unknownAttempts, 0);
});

test('valid no-dispatch error usage is known while uncertain or invalid reports retain the model reservation', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'delio-error-usage-'));
  try {
    const f = fixture({ storeDir: directory, limits: { modelCallsPerOperation: { observeCart: 1 } } });
    let failure = { code: 'merchant_session_required', dispatched: false, usage: { modelCalls: 0, modelCostUsd: 0 } };
    f.hooks.observe = async () => { throw Object.assign(new Error('sanitized blocker'), failure); };
    await rejectCode(() => f.pilot.reconcile(actor), 'merchant_session_required');
    let state = f.pilot.getState(actor);
    assert.equal(state.usage.modelCalls, 0); assert.equal(state.costs.unknownAttempts, 0);

    failure = { code: 'transport_lost', usage: { modelCalls: 0, modelCostUsd: 0 } };
    await rejectCode(() => f.pilot.reconcile(actor), 'worker_outcome_uncertain');
    state = f.pilot.getState(actor);
    assert.equal(state.usage.modelCalls, 1); assert.equal(state.costs.unknownAttempts, 1);

    failure = { code: 'merchant_session_required', dispatched: false, usage: { modelCalls: -1, modelCostUsd: 0 } };
    await rejectCode(() => f.pilot.reconcile(actor), 'merchant_session_required');
    state = f.pilot.getState(actor);
    assert.equal(state.usage.modelCalls, 2); assert.equal(state.costs.unknownAttempts, 2);

    const events = (await readFile(join(directory, 'attempts.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse)
      .filter(event => event.type === 'worker_end');
    assert.deepEqual(events.map(event => event.cost.status), ['known', 'unknown', 'unknown']);
    assert.deepEqual(events.map(event => event.modelCalls), [
      { status: 'known', value: 0 }, { status: 'unknown', value: 1 }, { status: 'unknown', value: 1 },
    ]);

    failure = { code: 'merchant_session_required', dispatched: false, usage: { modelCalls: 2, modelCostUsd: 0.001 } };
    await rejectCode(() => f.pilot.reconcile(actor), 'merchant_session_required');
    state = f.pilot.getState(actor);
    assert.equal(state.usage.modelCalls, 4); assert.equal(state.stopped.reason, 'adapter_budget_violation');
    await rejectCode(() => f.pilot.reconcile(other), 'pilot_stopped');
    assert.equal(f.calls.observe, 4);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('customer limits cannot be elevated by actor fields or by switching registered merchant accounts', async () => {
  const second = { ...actor, merchantAccountId: 'account-b' };
  const f = fixture({ accounts: [actor, second].map(a => ({ ...a, deliveryCommitment: 'cd'.repeat(32), allowance: { ...allowance, liveQuotes: 1 } })) });
  await f.pilot.reconcile(actor); await f.pilot.reconcile(second);
  await f.pilot.refreshQuote(actor, { version: 1 });
  await rejectCode(() => f.pilot.refreshQuote({ ...second, allowance: { ...allowance, liveQuotes: 9999 } }, { version: 1 }), 'liveQuotes_budget_exhausted');
  assert.equal(f.calls.quote, 1); assert.equal(f.pilot.getState(second).usage.liveQuotes, 1);
});

test('deadline abort keeps an uncertain mutation stopped and does not launch or apply a late automatic retry', async () => {
  const f = fixture({ limits: { operationRuntimeMs: 40 } });
  await f.pilot.reconcile(actor);
  const gate = deferred(); let receivedSignal;
  f.hooks.mutate = async args => { receivedSignal = args.signal; await gate.promise; return f.observed(args.accountId); };
  await rejectCode(() => f.pilot.updateCart(actor, { version: 1, lines: [] }), 'worker_outcome_uncertain');
  let state = f.pilot.getState(actor);
  assert.equal(receivedSignal.aborted, true); assert.equal(state.stopped.reason, 'worker_timeout');
  assert.equal(state.cart.status, 'needs_reconciliation'); assert.equal(state.workerActive, 1); assert.equal(f.calls.mutate, 1);
  await rejectCode(() => f.pilot.updateCart(actor, { version: 2, lines: [] }), 'pilot_stopped');
  gate.resolve(); await new Promise(resolve => setImmediate(resolve));
  state = f.pilot.getState(actor); assert.equal(state.workerActive, 0); assert.equal(state.cart.status, 'needs_reconciliation');
  assert.equal(f.calls.mutate, 1);
});

test('abort-triggered transport rejection cannot release the global stop for another account', async () => {
  const f = fixture({ limits: { operationRuntimeMs: 40, modelCallsPerOperation: { observeCart: 1 } } });
  f.hooks.observe = ({ signal }) => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => reject(Object.assign(new Error('transport ended'), {
      code: 'transport_lost', dispatched: false, usage: { modelCalls: 0, modelCostUsd: 0 },
    })), { once: true });
  });
  await rejectCode(() => f.pilot.reconcile(actor), 'worker_outcome_uncertain');
  await new Promise(resolve => setImmediate(resolve));
  const state = f.pilot.getState(actor);
  assert.equal(state.workerActive, 0); assert.equal(state.stopped.reason, 'worker_timeout');
  assert.equal(state.usage.modelCalls, 1); assert.equal(state.costs.unknownAttempts, 1);
  await rejectCode(() => f.pilot.reconcile(other), 'pilot_stopped');
  assert.equal(f.calls.observe, 1);
});

test('public cache retrieval time is preserved separately from unknown live observation/location', async () => {
  const f = fixture();
  f.adapter.catalog = async () => ({ cacheRetrievedAt: '2026-09-19T09:06:00Z', observedAt: null, location: null,
    sourceUrl: 'https://example.test/catalog', note: 'Public cached fixture snapshot only', items: [] });
  const catalog = await f.pilot.catalog();
  assert.equal(catalog.cacheRetrievedAt, '2026-09-19T09:06:00Z'); assert.equal(catalog.observedAt, null); assert.equal(catalog.location, null);
});

test('only successful verified quotes produce quote_verified accounting events', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'delio-quote-journal-'));
  try {
    const f = fixture({ storeDir: directory }); await quoted(f);
    const original = f.adapter.quote.bind(f.adapter);
    f.adapter.quote = async args => ({ ...await original(args), verified: false });
    await f.pilot.refreshQuote(actor, { version: 1 });
    const events = (await readFile(join(directory, 'attempts.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
    assert.equal(events.filter(event => event.type === 'quote_verified').length, 1);
    assert.equal(events.filter(event => event.type === 'quote_estimated').length, 1);
    const verified = events.find(event => event.type === 'quote_verified');
    assert.equal(verified.totalMinor, 649); assert.equal(verified.customerId, actor.customerId);
    assert.equal(verified.evidenceRefs.length, 1);
    for (const end of events.filter(event => event.type === 'worker_end')) {
      assert.equal(end.customerId, actor.customerId); assert.equal(end.merchantAccountId, actor.merchantAccountId);
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('verified quotes require the adapter to attest the configured delivery commitment', async () => {
  for (const missing of [true, false]) {
    const f = fixture(); await f.pilot.reconcile(actor);
    const original = f.adapter.quote.bind(f.adapter);
    f.adapter.quote = async args => {
      const value = await original(args);
      if (missing) delete value.deliveryCommitment; else value.deliveryCommitment = 'ff'.repeat(32);
      return value;
    };
    await rejectCode(() => f.pilot.refreshQuote(actor, { version: 1 }), 'delivery_commitment_mismatch');
    assert.equal(f.pilot.getState(actor).quote, null);
  }
});

test('definite pre-authorization failure leaves quote usable and preserves its blocker', async () => {
  const f = fixture(); const state = await quoted(f);
  await rejectCode(() => f.pilot.authorizeQuote(actor, { version: 1, quoteId: state.quote.quoteId }, async () => {
    throw Object.assign(new Error('live_quote_evidence_not_available'), { code: 'live_quote_evidence_not_available', dispatched: false });
  }), 'live_quote_evidence_not_available');
  assert.equal(f.pilot.getState(actor).authorization, null);
  assert.equal(f.pilot.getState(actor).quote.quoteId, state.quote.quoteId);
  const result = await f.pilot.authorizeQuote(actor, { version: 1, quoteId: state.quote.quoteId }, async () => ({ accepted: true, proof: { local: true } }));
  assert.equal(result.authorization.status, 'authorized');
});

test('restart invalidates quotes/authorization on delivery, coupon, allowance or fee configuration changes without resetting spend', async () => {
  for (const change of ['delivery', 'coupon', 'allowance', 'fee']) {
    const directory = await mkdtemp(join(tmpdir(), 'delio-registry-'));
    try {
      const f = fixture({ storeDir: directory }); const before = await quoted(f);
      await f.pilot.authorizeQuote(actor, { version: 1, quoteId: before.quote.quoteId }, async () => ({ accepted: true, proof: { local: true } }));
      const same = createPilot(f.config).getState(actor);
      assert.equal(same.quote.quoteId, before.quote.quoteId); assert.equal(same.authorization.status, 'authorized');
      const config = { ...f.config, accounts: structuredClone(f.config.accounts) };
      if (change === 'delivery') config.accounts[0].deliveryCommitment.privateAddress = 'changed-private-address';
      if (change === 'coupon') config.accounts[0].couponCode = 'changed-private-coupon';
      if (change === 'allowance') config.accounts[0].allowance.liveQuotes--;
      if (change === 'fee') config.buenaFeeMinor++;
      const reopened = createPilot(config), state = reopened.getState(actor);
      assert.equal(state.version, 2); assert.equal(state.quote, null); assert.equal(state.authorization, null);
      assert.equal(state.cart.status, 'needs_reconciliation'); assert.equal(state.usage.liveQuotes, 1);
      await rejectCode(() => reopened.authorizeQuote(actor, { version: 1, quoteId: before.quote.quoteId }, () => {}), 'cart_requires_reconciliation');
      const journal = await readFile(join(directory, 'attempts.jsonl'), 'utf8');
      assert.match(journal, /account_configuration_changed/); assert.equal(journal.includes('changed-private'), false);
    } finally { await rm(directory, { recursive: true, force: true }); }
  }
});
