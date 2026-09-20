const ORIGIN = 'https://5sim.net';
const slug = s => typeof s === 'string' && /^[a-z][a-z0-9_-]{1,40}$/.test(s);
const integer = n => Number.isSafeInteger(n) && n >= 0;
const price = n => (typeof n === 'string' || typeof n === 'number') && /^(0|[1-9]\d*)(?:\.\d{1,6})?$/.test(String(n));
const evidenceUrl = s => typeof s === 'string' && /^https:\/\/[^\s]{1,300}$/.test(s);
const paths = ['/v1/guest/products/poland/any', '/v1/guest/prices?country=poland'];

/** Exactly two public GETs; no credentials, redirects, automatic retries or purchases. */
export async function discoverFiveSimOffers({ fetchImpl = globalThis.fetch, now = Date.now,
  terms = ['zabka', 'jush', 'delio'], requestTimeoutMs = 10_000 } = {}) {
  if (!Array.isArray(terms) || !terms.length || terms.length > 8 || !terms.every(slug)) throw new Error('invalid_discovery_terms');
  if (!integer(requestTimeoutMs) || requestTimeoutMs < 1 || requestTimeoutMs > 15_000) throw new Error('invalid_discovery_timeout');
  const requests = await Promise.all(paths.map(async path => {
    const started = now(), controller = new AbortController();
    let timer, httpStatus = null;
    const metadata = () => ({ url: `${ORIGIN}${path}`, observedAt: now(), durationMs: Math.max(0, now() - started), httpStatus });
    try {
      const data = await Promise.race([
        new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error('public_request_timeout')); }, requestTimeoutMs); }),
        (async () => {
          const response = await fetchImpl(`${ORIGIN}${path}`, { method: 'GET', redirect: 'error', cache: 'no-store',
            headers: { Accept: 'application/json' }, signal: controller.signal });
          httpStatus = response.status;
          if (!response.ok) throw new Error('public_http_error');
          const text = await response.text();
          if (text.length > 1_000_000) throw new Error('public_response_too_large');
          let value;
          try { value = JSON.parse(text); } catch { throw new Error('public_invalid_json'); }
          if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('public_invalid_schema');
          return value;
        })(),
      ]);
      return { ...metadata(), ok: true, data };
    } catch (error) {
      const allowed = new Set(['public_request_timeout', 'public_http_error', 'public_response_too_large', 'public_invalid_json', 'public_invalid_schema']);
      return { ...metadata(), ok: false, code: allowed.has(error?.message) ? error.message : 'public_transport_error' };
    } finally { clearTimeout(timer); }
  }));
  const [products, prices] = requests;
  const source = products.data ?? {}, polish = prices.data?.poland ?? {};
  const identifiers = [...new Set([...Object.keys(source), ...Object.keys(polish)])]
    .filter(k => slug(k) && terms.some(term => k.includes(term))).sort();
  const candidates = identifiers.slice(0, 24).map(product => {
    const row = source[product];
    const offers = Object.entries(polish[product] ?? {}).filter(([operator, r]) => slug(operator) && integer(r?.count) && price(r?.cost))
      .map(([operator, r]) => ({ operator, count: r.count, price: String(r.cost),
        rate: typeof r.rate === 'number' && Number.isFinite(r.rate) && r.rate >= 0 && r.rate <= 100 ? r.rate : null }))
      .sort((a, b) => (b.rate ?? -1) - (a.rate ?? -1) || a.operator.localeCompare(b.operator));
    return { product, identifierObserved: true, merchantCompatible: null,
      category: row?.Category === 'activation' || row?.Category === 'hosting' ? row.Category : null,
      stock: integer(row?.Qty) ? row.Qty : null, price: price(row?.Price) ? String(row.Price) : null,
      offers: offers.slice(0, 256), offersTruncated: offers.length > 256 };
  });
  return { provider: '5sim', country: 'poland', observedAt: now(), authUsed: false,
    currency: null, currencyVerified: false, conversionVerified: false,
    requests: requests.map(({ data, ...metadata }) => metadata), candidates,
    candidatesTruncated: identifiers.length > 24, complete: requests.every(r => r.ok),
    rateMeaning: 'Provider historical SMS delivery percentage; missing means below 20% or insufficient orders, not zero.',
    limitations: ['No sample size or measurement window is supplied by this endpoint.',
      'Stock and price may change before purchase; a listed product does not prove Delio compatibility.',
      'Price responses do not identify their denomination; use current provider currency evidence and an explicit budget attestation.',
      'maxPrice is documented only for operator=any; ranking does not enforce the purchased operator.'] };
}

