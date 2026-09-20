import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const manifestBytes = readFileSync(new URL('./catalogue-public.json', import.meta.url));
const manifest = JSON.parse(manifestBytes);
const metadata = new Map(manifest.products.map(product => [product.productId, product]));
export const CATALOGUE_IMAGE_ORIGINS = Object.freeze([...manifest.imageOrigins]);
export const CATALOGUE_REGIONS = Object.freeze([
  Object.freeze({ id: 'krakow', label: 'Kraków' }),
  Object.freeze({ id: 'warsaw', label: 'Warsaw' }),
]);
const categories = [
  { id: 'dairy', label: 'Dairy' }, { id: 'bakery', label: 'Bakery' },
  { id: 'pantry', label: 'Pantry' }, { id: 'household', label: 'Household' }, { id: 'other', label: 'Other' },
];
const plain = value => value && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const integer = value => Number.isSafeInteger(value) && value >= 0 && !Object.is(value, -0);
const identifier = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)
  && !['constructor', 'prototype', '__proto__'].includes(value);
const text = (value, max = 400) => typeof value === 'string' && value.length <= max ? value : null;
const timestamp = value => integer(value) || (typeof value === 'string' && Number.isFinite(Date.parse(value))) ? value : null;
const fail = () => { throw Object.assign(new Error('invalid_cached_catalog'), { code: 'invalid_cached_catalog' }); };
const regionKnown = value => CATALOGUE_REGIONS.some(region => region.id === value);
function publicUrl(value) {
  try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url.href : null; }
  catch { return null; }
}

function unknown(reason, regionId = null) {
  return { status: 'unknown', reason, regionId, observedAt: null, validUntil: null, unitPriceMinor: null,
    currency: null, scopeBound: false, source: null };
}
function validScope(scope) {
  return plain(scope) && identifier(scope.customerId) && identifier(scope.accountId)
    && regionKnown(scope.regionId) && identifier(scope.fulfillmentAreaId) && /^[a-f0-9]{64}$/.test(scope.deliveryCommitment);
}

/** Only call with server-owned scope and worker observations. Never derive either from an HTTP body.
 * City selection alone cannot validate an offer. This is availability evidence, not checkout permission.
 * Omitting trustedScope (the anonymous catalogue path) drops every offer, even if supplied accidentally.
 */
export function regionalAvailability(productId, { regionId = null, trustedScope = null,
  offerObservations = [], now = Date.now(), maxOfferAgeMs = 120_000 } = {}) {
  if (!regionKnown(regionId)) return unknown('browsing_region_required');
  if (!validScope(trustedScope)) return unknown('owned_delivery_scope_required', regionId);
  if (trustedScope.regionId !== regionId) return unknown('delivery_region_mismatch', regionId);
  if (!integer(now) || !integer(maxOfferAgeMs) || maxOfferAgeMs === 0 || maxOfferAgeMs > 120_000
      || !Array.isArray(offerObservations) || offerObservations.length > 1000) return unknown('invalid_observation_policy', regionId);
  const matching = offerObservations.filter(offer => plain(offer) && offer.productId === productId
    && offer.regionId === regionId && ['customerId', 'accountId', 'fulfillmentAreaId', 'deliveryCommitment']
      .every(key => offer[key] === trustedScope[key]));
  if (!matching.length) return unknown('fresh_owned_observation_required', regionId);
  // The latest matching observation replaces older success, including explicit unknown stock.
  const latestTime = Math.max(...matching.map(offer => integer(offer.observedAt) ? offer.observedAt : Number.MAX_SAFE_INTEGER));
  const latest = matching.filter(offer => offer.observedAt === latestTime);
  if (latest.length !== 1) return unknown('ambiguous_offer_observation', regionId);
  const offer = latest[0];
  if (offer.source !== 'owned_merchant_observation' || !identifier(offer.evidenceId)
      || !integer(offer.observedAt) || offer.observedAt > now || !integer(offer.expiresAt)
      || offer.expiresAt <= offer.observedAt || !['available', 'unavailable', 'unknown'].includes(offer.availability)
      || !integer(offer.unitPriceMinor) || offer.currency !== 'PLN') return unknown('invalid_offer_observation', regionId);
  const validUntil = Math.min(offer.expiresAt, offer.observedAt + maxOfferAgeMs);
  if (now >= validUntil) return unknown('offer_observation_expired', regionId);
  if (offer.availability === 'unknown') return unknown('merchant_stock_unknown', regionId);
  return { status: offer.availability, reason: 'fresh_owned_observation', regionId,
    observedAt: offer.observedAt, validUntil, unitPriceMinor: offer.unitPriceMinor, currency: 'PLN',
    scopeBound: true, source: offer.source };
}

/** Public product metadata is always a cache. Optional owned offers remain a distinct, short-lived layer. */
export function normalizeCatalogue(value, options = {}) {
  const items = Array.isArray(value) ? value : value?.items;
  if (!Array.isArray(items) || items.length > 1000) fail();
  const seen = new Set();
  const regionId = regionKnown(options.regionId) ? options.regionId : null;
  const normalized = items.map(item => {
    if (!plain(item) || !identifier(item.productId) || seen.has(item.productId)) fail();
    seen.add(item.productId);
    const info = metadata.get(item.productId);
    const projected = { productId: item.productId };
    for (const field of ['title', 'name', 'packSize']) if (text(item[field]) !== null) projected[field] = item[field];
    for (const field of ['priceMinor', 'unitPriceMinor']) if (integer(item[field])) projected[field] = item[field];
    if (text(item.currency, 3) !== null) projected.currency = item.currency;
    const sourceUrl = publicUrl(info?.sourceUrl || item.sourceUrl);
    const availability = regionalAvailability(item.productId, { ...options, regionId });
    return { ...projected, ...(sourceUrl ? { sourceUrl } : {}),
      categoryId: info?.categoryId || 'other',
      ...(info ? { imageUrl: info.imageUrl, imageAlt: info.imageAlt, imageSourceUrl: info.sourcePageUsed,
        imageRetrievedAt: manifest.retrievedAt, imageStatus: 'source_link_observed' } : {}),
      stock: availability.status === 'available' ? 'in_stock' : availability.status === 'unavailable' ? 'out_of_stock' : 'not_verified',
      observedAt: null, location: null, availability };
  });
  return { source: 'cached_public_catalog', cached: true,
    personalized: normalized.some(item => item.availability.scopeBound), verified: false,
    observedAt: null, location: null, cacheRetrievedAt: timestamp(value?.cacheRetrievedAt),
    ...(publicUrl(value?.sourceUrl) ? { sourceUrl: publicUrl(value.sourceUrl) } : {}),
    ...(text(value?.note, 1000) !== null ? { note: value.note } : {}),
    browsingRegionId: regionId, regionIsDeliveryConfirmation: false,
    regions: CATALOGUE_REGIONS.map(region => ({ ...region, inventoryStatus: 'not_indexed' })),
    categories: categories.filter(category => normalized.some(item => item.categoryId === category.id)),
    imageOrigins: [...CATALOGUE_IMAGE_ORIGINS],
    metadataEvidence: { retrievedAt: manifest.retrievedAt,
      sha256: createHash('sha256').update(manifestBytes).digest('hex'), imageBytesVerified: false },
    items: normalized };
}
