import { randomUUID } from 'node:crypto';
import { discoverFiveSimOffers, assessFiveSimOffers } from './discovery.mjs';

const ORIGIN = 'https://5sim.net';
const TERMINAL = new Set(['CANCELED', 'TIMEOUT', 'FINISHED', 'BANNED']);
const STATUSES = new Set(['PENDING', 'RECEIVED', ...TERMINAL]);
const fail = code => { throw new Error(code); };
const clone = value => structuredClone(value);
const integer = value => Number.isSafeInteger(value) && value >= 0;
const slug = value => typeof value === 'string' && /^[a-z][a-z0-9_-]{1,40}$/.test(value);
const id = value => /^(?:[1-9]\d{0,17})$/.test(String(value)) && (typeof value !== 'number' || Number.isSafeInteger(value));
const evidence = value => typeof value === 'string' && /^https:\/\/[^\s]{1,300}$/.test(value);
const NAMED_QUOTE_MAX_AGE_MS = 5000;
const prePurchaseFail = reason => { throw Object.assign(new Error('provider_pre_purchase_check_failed'), {
  code: 'provider_pre_purchase_check_failed', dispatched: false, reason,
}); };

// Decimal conversion never uses binary floating-point multiplication for money.
export function priceToMinor(value, exponent) {
  if (!Number.isInteger(exponent) || exponent < 0 || exponent > 6) fail('invalid_currency_exponent');
  if (typeof value !== 'number' && typeof value !== 'string') fail('invalid_provider_price');
  const match = /^(0|[1-9]\d*)(?:\.(\d+))?$/.exec(String(value));
  if (!match || (match[2]?.length ?? 0) > exponent) fail('invalid_provider_price');
  const amount = BigInt(match[1]) * 10n ** BigInt(exponent) + BigInt((match[2] ?? '').padEnd(exponent, '0') || '0');
  if (amount > BigInt(Number.MAX_SAFE_INTEGER)) fail('invalid_provider_price');
  return Number(amount);
}
function decimal(minor, exponent) {
  const s = String(minor).padStart(exponent + 1, '0');
  return exponent ? `${s.slice(0, -exponent)}.${s.slice(-exponent)}` : s;
}
function usdMinor(providerMinor, budget) {
  const numerator = BigInt(providerMinor) * BigInt(budget.conversion.usdMicrosPerUnit);
  const denominator = 10n ** BigInt(budget.exponent) * 10_000n;
  const rounded = (numerator + denominator - 1n) / denominator;
  if (rounded > BigInt(Number.MAX_SAFE_INTEGER)) fail('conversion_overflow');
  return Number(rounded);
}

/** One store owner per provider account. durableWrite must atomically persist+fsync
 * the entire snapshot before resolving. A database implementation may replace
 * this store with cross-process locking; this implementation serializes one process. */
export function createFiveSimStore({ initial, durableWrite } = {}) {
  if (typeof durableWrite !== 'function') fail('durable_writer_required');
  let state = clone(initial ?? { version: 1, policy: null, entries: [] });
  if (state.version !== 1 || !Array.isArray(state.entries)) fail('invalid_store');
  let tail = Promise.resolve();
  let poisoned = false;
  return Object.freeze({
    exclusive(fn) {
      const next = tail.then(() => fn({
        read: () => clone(state),
        async write(nextState) {
          if (poisoned) fail('sms_journal_failed');
          try { await durableWrite(clone(nextState)); }
          catch { poisoned = true; fail('sms_journal_failed'); }
          state = clone(nextState);
        },
        assertWritable() { if (poisoned) fail('sms_journal_failed'); },
      }));
      tail = next.catch(() => {});
      return next;
    },
  });
}

