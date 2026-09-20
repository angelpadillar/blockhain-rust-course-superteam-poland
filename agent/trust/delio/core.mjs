import { createHash, randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { normalizeCatalogue } from './catalogue.mjs';
import { validateCheckoutStock } from './stock-proof.mjs';

const COUNTERS = ['liveQuotes', 'cartUpdates', 'modelCalls', 'runtimeMs'];
const AMOUNTS = ['itemSubtotalMinor', 'deliveryFeeMinor', 'serviceFeeMinor', 'smallOrderFeeMinor',
  'otherFeesMinor', 'depositsMinor', 'discountMinor', 'merchantTotalMinor'];
const DEFAULTS = { maxConcurrent: 1, operationRuntimeMs: 30_000, liveQuotes: 20, cartUpdates: 40,
  modelCalls: 40, runtimeMs: 600_000, maxQuoteAgeMs: 120_000, maxQuoteTtlMs: 300_000, maxLines: 50, maxQuantity: 20 };
const emptyUsage = () => Object.fromEntries(COUNTERS.map(key => [key, 0]));
const emptyCosts = () => ({ attempts: 0, knownModelCostUsd: 0, estimatedModelCostUsd: 0, unknownAttempts: 0 });
const clone = value => structuredClone(value);
const fail = code => { throw Object.assign(new Error(code), { code }); };
const integer = value => Number.isSafeInteger(value) && value >= 0 && !Object.is(value, -0);
const id = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)
  && !['constructor', 'prototype', '__proto__'].includes(value);
const plain = value => value && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
function exact(value, keys) {
  if (!plain(value) || Reflect.ownKeys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) fail('invalid_request_fields');
}
function safeSum(values) {
  const total = values.reduce((sum, value) => sum + BigInt(value), 0n);
  if (total < 0n || total > BigInt(Number.MAX_SAFE_INTEGER)) fail('amount_overflow');
  return Number(total);
}
function immutable(value) {
  for (const child of Object.values(value)) if (child && typeof child === 'object') immutable(child);
  return Object.freeze(value);
}
function canonicalConfig(input) {
  if (plain(input)) return `{${Object.keys(input).sort().map(key => `${JSON.stringify(key)}:${canonicalConfig(input[key])}`).join(',')}}`;
  if (Array.isArray(input)) return `[${input.map(canonicalConfig).join(',')}]`;
  const encoded = JSON.stringify(input);
  if (encoded === undefined) fail('invalid_account_registry');
  return encoded;
}
function deliveryHash(value) {
  if (typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)) return value;
  if (value === undefined || value === null) fail('delivery_not_configured');
  return createHash('sha256').update('delio-server-delivery:v1\0').update(canonicalConfig(value)).digest('hex');
}

/**
 * Server-owned pilot coordinator. The accounts registry and adapter are trusted
 * configuration, never HTTP request data. Only cached catalog() is anonymous.
 * All 64-bit commerce values must fit safe integer PLN minor units in this pilot.
 * Adapters must honor signal/budget and report usage; no model/provider is called
 * by this module. A timeout stops the pilot and never triggers an automatic retry.
 * No checkout or payment execution method exists here. SMS has its own budget.
 */
