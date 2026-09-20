import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { normalizeCatalogue, regionalAvailability } from './catalogue.mjs';
import { filterCatalogueItems, visibleRegionalOffer, productImageUrl } from './ui/catalogue-view.mjs';

const raw = JSON.parse(readFileSync(new URL('./catalog.json', import.meta.url)));
const manifest = JSON.parse(readFileSync(new URL('./catalogue-public.json', import.meta.url)));
const now = 1_800_000_000_000;
const scope = { customerId: 'owner', accountId: 'owned-account', regionId: 'krakow', fulfillmentAreaId: 'krakow-zone-a', deliveryCommitment: 'a'.repeat(64) };
const observation = (override = {}) => ({ ...scope, productId: raw.items[0].productId, regionId: 'krakow',
  source: 'owned_merchant_observation', evidenceId: 'private-observation-1',
  observedAt: now - 1000, expiresAt: now + 60_000, availability: 'available', unitPriceMinor: 499, currency: 'PLN', ...override });
const options = (override = {}) => ({ regionId: 'krakow', trustedScope: scope, now, offerObservations: [observation()], ...override });

test('existing eight public IDs gain sourced photo links and browsing groups without regional inventory claims', () => {
  const result = normalizeCatalogue(raw);
  assert.deepEqual(result.items.map(item => item.productId), raw.items.map(item => item.productId));
  assert.equal(result.items.length, 8);
  assert.equal(result.browsingRegionId, null);
  assert.equal(result.personalized, false);
  assert.equal(result.verified, false);
  assert.equal(result.location, null);
  assert.equal(result.observedAt, null);
  assert.equal(result.cacheRetrievedAt, raw.cacheRetrievedAt);
  assert.equal(result.metadataEvidence.imageBytesVerified, false);
  assert.match(result.metadataEvidence.sha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(result.regions.map(region => region.id), ['krakow', 'warsaw']);
  for (const item of result.items) {
    assert.equal(item.stock, 'not_verified');
    assert.equal(item.availability.status, 'unknown');
    assert.equal(item.availability.unitPriceMinor, null);
    assert.equal(item.imageUrl, manifest.products.find(product => product.productId === item.productId).imageUrl);
    assert.equal(productImageUrl(item), item.imageUrl);
    assert.ok(item.imageSourceUrl.startsWith('https://delio.com.pl/'));
  }
});

test('anonymous catalogue drops raw stock claims, private fields, private location and accidentally passed offers', () => {
  const value = { ...raw, location: 'PRIVATE_DESTINATION', offerObservations: [observation()],
    items: [{ ...raw.items[0], stock: 'in_stock', inStock: true, available: true,
      imageUrl: 'http://127.0.0.1/private.png', privateAccount: 'PRIVATE_OWNER' }] };
  for (const regionId of [null, 'krakow', 'warsaw']) {
    const result = normalizeCatalogue(value, { regionId, offerObservations: [observation()], now });
    assert.equal(result.personalized, false);
    assert.equal(result.items[0].availability.status, 'unknown');
    assert.equal(result.items[0].availability.unitPriceMinor, null);
    assert.equal(result.items[0].stock, 'not_verified');
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE_|owned-account|private-observation/);
  }
});

test('owned observations require the exact region, owner, account, delivery commitment and fulfillment area', () => {
  const accepted = regionalAvailability(raw.items[0].productId, options());
  assert.equal(accepted.status, 'available');
  assert.equal(accepted.unitPriceMinor, 499);
  assert.equal(accepted.scopeBound, true);
  for (const key of ['customerId', 'accountId', 'fulfillmentAreaId', 'deliveryCommitment']) {
    const changed = { ...scope, [key]: key === 'deliveryCommitment' ? 'b'.repeat(64) : 'different' };
    assert.equal(regionalAvailability(raw.items[0].productId, options({ trustedScope: changed })).status, 'unknown', key);
  }
  assert.equal(regionalAvailability(raw.items[0].productId, options({ regionId: 'warsaw' })).status, 'unknown');
  assert.equal(regionalAvailability(raw.items[0].productId, options({ trustedScope: { ...scope, fulfillmentAreaId: '' } })).status, 'unknown');
  assert.equal(regionalAvailability(raw.items[0].productId, options({ regionId: null })).status, 'unknown');
  const result = normalizeCatalogue(raw, options());
  assert.equal(result.personalized, true);
  assert.equal(result.verified, false);
  assert.equal(result.items[0].unitPriceMinor, raw.items[0].unitPriceMinor);
  assert.equal(result.items[0].availability.unitPriceMinor, 499);
  assert.doesNotMatch(JSON.stringify(result), /owned-account|private-observation|aaaaaaaaaaaaaaaa/);
});