export function createManualOtp({ onOtp, onPhone, now = Date.now, expiresAt } = {}) {
  if (typeof onOtp !== 'function') fail('private_otp_consumer_required');
  const deadline = expiresAt ?? now() + 300_000;
  if (!Number.isFinite(deadline) || deadline <= now() || deadline > now() + 600_000) fail('invalid_otp_expiry');
  let consumed = false;
  return Object.freeze({
    async submitPhone(phone) {
      if (consumed || now() >= deadline) fail('otp_expired_or_consumed');
      if (typeof onPhone !== 'function' || typeof phone !== 'string' || !/^\+[1-9]\d{6,14}$/.test(phone)) fail('invalid_phone');
      try { await onPhone(phone); } catch { fail('private_phone_consumer_failed'); }
      return { accepted: true, mode: 'manual' };
    },
    async submit(code) {
      if (consumed || now() >= deadline) fail('otp_expired_or_consumed');
      if (typeof code !== 'string' || !/^\d{3,10}$/.test(code)) fail('invalid_otp');
      consumed = true; // Never replay an OTP after an uncertain consumer outcome.
      try { await onOtp(code); } catch { fail('private_otp_consumer_failed'); }
      return { accepted: true, mode: 'manual' };
    },
    status: () => ({ mode: 'manual', consumed, expired: now() >= deadline }),
  });
}