function providerCap(budget, now) {
  const b = budget, a = b?.authorization, c = b?.conversion;
  if (!b || !/^[A-Z][A-Z0-9_]{2,15}$/.test(b.currency) || b.currencyVerified !== true || !evidenceUrl(b.currencyEvidence)
    || !integer(b.exponent) || b.exponent > 6 || !integer(b.totalMinor) || !integer(b.perOrderMinor)
    || b.perOrderMinor < 1 || b.totalMinor < b.perOrderMinor) return { code: 'verified_explicit_budget_required' };
  if (!a || a.currency !== 'USD' || !integer(a.totalMinor) || a.totalMinor < 1 || !integer(a.maxPurchases)
    || a.maxPurchases < 1 || a.maxPurchases > 10) return { code: 'explicit_usd_authorization_required' };
  if (!c || c.verified !== true || c.includesFees !== true || !integer(c.usdMicrosPerUnit) || c.usdMicrosPerUnit < 1
    || !evidenceUrl(c.evidenceUrl) || !Number.isFinite(c.validUntil) || now >= c.validUntil) return { code: 'verified_currency_conversion_required' };
  const denominator = 10n ** BigInt(b.exponent) * 10_000n;
  const usd = (BigInt(b.totalMinor) * BigInt(c.usdMicrosPerUnit) + denominator - 1n) / denominator;
  if (usd > BigInt(a.totalMinor)) return { code: 'usd_authorization_exceeded' };
  return { cap: b.perOrderMinor, exponent: b.exponent, currency: b.currency };
}
function minor(value, exponent) {
  const [whole, fraction = ''] = value.split('.');
  if (fraction.length > exponent) return null;
  const n = BigInt(whole) * 10n ** BigInt(exponent) + BigInt(fraction.padEnd(exponent, '0') || '0');
  return n <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(n) : null;
}

/** A reviewable shortlist, never purchase authorization or merchant compatibility proof. */
export function assessFiveSimOffers(report, { product, operator = 'any', minimumRate = 90,
  budget, now = Date.now(), maxAgeMs = 60_000 } = {}) {
  if (!slug(product) || !slug(operator) || typeof minimumRate !== 'number' || !Number.isFinite(minimumRate)
    || minimumRate < 0 || minimumRate > 100 || !integer(maxAgeMs) || maxAgeMs < 1 || maxAgeMs > 300_000) throw new Error('invalid_offer_selection');
  const blockers = [];
  if (operator !== 'any') blockers.push('named_operator_price_cap_unsupported');
  if (report?.provider !== '5sim' || report.country !== 'poland' || report.complete !== true || report.candidatesTruncated)
    blockers.push('public_discovery_incomplete');
  if (!Number.isFinite(report?.observedAt) || report.observedAt > now || now - report.observedAt > maxAgeMs) blockers.push('public_offers_stale');
  const candidate = report?.candidates?.find(c => c.product === product);
  if (!candidate || candidate.category !== 'activation') blockers.push('activation_identifier_unverified');
  if (candidate?.offersTruncated) blockers.push('public_discovery_incomplete');
  const cap = providerCap(budget, now);
  if (cap.code) blockers.push(cap.code);
  const affordable = (candidate?.offers ?? []).filter(o => o.count > 0 && (operator === 'any' || o.operator === operator))
    .flatMap(o => {
      if (cap.code) return [];
      const amount = minor(o.price, cap.exponent);
      return amount !== null && amount <= cap.cap ? [{ ...o, priceMinor: amount }] : [];
    });
  const rankedOffers = affordable.filter(o => o.rate !== null && o.rate >= minimumRate)
    .sort((a, b) => b.rate - a.rate || a.priceMinor - b.priceMinor || a.operator.localeCompare(b.operator));
  if (!cap.code && !affordable.length) blockers.push('no_observed_offer_within_cap');
  if (affordable.length && !rankedOffers.length) blockers.push('no_observed_offer_meets_rate');
  return { product, requestedOperator: operator, purchaseOperator: operator === 'any' ? 'any' : null,
    currency: cap.currency ?? null, maximumProviderMinor: cap.cap ?? null, minimumRate,
    rankedOffers, recommendedOffer: rankedOffers[0] ?? null, blockers: [...new Set(blockers)],
    observedCriteriaMet: blockers.length === 0, purchaseAuthorized: false,
    operatorRateEnforceable: false, merchantCompatibilityVerified: false };
}