export function createPilot({ adapter, storeDir, clock = Date.now, limits = {}, buenaFeeMinor = 0, accounts = [] }) {
  if (!adapter || ['observeCart', 'mutateCart', 'quote'].some(key => typeof adapter[key] !== 'function')
      || typeof clock !== 'function' || !integer(buenaFeeMinor)) fail('invalid_pilot_config');
  const caps = { ...DEFAULTS, ...limits };
  for (const key of Object.keys(DEFAULTS)) if (!integer(caps[key]) || (!COUNTERS.includes(key) && caps[key] === 0)) fail('invalid_limits');
  const models = { observeCart: 0, mutateCart: 0, quote: 0, authorize: 0, ...limits.modelCallsPerOperation };
  for (const value of Object.values(models)) if (!integer(value)) fail('invalid_limits');
  const registry = new Map(), customerCaps = new Map(), tails = new Map(), workers = new Set();
  for (const account of accounts) {
    if (!plain(account) || !id(account.customerId) || !id(account.merchantAccountId) || registry.has(account.merchantAccountId)
        || !plain(account.allowance) || COUNTERS.some(key => !integer(account.allowance[key]))) fail('invalid_account_registry');
    registry.set(account.merchantAccountId, clone(account));
    const previous = customerCaps.get(account.customerId);
    const allowance = Object.fromEntries(COUNTERS.map(key => [key, previous ? Math.min(previous[key], account.allowance[key]) : account.allowance[key]]));
    customerCaps.set(account.customerId, allowance);
  }
  let data = { schema: 1, globalUsage: emptyUsage(), globalCosts: emptyCosts(), customers: {}, states: {}, stopped: null };
  if (storeDir) {
    mkdirSync(storeDir, { recursive: true, mode: 0o700 });
    const path = join(storeDir, 'pilot-state.json');
    if (existsSync(path)) {
      try { data = JSON.parse(readFileSync(path, 'utf8')); } catch { fail('pilot_store_invalid'); }
      if (data.schema !== 1 || !plain(data.states) || !plain(data.customers) || !plain(data.globalUsage)
          || COUNTERS.some(key => !integer(data.globalUsage[key]))) fail('pilot_store_invalid');
    }
  }
  const changedConfigurations = [];
  for (const account of registry.values()) {
    data.customers[account.customerId] ||= { usage: emptyUsage(), costs: emptyCosts() };
    if (COUNTERS.some(key => !integer(data.customers[account.customerId]?.usage?.[key]))) fail('pilot_store_invalid');
    const old = data.states[account.merchantAccountId];
    if (old && old.customerId !== account.customerId) fail('stored_account_owner_mismatch');
    data.states[account.merchantAccountId] ||= { customerId: account.customerId, version: 0,
      cart: { status: 'unobserved', lines: [], observedAt: null, evidenceRefs: [] }, quote: null, authorization: null };
    const state = data.states[account.merchantAccountId];
    if (state.pending) {
      if (state.pending.operation === 'mutateCart') state.cart.status = 'needs_reconciliation';
      if (state.pending.operation === 'authorize') state.authorization = { ...state.authorization, status: 'uncertain' };
      data.stopped ||= { reason: 'interrupted_worker_requires_review', at: clock() };
      delete state.pending; // Reserved counters remain charged; no silent budget reset.
    }
    const configFingerprint = createHash('sha256').update('delio-account-config:v1\0').update(canonicalConfig({ account, buenaFeeMinor,
      quoteRules: { maxQuoteAgeMs: caps.maxQuoteAgeMs, maxQuoteTtlMs: caps.maxQuoteTtlMs, maxLines: caps.maxLines, maxQuantity: caps.maxQuantity } })).digest('hex');
    if (old && state.configFingerprint !== configFingerprint) {
      state.version++; state.quote = null; state.cart.status = 'needs_reconciliation';
      if (state.authorization?.status !== 'uncertain') state.authorization = null;
      changedConfigurations.push({ customerId: account.customerId, merchantAccountId: account.merchantAccountId, version: state.version });
    }
    state.configFingerprint = configFingerprint;
  }
  function persist() {
    if (!storeDir) return;
    const path = join(storeDir, 'pilot-state.json');
    writeFileSync(path + '.tmp', JSON.stringify(data), { mode: 0o600, flush: true });
    renameSync(path + '.tmp', path);
  }
  function journal(record) {
    if (storeDir) appendFileSync(join(storeDir, 'attempts.jsonl'), JSON.stringify({ at: clock(), ...record }) + '\n', { mode: 0o600, flush: true });
  }
  function owned(actor) {
    if (!plain(actor) || !id(actor.customerId) || !id(actor.merchantAccountId)) fail('authentication_required');
    const account = registry.get(actor.merchantAccountId);
    if (!account || account.customerId !== actor.customerId) fail('account_not_owned');
    return account;
  }
  function stateFor(account) { return data.states[account.merchantAccountId]; }
  function snapshot(account) {
    const state = stateFor(account), customer = data.customers[account.customerId];
    return clone({ version: state.version, cart: state.cart, quote: state.quote, authorization: state.authorization,
      usage: customer.usage, limits: customerCaps.get(account.customerId), costs: customer.costs,
      stopped: data.stopped, workerActive: workers.size, durable: Boolean(storeDir) });
  }
  function serial(actor, operation) {
    const account = owned(actor), previous = tails.get(account.merchantAccountId) || Promise.resolve();
    const current = previous.catch(() => {}).then(() => operation(account));
    const tail = current.then(() => {}, () => {});
    tails.set(account.merchantAccountId, tail);
    return current.finally(() => { if (tails.get(account.merchantAccountId) === tail) tails.delete(account.merchantAccountId); });
  }
  function available(state, mutation = false) {
    if (data.stopped) fail('pilot_stopped');
    if (state.authorization?.status === 'uncertain') fail('authorization_requires_review');
    if (mutation && state.cart.status === 'needs_reconciliation') fail('cart_requires_reconciliation');
  }
  function version(state, value) { if (!integer(value) || value !== state.version) fail('stale_cart_version'); }
  function lines(value, allowZero = false, prices = false, estimates = false) {
    if (!Array.isArray(value) || value.length > caps.maxLines) fail('invalid_cart_lines');
    const seen = new Set(), result = [];
    for (const line of value) {
      exact(line, prices ? ['productId', 'quantity', 'unitPriceMinor', 'lineTotalMinor'] : ['productId', 'quantity']);
      if (!id(line.productId) || seen.has(line.productId) || !integer(line.quantity)
          || line.quantity > caps.maxQuantity || (!allowZero && line.quantity === 0)) fail('invalid_cart_lines');
      seen.add(line.productId);
      if (prices) {
        for (const key of ['unitPriceMinor', 'lineTotalMinor']) if (!(estimates && line[key] === null) && !integer(line[key])) fail('invalid_quote_amount');
        if (line.unitPriceMinor !== null && line.lineTotalMinor !== null
            && BigInt(line.unitPriceMinor) * BigInt(line.quantity) !== BigInt(line.lineTotalMinor)) fail('quote_line_total_mismatch');
      }
      if (line.quantity) result.push(clone(line));
    }
    return result.sort((a, b) => a.productId.localeCompare(b.productId));
  }
  const sameLines = (a, b) => JSON.stringify(a.map(({ productId, quantity }) => ({ productId, quantity })))
    === JSON.stringify(b.map(({ productId, quantity }) => ({ productId, quantity })));
  function observation(value, allowEstimate = false) {
    if (!plain(value) || (value.verified !== true && !(allowEstimate && value.verified === false))) fail('unverified_observation');
    const now = clock();
    if (!integer(value.observedAt) || value.observedAt > now || now - value.observedAt > caps.maxQuoteAgeMs) fail('stale_observation');
    if (!Array.isArray(value.evidenceRefs) || !value.evidenceRefs.length || value.evidenceRefs.length > 32) fail('missing_observation_evidence');
    return value.evidenceRefs.map(ref => {
      exact(ref, ['id', 'observedAt']);
      if (!id(ref.id) || !integer(ref.observedAt) || ref.observedAt > now || now - ref.observedAt > caps.maxQuoteAgeMs) fail('invalid_observation_evidence');
      return clone(ref);
    });
  }
  function cartObservation(value) {
    return { status: 'observed', lines: lines(value?.lines), observedAt: value.observedAt, evidenceRefs: observation(value) };
  }
  function normalizeQuote(value, state, account) {
    const evidenceRefs = observation(value, true), estimated = value.verified !== true;
    const deliveryCommitment = deliveryHash(account.deliveryCommitment ?? account.delivery);
    if (!estimated && value.deliveryCommitment !== deliveryCommitment) fail('delivery_commitment_mismatch');
    if (value.currency !== 'PLN' || !integer(value.expiresAt) || value.expiresAt <= clock()
        || value.expiresAt <= value.observedAt || value.expiresAt - value.observedAt > caps.maxQuoteTtlMs) fail('invalid_quote_validity');
    exact(value.amounts, AMOUNTS);
    const priced = lines(value.lines, false, true, estimated);
    if (!sameLines(priced, state.cart.lines)) fail('quote_cart_mismatch');
    const stockProof = !estimated && account.requireStockProof === true
      ? validateCheckoutStock({quote:value,actor:account,expectedDeliveryCommitment:deliveryCommitment,expectedRegionId:account.regionId,now:clock()}) : null;
    for (const amount of Object.values(value.amounts)) if (!(estimated && amount === null) && !integer(amount)) fail('invalid_quote_amount');
    const amounts = clone(value.amounts);
    if (priced.every(line => line.lineTotalMinor !== null) && amounts.itemSubtotalMinor !== null
        && safeSum(priced.map(line => line.lineTotalMinor)) !== amounts.itemSubtotalMinor) fail('quote_subtotal_mismatch');
    const complete = Object.values(amounts).every(integer);
    if (complete) {
      const beforeDiscount = safeSum(AMOUNTS.filter(key => !['discountMinor', 'merchantTotalMinor'].includes(key)).map(key => amounts[key]));
      if (amounts.discountMinor > beforeDiscount || beforeDiscount - amounts.discountMinor !== amounts.merchantTotalMinor) fail('quote_total_mismatch');
    }
    const couponResults = value.couponResults ?? [];
    if (!Array.isArray(couponResults) || couponResults.length > 8) fail('invalid_coupon_evidence');
    const seenCoupons = new Set();
    for (const coupon of couponResults) {
      exact(coupon, ['code', 'accepted', 'discountMinor', ...(Object.hasOwn(coupon, 'reason') ? ['reason'] : [])]);
      if (typeof coupon.code !== 'string' || !coupon.code.length || coupon.code.length > 128 || /[\u0000-\u001f]/.test(coupon.code)
          || seenCoupons.has(coupon.code) || typeof coupon.accepted !== 'boolean' || !integer(coupon.discountMinor)
          || (!coupon.accepted && coupon.discountMinor !== 0)
          || (coupon.reason !== undefined && (typeof coupon.reason !== 'string' || coupon.reason.length > 256))) fail('invalid_coupon_evidence');
      if (coupon.code !== account.couponCode) fail('unexpected_coupon_evidence');
      seenCoupons.add(coupon.code);
    }
    if (account.couponCode) {
      if (!seenCoupons.has(account.couponCode)) fail('coupon_result_not_observed');
      if (amounts.discountMinor !== null && safeSum(couponResults.filter(item => item.accepted).map(item => item.discountMinor)) !== amounts.discountMinor) fail('coupon_discount_mismatch');
    }
    return { quoteId: randomUUID(), version: state.version, status: estimated ? 'estimate' : 'verified', currency: 'PLN',
      customerId: account.customerId, merchantAccountId: account.merchantAccountId,
      deliveryCommitment,
      ...(stockProof ? {stockProof,regionId:stockProof.regionId,fulfillmentAreaId:stockProof.fulfillmentAreaId} : {}),
      couponStatus: account.couponCode ? 'observed' : 'not_provided', couponResults: clone(couponResults),
      observedAt: value.observedAt, expiresAt: value.expiresAt, lines: priced, evidenceRefs,
      amounts: { ...amounts, buenaFeeMinor, totalMinor: complete ? safeSum([amounts.merchantTotalMinor, buenaFeeMinor]) : null } };
  }
  async function worker(account, operation, invoke) {
    const state = stateFor(account); available(state);
    if (workers.size >= caps.maxConcurrent) fail('global_concurrency_exhausted');
    const customer = data.customers[account.customerId], allowance = customerCaps.get(account.customerId);
    const reserve = emptyUsage(); reserve.liveQuotes = operation === 'quote' ? 1 : 0; reserve.cartUpdates = operation === 'mutateCart' ? 1 : 0;
    reserve.modelCalls = models[operation];
    reserve.runtimeMs = Math.min(caps.operationRuntimeMs, allowance.runtimeMs - customer.usage.runtimeMs, caps.runtimeMs - data.globalUsage.runtimeMs);
    if (reserve.runtimeMs <= 0) fail('runtime_budget_exhausted');
    for (const key of COUNTERS) if (customer.usage[key] + reserve[key] > allowance[key] || data.globalUsage[key] + reserve[key] > caps[key]) fail(`${key}_budget_exhausted`);
    const attemptId = randomUUID(), started = clock(), monotonicStart = performance.now(), controller = new AbortController();
    for (const key of COUNTERS) { customer.usage[key] += reserve[key]; data.globalUsage[key] += reserve[key]; }
    customer.costs.attempts++; data.globalCosts.attempts++;
    customer.costs.unknownAttempts++; data.globalCosts.unknownAttempts++;
    state.pending = { operation, attemptId, started };
    persist(); journal({ type: 'worker_start', attemptId, operation, customerId: account.customerId,
      merchantAccountId: account.merchantAccountId, reserved: reserve });
    workers.add(controller);
    let timeout;
    const aborted = new Promise((_, reject) => controller.signal.addEventListener('abort', () => reject(Object.assign(new Error('worker_outcome_uncertain'), { code: 'worker_outcome_uncertain' })), { once: true }));
    timeout = setTimeout(() => { data.stopped ||= { reason: 'worker_timeout', at: clock() }; controller.abort(); }, reserve.runtimeMs);
    const running = Promise.resolve().then(() => {
      if (controller.signal.aborted) fail('worker_outcome_uncertain');
      return invoke({ signal: controller.signal, budget: { modelCalls: reserve.modelCalls, runtimeMs: reserve.runtimeMs } });
    });
    // Pending adapters retain their slot. A remote transport may settle before its
    // daemon exits; the sticky stop above still forbids launching another worker.
    running.then(() => workers.delete(controller), () => workers.delete(controller));
    let result, error;
    try {
      result = await Promise.race([running, aborted]);
      if (result?.dispatched === false && result?.blocker) error = { code: result.blocker.code, dispatched: false, usage: result.usage };
    } catch (caught) { error = caught; }
    clearTimeout(timeout);
    const elapsed = Math.max(0, Math.ceil(clock() - started), Math.ceil(performance.now() - monotonicStart));
    const timedOut = controller.signal.aborted;
    const actualRuntime = timedOut ? reserve.runtimeMs : elapsed;
    // An uncertain transport failure cannot establish final provider usage. Only
    // a validated, definite pre-dispatch report may refund an error's reservation.
    const errorUsage = !timedOut && error?.dispatched === false && plain(error.usage)
      && integer(error.usage.modelCalls) ? error.usage : undefined;
    const reported = error ? errorUsage : result?.usage;
    const modelKnown = plain(reported) && integer(reported.modelCalls);
    const actualModels = modelKnown ? reported.modelCalls : reserve.modelCalls;
    for (const [key, actual] of [['runtimeMs', actualRuntime], ['modelCalls', actualModels]]) {
      customer.usage[key] += actual - reserve[key]; data.globalUsage[key] += actual - reserve[key];
    }
    if (actualRuntime > reserve.runtimeMs || actualModels > reserve.modelCalls) {
      data.stopped ||= { reason: 'adapter_budget_violation', at: clock() };
      error ||= Object.assign(new Error('adapter_budget_violation'), { code: 'adapter_budget_violation' });
    }
    let cost = { status: 'unknown', amountUsd: null };
    if (reported && Number.isFinite(reported.modelCostUsd) && reported.modelCostUsd >= 0) cost = { status: 'known', amountUsd: reported.modelCostUsd };
    else if (reported && Number.isFinite(reported.estimatedModelCostUsd) && reported.estimatedModelCostUsd >= 0) cost = { status: 'estimated', amountUsd: reported.estimatedModelCostUsd };
    else if ((!error || error.dispatched === false) && reserve.modelCalls === 0 && (!modelKnown || actualModels === 0)) cost = { status: 'known', amountUsd: 0 };
    for (const totals of [customer.costs, data.globalCosts]) {
      if (cost.status === 'known') { totals.knownModelCostUsd += cost.amountUsd; totals.unknownAttempts--; }
      else if (cost.status === 'estimated') { totals.estimatedModelCostUsd += cost.amountUsd; totals.unknownAttempts--; }
    }
    delete state.pending;
    journal({ type: 'worker_end', attemptId, operation, customerId: account.customerId, merchantAccountId: account.merchantAccountId,
      outcome: error ? error.dispatched === false ? 'not_dispatched' : 'uncertain_or_failed' : 'returned',
      runtimeMs: actualRuntime, modelCalls: { status: modelKnown || reserve.modelCalls === 0 ? 'known' : 'unknown', value: actualModels }, cost });
    persist();
    if (error) {
      if (error.dispatched === false) throw Object.assign(new Error(id(error.code) ? error.code : 'adapter_not_dispatched'),
        { code: id(error.code) ? error.code : 'adapter_not_dispatched', dispatched: false });
      fail(error.code === 'adapter_budget_violation' ? error.code : 'worker_outcome_uncertain');
    }
    return result;
  }
  persist();
  for (const change of changedConfigurations) journal({ type: 'account_configuration_changed', ...change });
  return {
    async catalog() {
      const value = typeof adapter.catalog === 'function' ? await adapter.catalog() : { items: [] };
      // This method is anonymous: never forward account offers or delivery scope.
      return normalizeCatalogue(value);
    },
    getState(actor) { return snapshot(owned(actor)); },
    updateCart(actor, request) {
      exact(request, ['version', 'lines']); const desired = lines(request.lines, true);
      return serial(actor, async account => {
        const state = stateFor(account); available(state, true); version(state, request.version);
        if (state.cart.status !== 'observed') fail('cart_requires_reconciliation');
        let dispatched = false; const previousCart = clone(state.cart);
        try {
          const result = await worker(account, 'mutateCart', async context => {
            dispatched = true; state.version++; state.quote = null; state.authorization = null;
            state.cart.status = 'needs_reconciliation'; persist();
            return adapter.mutateCart({ accountId: account.merchantAccountId, lines: clone(desired), ...context });
          });
          const observed = cartObservation(result);
          if (!sameLines(observed.lines, desired)) fail('mutation_result_mismatch');
          state.cart = observed; persist(); return snapshot(account);
        } catch (error) {
          if (dispatched) { if (error.dispatched === false) state.cart = previousCart; else state.cart.status = 'needs_reconciliation'; persist(); }
          throw error;
        }
      });
    },
    refreshQuote(actor, request) {
      exact(request, ['version']);
      return serial(actor, async account => {
        const state = stateFor(account); available(state, true); version(state, request.version);
        if (state.cart.status !== 'observed' || !state.cart.lines.length) fail('observed_cart_required');
        state.quote = null; state.authorization = null; persist();
        const result = await worker(account, 'quote', context => adapter.quote({ accountId: account.merchantAccountId,
          delivery: clone(account.delivery ?? account.deliveryCommitment), ...(account.couponCode ? { coupon: account.couponCode } : {}), ...context }));
        try { state.quote = normalizeQuote(result, state, account); }
        catch (error) {
          if (error.code === 'quote_cart_mismatch') { state.version++; state.cart.status = 'needs_reconciliation'; }
          persist(); throw error;
        }
        persist();
        journal({ type: state.quote.status === 'verified' ? 'quote_verified' : 'quote_estimated',
          customerId: account.customerId, merchantAccountId: account.merchantAccountId, quoteId: state.quote.quoteId,
          version: state.version, currency: state.quote.currency, observedAt: state.quote.observedAt, expiresAt: state.quote.expiresAt,
          merchantTotalMinor: state.quote.amounts.merchantTotalMinor, totalMinor: state.quote.amounts.totalMinor,
          evidenceRefs: state.quote.evidenceRefs });
        return snapshot(account);
      });
    },
    reconcile(actor) {
      return serial(actor, async account => {
        const state = stateFor(account);
        const result = await worker(account, 'observeCart', context => adapter.observeCart({ accountId: account.merchantAccountId, ...context }));
        const observed = cartObservation(result);
        if (state.cart.status !== 'observed' || !sameLines(observed.lines, state.cart.lines)) {
          state.version++; state.quote = null; if (state.authorization?.status !== 'uncertain') state.authorization = null;
        }
        state.cart = observed; persist(); return snapshot(account);
      });
    },
    authorizeQuote(actor, request, authorizer) {
      exact(request, ['quoteId', 'version']);
      if (typeof authorizer !== 'function') fail('authorizer_required');
      return serial(actor, async account => {
        const state = stateFor(account); available(state, true); version(state, request.version);
        const quote = state.quote;
        if (!quote || request.quoteId !== quote.quoteId || quote.version !== state.version) fail('quote_not_current');
        if (quote.status !== 'verified') fail('verified_quote_required');
        if (clock() >= quote.expiresAt || clock() - quote.observedAt > caps.maxQuoteAgeMs) fail('quote_expired');
        if (account.requireStockProof === true) validateCheckoutStock({quote,actor:account,expectedDeliveryCommitment:deliveryHash(account.deliveryCommitment ?? account.delivery),expectedRegionId:account.regionId,now:clock()});
        if (state.authorization) fail('quote_already_authorized');
        let dispatched = false;
        try {
          const result = await worker(account, 'authorize', context => {
            dispatched = true; state.authorization = { quoteId: quote.quoteId, version: state.version, status: 'authorizing' }; persist();
            return authorizer(immutable(clone(quote)), { customerId: account.customerId, merchantAccountId: account.merchantAccountId, ...context });
          });
          if (result?.accepted !== true) { state.authorization = null; persist(); fail('authorization_rejected'); }
          state.authorization = { quoteId: quote.quoteId, version: state.version, status: 'authorized', proof: clone(result.proof ?? null), at: clock() };
          persist(); return snapshot(account);
        } catch (error) {
          if (dispatched && state.authorization) { if (error.dispatched === false) state.authorization = null; else state.authorization.status = 'uncertain'; persist(); }
          throw error;
        }
      });
    },
    stop(reason = 'operator_stop') {
      data.stopped ||= { reason: id(reason) ? reason : 'operator_stop', at: clock() };
      for (const controller of workers) controller.abort(); persist(); journal({ type: 'pilot_stopped', ...data.stopped });
      return clone(data.stopped);
    },
  };
}