export function createFiveSimAdapter({
  paidEnabled = false, token = process.env.FIVESIM_TOKEN, fetchImpl = globalThis.fetch,
  store, budget, service, exclusiveProviderAccount = false,
  approvedNamedOperator,
  now = Date.now, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
  requestTimeoutMs = 10_000, pollIntervalMs = 3_000, maxPollMs = 120_000, maxPolls = 40,
} = {}) {
  const namedApproval = approvedNamedOperator === undefined ? undefined : clone(approvedNamedOperator);
  if (![requestTimeoutMs, pollIntervalMs, maxPollMs, maxPolls].every(v => integer(v) && v > 0)
    || requestTimeoutMs > 30_000 || maxPollMs > 600_000 || maxPolls > 100 || pollIntervalMs < 100) fail('invalid_time_limits');
  const gate = ({ purchase = false } = {}) => {
    if (paidEnabled !== true) fail('paid_sms_disabled');
    if (!store?.exclusive) fail('durable_store_required');
    if (typeof token !== 'string' || !token || /[\r\n]/.test(token)) fail('server_token_required');
    if (exclusiveProviderAccount !== true) fail('exclusive_provider_account_required');
    if (!budget || !/^[A-Z][A-Z0-9_]{2,15}$/.test(budget.currency) || !integer(budget.exponent) || budget.exponent > 6
      || !integer(budget.totalMinor) || !integer(budget.perOrderMinor) || budget.perOrderMinor < 1
      || budget.totalMinor < budget.perOrderMinor || budget.currencyVerified !== true || !evidence(budget.currencyEvidence)) fail('verified_explicit_budget_required');
    const a = budget.authorization, c = budget.conversion;
    if (!a || a.currency !== 'USD' || !integer(a.totalMinor) || a.totalMinor < 1 || !integer(a.maxPurchases) || a.maxPurchases < 1 || a.maxPurchases > 10)
      fail('explicit_usd_authorization_required');
    if (!c || c.verified !== true || c.includesFees !== true || !integer(c.usdMicrosPerUnit) || c.usdMicrosPerUnit < 1 || !evidence(c.evidenceUrl)
      || !Number.isFinite(c.validUntil) || (purchase && now() >= c.validUntil)) fail('verified_currency_conversion_required');
    if (usdMinor(budget.totalMinor, budget) > a.totalMinor) fail('usd_authorization_exceeded');
    if (!service || service.country !== 'poland' || !slug(service.product) || service.verified !== true
      || service.merchantCompatible !== true || !evidence(service.evidenceUrl) || !evidence(service.compatibilityEvidenceUrl)) fail('verified_merchant_service_required');
    if (namedApproval !== undefined && (!namedApproval || namedApproval.operator !== 'virtual53'
      || service.product !== 'zabkajush' || a.maxPurchases !== 1
      || namedApproval.priceCapNotEnforcedAcknowledged !== true
      || !/^[a-z][a-z0-9_-]{0,79}$/.test(namedApproval.approvalId ?? '')
      || !integer(namedApproval.expectedPriceMinor) || namedApproval.expectedPriceMinor < 1
      || namedApproval.expectedPriceMinor > budget.perOrderMinor || namedApproval.expectedPriceMinor > budget.totalMinor
      || Object.keys(namedApproval).some(k => !['operator', 'expectedPriceMinor', 'approvalId', 'priceCapNotEnforcedAcknowledged'].includes(k))))
      fail('invalid_named_operator_approval');
  };
  const policy = () => ({ currency: budget.currency, exponent: budget.exponent, totalMinor: budget.totalMinor,
    perOrderMinor: budget.perOrderMinor, country: service.country, product: service.product,
    authorization: clone(budget.authorization), conversion: clone(budget.conversion),
    ...(namedApproval === undefined ? {} : { approvedNamedOperator: clone(namedApproval) }) });
  function bind(s) {
    const p = policy();
    if (s.policy && JSON.stringify(s.policy) !== JSON.stringify(p)) fail('store_policy_mismatch');
    s.policy = p;
  }
  function blocked(s) {
    return s.entries.some(e => e.phase !== 'owned' || e.pendingMutation || e.costMinor === null || e.overBudget || e.priceVariance || e.operatorMismatch);
  }
  function safeEntry(e) {
    return { reservationId: e.reservationId, state: e.phase, status: e.status ?? null, expiresAt: e.expiresAt ?? null,
      costMinor: e.costMinor, reservedMinor: e.costMinor === null ? e.maxMinor : 0, pendingMutation: e.pendingMutation ?? null,
      ...(e.approvalId ? { operator: e.operator, approvalId: e.approvalId, capMechanism: e.capMechanism,
        quotedPriceMinor: e.quotedPriceMinor, quotedAt: e.quotedAt, priceVariance: e.priceVariance === true,
        operatorMismatch: e.operatorMismatch === true } : {}) };
  }
  function summary(s) {
    const knownCostMinor = s.entries.reduce((n, e) => n + (e.costMinor ?? 0), 0);
    const reservedMinor = s.entries.reduce((n, e) => n + (e.costMinor === null ? e.maxMinor : 0), 0);
    return { provider: '5sim', currency: s.policy?.currency ?? null, knownCostMinor, reservedMinor,
      costComplete: s.entries.every(e => e.costMinor !== null), needsReconciliation: blocked(s),
      usdAuthorization: s.policy?.authorization ?? null,
      entries: s.entries.map(safeEntry) };
  }
  async function request(path, { auth = true, timeoutMs = requestTimeoutMs, signal } = {}) {
    if (signal?.aborted) fail('sms_cancelled');
    const controller = new AbortController();
    let timer;
    let rejectAbort;
    const abort = () => { controller.abort(); rejectAbort?.(new Error('sms_cancelled')); };
    const timeout = new Promise((_, reject) => {
      rejectAbort = reject;
      timer = setTimeout(() => { controller.abort(); reject(new Error('provider_request_timeout')); }, timeoutMs);
    });
    signal?.addEventListener('abort', abort, { once: true });
    try {
      return await Promise.race([timeout, (async () => {
        const response = await fetchImpl(`${ORIGIN}${path}`, { method: 'GET', redirect: 'error', cache: 'no-store',
          headers: { Accept: 'application/json', ...(auth ? { Authorization: `Bearer ${token}` } : {}) }, signal: controller.signal });
        if (!response.ok) fail('provider_http_error');
        const text = await response.text();
        if (text.length > 1_000_000) fail('provider_response_too_large');
        try { return JSON.parse(text); } catch { fail('provider_invalid_json'); }
      })()]);
    } catch { fail(signal?.aborted ? 'sms_cancelled' : 'provider_request_failed'); }
    finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
  }
  async function history() {
    const all = [];
    const seen = new Set();
    let expectedTotal;
    for (let offset = 0; offset < 500; offset += 100) {
      const result = await request(`/v1/user/orders?category=activation&limit=100&offset=${offset}&order=id&reverse=true`);
      // The live provider returned 999999 with a short final page. Accept only
      // that exact sentinel; other totals still require a complete exact count.
      if (!Array.isArray(result?.Data) || result.Data.length > 100 || !integer(result.Total)
        || (result.Total !== 999999 && result.Total > 500)) fail('provider_history_incomplete');
      expectedTotal ??= result.Total;
      if (result.Total !== expectedTotal) fail('provider_history_incomplete');
      for (const row of result.Data) {
        if (!id(row?.id)) fail('provider_history_invalid');
        const key = String(row.id);
        if (seen.has(key)) fail('provider_history_incomplete');
        seen.add(key);
      }
      all.push(...result.Data);
      if (result.Total === 999999) {
        if (result.Data.length < 100) return all;
        continue;
      }
      if (all.length >= result.Total) {
        if (all.length !== result.Total) fail('provider_history_incomplete');
        return all;
      }
      if (result.Data.length !== 100) fail('provider_history_incomplete');
    }
    fail('provider_history_incomplete');
  }
  async function namedQuote() {
    const quotedAt = now();
    const raw = await request('/v1/guest/prices?country=poland&product=zabkajush', { auth: false });
    const offer = raw?.poland?.zabkajush?.virtual53;
    if (!integer(offer?.count) || offer.count < 1) fail('named_operator_out_of_stock');
    const quotedPriceMinor = priceToMinor(offer.cost, budget.exponent);
    if (quotedPriceMinor !== namedApproval.expectedPriceMinor) fail('named_operator_quote_changed');
    if (now() < quotedAt || now() - quotedAt > NAMED_QUOTE_MAX_AGE_MS) fail('named_operator_quote_stale');
    return { operator: namedApproval.operator, approvalId: namedApproval.approvalId,
      capMechanism: 'fresh_quote_only_not_provider_enforced', quotedPriceMinor, quotedAt };
  }
  function bindActualNamedPurchase(e, raw) {
    if (!e.approvalId) return;
    e.priceVariance = e.priceVariance === true || e.costMinor !== e.quotedPriceMinor;
    e.operatorMismatch = e.operatorMismatch === true || raw.operator !== e.operator;
  }
  function order(raw) {
    if (!raw || !id(raw.id) || raw.product !== service.product || raw.country !== service.country
      || !STATUSES.has(raw.status) || !Number.isFinite(Date.parse(raw.created_at)) || !Number.isFinite(Date.parse(raw.expires))) fail('provider_order_mismatch');
    const costMinor = priceToMinor(raw.price, budget.exponent);
    if (!costMinor) fail('invalid_provider_price');
    return { providerId: String(raw.id), costMinor, status: raw.status, expiresAt: Date.parse(raw.expires), createdAt: Date.parse(raw.created_at) };
  }
  function owned(s, reservationId) {
    const e = s.entries.find(e => e.reservationId === reservationId);
    if (!e || e.phase !== 'owned' || !e.providerId) fail('order_not_owned');
    return e;
  }
  function update(e, raw) {
    const parsed = order(raw);
    if (parsed.providerId !== e.providerId || parsed.costMinor !== e.costMinor) fail('provider_order_changed');
    e.status = parsed.status;
    e.expiresAt = parsed.expiresAt;
    return parsed;
  }
  async function withStore(fn) {
    gate();
    return store.exclusive(async access => {
      access.assertWritable();
      const s = access.read(); bind(s);
      return fn(s, access.write);
    });
  }
  async function check(reservationId, requestOptions) {
    return withStore(async (s, write) => {
      const e = owned(s, reservationId);
      const raw = await request(`/v1/user/check/${e.providerId}`, requestOptions);
      update(e, raw);
      await write(s);
      return { entry: safeEntry(e), raw }; // Internal only; callers never receive provider JSON.
    });
  }
  async function consumePrivate(callback, value, label) {
    let timer;
    try {
      await Promise.race([Promise.resolve().then(() => callback(value)), new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('private_consumer_timeout')), requestTimeoutMs);
      })]);
    } catch { fail(`private_${label}_consumer_failed`); }
    finally { clearTimeout(timer); }
  }
  return Object.freeze({
    async publicPreflight({ product = service?.product, operator = 'any', minimumRate = 90, terms } = {}) {
      const discovery = await discoverFiveSimOffers({ fetchImpl, now, requestTimeoutMs: Math.min(requestTimeoutMs, 15_000),
        ...(terms ? { terms } : {} ) });
      const selection = slug(product) ? assessFiveSimOffers(discovery, { product, operator, minimumRate, budget, now: now() }) : null;
      let purchaseBlocker = null;
      try { gate({ purchase: true }); } catch (error) { purchaseBlocker = error.message; }
      if (store?.exclusive) await store.exclusive(access => {
        const s = access.read();
        try { access.assertWritable(); if (!purchaseBlocker) bind(s); } catch (error) { purchaseBlocker = error.message; return; }
        if (blocked(s)) purchaseBlocker = 'reconciliation_required';
        else if (budget && s.entries.length >= budget.authorization?.maxPurchases) purchaseBlocker = 'sms_purchase_limit';
        else if (!purchaseBlocker) {
          const used = s.entries.reduce((n, e) => n + (e.costMinor ?? e.maxMinor), 0);
          if (!Number.isSafeInteger(used) || used + budget.perOrderMinor > budget.totalMinor) purchaseBlocker = 'sms_budget_exceeded';
        }
      });
      return { discovery, selection, purchaseBlocker, purchaseAuthorized: false };
    },
    async publicStatus() {
      if (!store?.exclusive) return { provider: '5sim', paidEnabled: false, entries: [],
        purchaseConfigurationValid: false, usdAuthorization: null, purchaseBlocker: 'durable_store_required' };
      return store.exclusive(a => {
        const s = a.read();
        let purchaseBlocker = null, authorization = null;
        try {
          // Validate current configured policy without binding/writing or contacting the provider.
          // A fresh store has no policy yet; returning null there hid an oversized first-buy cap.
          a.assertWritable(); gate({ purchase: true });
          if (s.policy && JSON.stringify(s.policy) !== JSON.stringify(policy())) fail('store_policy_mismatch');
          authorization = { currency: budget.authorization.currency, totalMinor: budget.authorization.totalMinor,
            maxPurchases: budget.authorization.maxPurchases };
        } catch (error) {
          purchaseBlocker = /^[a-z_]{1,80}$/.test(error.message) ? error.message : 'sms_configuration_unavailable';
        }
        return { paidEnabled: paidEnabled === true, ...summary(s),
          purchaseConfigurationValid: purchaseBlocker === null, usdAuthorization: authorization, purchaseBlocker };
      });
    },
    // Read-only rankings do not imply the named operator can be purchased with an enforced maxPrice.
    async offers({ country = 'poland', product } = {}) {
      if (country !== 'poland' || !slug(product)) fail('explicit_product_required');
      const raw = await request(`/v1/guest/prices?country=poland&product=${encodeURIComponent(product)}`, { auth: false });
      const rows = Object.entries(raw?.poland?.[product] ?? {}).filter(([operator, r]) => slug(operator) && integer(r?.count) && r.count > 0)
        .map(([operator, r]) => ({ operator, count: r.count, price: typeof r.cost === 'number' || typeof r.cost === 'string' ? r.cost : null,
          rate: typeof r.rate === 'number' && r.rate >= 0 && r.rate <= 100 ? r.rate : null }));
      rows.sort((a, b) => (b.rate ?? -1) - (a.rate ?? -1));
      return { country, product, currency: null, observedAt: now(), offers: rows, rateMeaning: 'historical delivery percentage; omitted is unknown' };
    },
    async buy({ onPhone, operator = 'any' } = {}) {
      gate({ purchase: true });
      // Named purchases require separate explicit acceptance of the absence of
      // a provider-enforced price cap. No preference is silently substituted.
      if (operator !== 'any' && (!namedApproval || operator !== namedApproval.operator)) fail('named_operator_price_cap_unsupported');
      if (namedApproval && operator !== namedApproval.operator) fail('approved_operator_required');
      if (typeof onPhone !== 'function') fail('private_phone_consumer_required');
      return withStore(async (s, write) => {
        gate({ purchase: true }); // A queued buyer must recheck the conversion expiry.
        if (blocked(s)) fail('reconciliation_required');
        if (s.entries.length >= budget.authorization.maxPurchases) fail('sms_purchase_limit');
        const used = s.entries.reduce((n, e) => n + (e.costMinor ?? e.maxMinor), 0);
        if (!Number.isSafeInteger(used) || used + budget.perOrderMinor > budget.totalMinor) fail('sms_budget_exceeded');
        let baseline;
        try { baseline = await history(); }
        catch {
          // This boundary precedes both the durable purchase intent and paid
          // request. The caller may reconcile this known non-dispatch; we never retry.
          prePurchaseFail('history_unverified');
        }
        let quote;
        if (namedApproval) {
          try { gate({ purchase: true }); quote = await namedQuote(); }
          catch (error) { prePurchaseFail(/^[a-z_]+$/.test(error.message) ? error.message : 'named_operator_quote_unverified'); }
        }
        const e = { reservationId: randomUUID(), phase: 'buy_pending', country: service.country, product: service.product,
          requestedAt: now(), maxMinor: budget.perOrderMinor, costMinor: null, baselineOrderIds: baseline.map(o => String(o.id)), providerId: null,
          ...(quote ?? {}) };
        s.entries.push(e);
        await write(s); // Durable reservation BEFORE the paid GET. Failure sends no purchase.
        if (quote) {
          try {
            gate({ purchase: true });
            if (now() < quote.quotedAt || now() - quote.quotedAt > NAMED_QUOTE_MAX_AGE_MS) fail('named_operator_quote_stale');
          } catch (error) {
            e.phase = 'not_dispatched'; e.costMinor = 0;
            await write(s); // A known non-dispatch remains recorded and is not auto-retried.
            prePurchaseFail(error.message);
          }
        }
        let raw;
        try {
          const path = quote
            ? `/v1/user/buy/activation/poland/${operator}/${encodeURIComponent(service.product)}`
            : `/v1/user/buy/activation/poland/any/${encodeURIComponent(service.product)}?maxPrice=${decimal(e.maxMinor, budget.exponent)}`;
          raw = await request(path);
          const parsed = order(raw);
          if (e.baselineOrderIds.includes(parsed.providerId)) fail('provider_order_not_new');
          Object.assign(e, parsed, { phase: 'owned', overBudget: parsed.costMinor > e.maxMinor });
          bindActualNamedPurchase(e, raw);
        } catch {
          e.phase = 'buy_uncertain';
          await write(s);
          fail('purchase_uncertain_reconcile_required');
        }
        await write(s); // Cost recorded before disclosing the phone to the private consumer.
        if (e.priceVariance || e.operatorMismatch) fail('purchase_price_variance_reconcile_required');
        if (e.overBudget) fail('provider_exceeded_price_cap');
        if (TERMINAL.has(e.status) || now() >= e.expiresAt) fail('purchased_order_not_active');
        if (typeof raw.phone !== 'string' || !/^\+48\d{9}$/.test(raw.phone)) fail('provider_phone_invalid');
        await consumePrivate(onPhone, raw.phone, 'phone');
        return safeEntry(e);
      });
    },
    async reconcile({ reservationId, providerOrderId } = {}) {
      return withStore(async (s, write) => {
        const e = s.entries.find(e => e.reservationId === reservationId);
        if (!e) fail('reservation_not_found');
        if (e.phase === 'owned') {
          const raw = await request(`/v1/user/check/${e.providerId}`);
          const observedAt = now();
          update(e, raw);
          bindActualNamedPurchase(e, raw);
          if (e.pendingMutation && e.status === (e.pendingMutation === 'cancel' ? 'CANCELED' : 'FINISHED')) e.pendingMutation = null;
          await write(s);
          // Count only the observed array; an absent/malformed field is unknown,
          // never proof of zero messages. No SMS content enters public metadata.
          return { ...safeEntry(e), reconciled: !e.pendingMutation && !e.priceVariance && !e.operatorMismatch,
            smsCount: Array.isArray(raw.sms) ? raw.sms.length : null, observedAt };
        }
        const rows = await history();
        const candidates = rows.filter(o => !e.baselineOrderIds.includes(String(o.id)) && o.product === e.product && o.country === e.country
          && Date.parse(o.created_at) >= e.requestedAt - 5000);
        // No match NEVER proves no purchase: retain the full reservation, even across restarts.
        if (!providerOrderId) return { reservationId, reconciled: false, state: 'manual_reconciliation_required', candidateOrderIds: candidates.map(o => String(o.id)) };
        const selected = candidates.find(o => String(o.id) === String(providerOrderId));
        if (!selected || candidates.length !== 1 || !id(providerOrderId)) fail('reconciliation_ambiguous');
        const raw = await request(`/v1/user/check/${String(providerOrderId)}`);
        const parsed = order(raw);
        if (parsed.providerId !== String(providerOrderId) || parsed.createdAt < e.requestedAt - 5000) fail('provider_order_mismatch');
        Object.assign(e, parsed, { phase: 'owned', overBudget: parsed.costMinor > e.maxMinor });
        bindActualNamedPurchase(e, raw);
        await write(s);
        return { ...safeEntry(e), reconciled: !e.priceVariance && !e.operatorMismatch };
      });
    },
    async poll({ reservationId, onOtp, signal, timeoutMs = maxPollMs } = {}) {
      gate();
      if (typeof onOtp !== 'function') fail('private_otp_consumer_required');
      if (!integer(timeoutMs) || timeoutMs < 1 || timeoutMs > maxPollMs) fail('invalid_poll_timeout');
      const deadline = now() + timeoutMs;
      for (let n = 0; n < maxPolls; n++) {
        if (signal?.aborted) fail('sms_cancelled');
        const before = await withStore(s => safeEntry(owned(s, reservationId)));
        if (now() >= before.expiresAt) return { state: 'expired', polls: n };
        if (now() >= deadline) return { state: 'poll_timeout', polls: n };
        const { entry, raw } = await check(reservationId, { signal, timeoutMs: Math.min(requestTimeoutMs, deadline - now(), before.expiresAt - now()) });
        if (now() >= entry.expiresAt) return { state: 'expired', polls: n + 1 };
        const sms = Array.isArray(raw.sms) ? raw.sms : [];
        const message = sms.findLast(x => typeof x?.code === 'string' && /^\d{3,10}$/.test(x.code));
        if (message) {
          // Never send OTP/phone/provider body to public results, model prompts, or journals.
          await withStore(async (s, write) => {
            const e = owned(s, reservationId);
            if (e.otpDispatched) fail('otp_already_dispatched');
            e.otpDispatched = true;
            await write(s);
          });
          await consumePrivate(onOtp, message.code, 'otp');
          return { state: 'otp_delivered_to_private_consumer', polls: n + 1 };
        }
        if (TERMINAL.has(entry.status)) return { state: entry.status.toLowerCase(), polls: n + 1 };
        await sleep(Math.max(0, Math.min(pollIntervalMs, deadline - now(), entry.expiresAt - now())));
      }
      return { state: 'poll_limit', polls: maxPolls };
    },
    async mutateOwned({ reservationId, operation } = {}) {
      if (!['cancel', 'finish'].includes(operation)) fail('explicit_cancel_or_finish_required');
      return withStore(async (s, write) => {
        const e = owned(s, reservationId);
        if (e.pendingMutation) fail('reconciliation_required');
        if (TERMINAL.has(e.status)) fail('order_already_terminal');
        e.pendingMutation = operation;
        await write(s); // These GET endpoints are mutations too.
        let raw;
        try { raw = await request(`/v1/user/${operation}/${e.providerId}`); update(e, raw); }
        catch { fail('mutation_uncertain_reconcile_required'); }
        if (e.status !== (operation === 'cancel' ? 'CANCELED' : 'FINISHED')) fail('mutation_uncertain_reconcile_required');
        e.pendingMutation = null;
        await write(s);
        // Gross cost stays charged. Cancellation is not evidence of a settled refund.
        return safeEntry(e);
      });
    },
  });
}
