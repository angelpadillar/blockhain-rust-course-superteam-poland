import test from 'node:test';
import assert from 'node:assert/strict';
import { createFixtureServer } from './fixture.mjs';

async function withFixture(fn) {
  const fixture = await createFixtureServer({ seed: 77 });
  try { await fn(fixture); } finally { await fixture.close(); }
}
async function read(url) { return (await fetch(url)).text(); }
const anchors = document => [...document.matchAll(/<a href="([^"]+)">([^<]+)<\/a>/g)].map(match => ({ path: match[1], title: match[2] }));
async function observedShopLinks(fixture, descriptor) {
  const first = descriptor.publicPlan.steps[0];
  const document = await read(first.operation === 'open_link' ? descriptor.startUrl : `${descriptor.startUrl}/search?q=${encodeURIComponent(first.query)}`);
  return [...document.matchAll(/<section aria-label="([^"]+)">([\s\S]*?)<\/section>/g)]
    .flatMap(section => anchors(section[2]).map(link => ({ ...link, district: section[1], url: fixture.origin + link.path })));
}
async function observedEntries(fixture, descriptor, shop) {
  const query = descriptor.publicPlan.steps[1].query;
  return anchors(await read(`${shop.url}/search?q=${encodeURIComponent(query)}`))
    .map(link => ({ ...link, url: fixture.origin + link.path, merchant: shop.title, district: shop.district }));
}
const evidencePage = ({ url, headings = [], merchants = [], districts = [] }) => ({ url: () => url,
  evaluate: async () => ({ headings, merchants, districts }) });

test('three two-step descriptors expose goals and plans without answer identifiers', async () => withFixture(async fixture => {
  assert.equal(fixture.cases.length, 3);
  for (const descriptor of fixture.cases) {
    assert.deepEqual(Object.keys(descriptor).sort(), ['expectation', 'goal', 'id', 'publicPlan', 'startUrl']);
    assert.equal(descriptor.publicPlan.steps.length, 2);
    assert.equal(descriptor.publicPlan.steps[1].operation, 'search_and_open');
    assert.equal(descriptor.expectation, 'complete');
    assert.match(descriptor.startUrl, /^http:\/\/127\.0\.0\.1:\d+\/cases\/[a-z-]+$/);
    assert.doesNotMatch(JSON.stringify(descriptor), /\/shop\/|\/entry\/|[a-f0-9]{20}|expectedUrl|selector|correctDistrict/);
    for (const step of descriptor.publicPlan.steps) {
      assert.ok(Object.keys(step).every(key => ['operation', 'query', 'targetText', 'context'].includes(key)));
      assert.ok(Object.isFrozen(step));
    }
    assert.ok(Object.isFrozen(descriptor.publicPlan.steps));
  }
  assert.equal(fixture.cases[2].publicPlan.steps[0].operation, 'open_link');
  assert.equal(Object.hasOwn(fixture, 'definitions'), false);
}));

test('native forms expose observed shop and detail routes while server stays read-only', async () => withFixture(async fixture => {
  const descriptor = fixture.cases[0];
  const initial = await read(descriptor.startUrl);
  assert.match(initial, /<form role="search" method="GET"/);
  assert.match(initial, /type="search"/);
  assert.deepEqual(anchors(initial), []);
  const [shop] = await observedShopLinks(fixture, descriptor);
  assert.equal(shop.title, descriptor.publicPlan.steps[0].targetText);
  const shopDocument = await read(shop.url);
  assert.ok(shopDocument.includes(`<h1>${shop.title}</h1>`));
  assert.match(shopDocument, /Search this shop/);
  assert.deepEqual(anchors(shopDocument), []);
  const [entry] = await observedEntries(fixture, descriptor, shop);
  assert.equal(entry.title, descriptor.publicPlan.steps[1].targetText);
  assert.match(await read(entry.url), /data-field="merchant"/);
  assert.equal((await fetch(shop.url, { method: 'POST', body: 'ignored' })).status, 405);
  assert.deepEqual(fixture.reset(descriptor.id), { caseId: descriptor.id, generation: 1 });
  assert.equal(fixture.requestCount(descriptor.id), 0);
}));