test('different cities use their own scoped offer; selecting a city never transfers another city stock or price', () => {
  const warsawScope = { ...scope, regionId: 'warsaw', fulfillmentAreaId: 'warsaw-zone-b', deliveryCommitment: 'b'.repeat(64) };
  const offers = [observation(), observation({ ...warsawScope, availability: 'unavailable', unitPriceMinor: 599 })];
  assert.equal(regionalAvailability(raw.items[0].productId, options({ offerObservations: offers })).status, 'available');
  assert.equal(regionalAvailability(raw.items[0].productId, options({ regionId: 'warsaw', offerObservations: offers })).status, 'unknown');
  const warsaw = regionalAvailability(raw.items[0].productId, options({ regionId: 'warsaw', trustedScope: warsawScope, offerObservations: offers }));
  assert.equal(warsaw.status, 'unavailable');
  assert.equal(warsaw.unitPriceMinor, 599);
});

test('expiry, future timestamps, latest unknown or malformed observations invalidate older available stock', () => {
  for (const changed of [
    { expiresAt: now }, { observedAt: now - 120_000, expiresAt: now + 1000 },
    { observedAt: now + 1 }, { source: 'public_page' }, { evidenceId: '' },
    { currency: 'USD' }, { unitPriceMinor: -1 },
  ]) assert.equal(regionalAvailability(raw.items[0].productId, options({ offerObservations: [observation(changed)] })).status, 'unknown');
  const older = observation({ observedAt: now - 5000 });
  for (const latest of [observation({ availability: 'unknown' }), observation({ observedAt: null }),
    observation({ availability: 'unknown', unitPriceMinor: null })]) {
    assert.equal(regionalAvailability(raw.items[0].productId, options({ offerObservations: [older, latest] })).status, 'unknown');
  }
  assert.equal(regionalAvailability(raw.items[0].productId, options({ maxOfferAgeMs: 120_001 })).status, 'unknown');
});

test('conflicting same-time observations and malformed catalogue IDs fail closed', () => {
  const offers = [observation(), observation({ availability: 'unavailable' })];
  assert.equal(regionalAvailability(raw.items[0].productId, options({ offerObservations: offers })).status, 'unknown');
  for (const items of [[raw.items[0], raw.items[0]], [{ productId: '__proto__' }], Array(1001).fill(raw.items[0])]) {
    assert.throws(() => normalizeCatalogue({items}), {code:'invalid_cached_catalog'});
  }
});

test('Polish search handles accents, word order, product IDs and category filtering', () => {
  const items = normalizeCatalogue(raw).items;
  assert.equal(filterCatalogueItems(items, { query: 'maslo POLSKIE' })[0].productId, 'A0000953');
  assert.equal(filterCatalogueItems(items, { query: 'lubella piorka' })[0].productId, 'A0000450');
  assert.equal(filterCatalogueItems(items, { query: 'a0000840' })[0].productId, 'A0000840');
  assert.equal(filterCatalogueItems(items, { categoryId: 'dairy' }).length, 5);
  assert.equal(filterCatalogueItems(items, { query: 'maslo', categoryId: 'pantry' }).length, 0);
});

test('photo helper rejects private/arbitrary origins and optimizer source/query substitution', () => {
  const valid = normalizeCatalogue(raw).items[0];
  for (const url of ['data:image/png;base64,abc', 'http://127.0.0.1/private', '//delio.com.pl/photo',
    valid.imageUrl.replace('https://delio.com.pl/', 'https://evil.example/'),
    valid.imageUrl.replace('images.prod.lait.app', 'private.example'),
    `${valid.imageUrl}&url=https://example.test/image.png`, `${valid.imageUrl}#hidden`,
    valid.imageUrl.replace('https://delio.com.pl/', 'https://x:y@delio.com.pl/')]) {
    assert.equal(productImageUrl({imageUrl:url}), null, url);
  }
});

test('UI drops expired stock and price immediately and never displays raw stock flags as a scoped offer', () => {
  const product = normalizeCatalogue(raw, options()).items[0];
  assert.equal(visibleRegionalOffer(product, { regionId: 'krakow', now }).status, 'available');
  assert.equal(visibleRegionalOffer(product, { regionId: 'warsaw', now }), null);
  assert.equal(visibleRegionalOffer(product, { now }), null);
  assert.equal(visibleRegionalOffer(product, { regionId: 'krakow', now: product.availability.validUntil }), null);
  assert.equal(visibleRegionalOffer({stock:'in_stock',available:true}, {regionId:'krakow',now}), null);
});