test('verifier requires exact final route, visible title, correct merchant and district', async () => withFixture(async fixture => {
  const descriptor = fixture.cases[0];
  const [shop] = await observedShopLinks(fixture, descriptor);
  const [entry] = await observedEntries(fixture, descriptor, shop);
  const visible = { url: entry.url, headings: [entry.title], merchants: [entry.merchant], districts: [entry.district] };
  const verified = await fixture.verify(evidencePage(visible), descriptor);
  assert.equal(verified.passed, true);
  assert.deepEqual(Object.keys(verified).sort(), ['checks', 'expectation', 'passed']);
  assert.doesNotMatch(JSON.stringify(verified), /\/entry\/|[a-f0-9]{20}/);
  for (const change of [{ headings: [] }, { merchants: [] }, { districts: [] },
    { url: shop.url }, { url: entry.url + '?claim=success' }, { url: entry.url + '#claim' },
    { url: entry.url.replace(fixture.origin, 'https://example.invalid') }]) {
    assert.equal((await fixture.verify(evidencePage({ ...visible, ...change }), descriptor)).passed, false);
  }
}));

test('wrong duplicate context fails even when merchant and item titles both match', async () => withFixture(async fixture => {
  const descriptor = fixture.cases.find(item => item.id === 'contextual-merchant');
  const shops = await observedShopLinks(fixture, descriptor);
  assert.equal(shops.length, 2);
  assert.ok(shops.every(shop => shop.title === descriptor.publicPlan.steps[0].targetText));
  assert.equal(descriptor.publicPlan.steps[0].context, 'the shop for creative studio work');
  assert.ok(shops.every(shop => shop.district !== descriptor.publicPlan.steps[0].context));
  const wrong = shops.find(shop => shop.district === 'Travel district');
  const correct = shops.find(shop => shop.district === 'Studio district');
  const [wrongEntry] = await observedEntries(fixture, descriptor, wrong);
  const [correctEntry] = await observedEntries(fixture, descriptor, correct);
  assert.equal(wrongEntry.title, correctEntry.title);
  const wrongEvidence = { url: wrongEntry.url, headings: [wrongEntry.title], merchants: [wrongEntry.merchant], districts: [wrongEntry.district] };
  const result = await fixture.verify(evidencePage(wrongEvidence), { ...descriptor, publicPlan: { steps: [] }, expectedUrl: wrongEntry.url, status: 'completed' });
  assert.equal(result.passed, false);
  assert.equal(result.checks.visibleExactTitle, true);
  assert.equal(result.checks.correctMerchant, true);
  assert.equal(result.checks.correctDistrict, false);
  assert.equal(result.checks.exactDetailRoute, false);
  assert.equal((await fixture.verify(evidencePage({ url: correctEntry.url, headings: [correctEntry.title],
    merchants: [correctEntry.merchant], districts: [correctEntry.district] }), descriptor)).passed, true);
}));

test('direct link workflow includes duplicate contexts and delayed visible detail evidence', async () => withFixture(async fixture => {
  const descriptor = fixture.cases.find(item => item.id === 'direct-link-delayed-heading');
  const initial = await read(descriptor.startUrl);
  assert.doesNotMatch(initial, /<form/);
  assert.equal(anchors(initial).length, 2);
  const shop = (await observedShopLinks(fixture, descriptor)).find(item => item.district === 'Studio district');
  const [entry] = await observedEntries(fixture, descriptor, shop);
  const detail = await read(entry.url);
  assert.match(detail, /<h1 hidden>/);
  assert.match(detail, /},650\)/);
  const before = await fixture.verify(evidencePage({ url: entry.url, headings: [], merchants: [entry.merchant], districts: [entry.district] }), descriptor);
  assert.equal(before.passed, false);
  assert.equal(before.checks.visibleExactTitle, false);
}));

test('seed changes observed answer routes while goals and plans remain identical', async () => {
  const fixtures = await Promise.all([31, 31, 32].map(seed => createFixtureServer({ seed })));
  try {
    const descriptors = fixtures.map(fixture => fixture.cases[0]);
    assert.equal(descriptors[0].goal, descriptors[2].goal);
    assert.deepEqual(descriptors[0].publicPlan, descriptors[2].publicPlan);
    const shops = await Promise.all(fixtures.map((fixture, index) => observedShopLinks(fixture, descriptors[index])));
    assert.equal(shops[0][0].path, shops[1][0].path);
    assert.notEqual(shops[0][0].path, shops[2][0].path);
    const entries = await Promise.all(fixtures.map((fixture, index) => observedEntries(fixture, descriptors[index], shops[index][0])));
    assert.equal(entries[0][0].path, entries[1][0].path);
    assert.notEqual(entries[0][0].path, entries[2][0].path);
  } finally { await Promise.all(fixtures.map(fixture => fixture.close())); }
});
