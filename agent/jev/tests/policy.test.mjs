import test from 'node:test';
import assert from 'node:assert/strict';
import { validateConfig, validateJob } from '../src/config.mjs';
import { candidates, allowedUrl, verifyCheckout, decisionRequest, validateChoice, blocksMutation } from '../src/policy.mjs';
import { parseObservation, browserEnvironment } from '../src/glovo.mjs';
import { config, job, control, observation, checkout, response } from './helpers.mjs';

test('configuration and jobs reject arbitrary sites, paths, spend and payment options', () => {
  validateConfig(config); validateJob(job, config);
  for (const storeUrl of ['http://glovoapp.com/pl/pl/krakow/stores/test', 'https://glovoapp.com.evil.test/pl/pl/krakow/stores/test', 'http://127.0.0.1/admin']) assert.throws(() => validateConfig({ ...config, storeUrl }));
  for (const input of [{ ...job, allowPay: true }, { ...job, maxPln: 27 }, { ...job, items: [{ query: 'x', qty: -1 }] }, { ...job, items: [...job.items, ...job.items] }]) assert.throws(() => validateJob(input, config));
  assert.equal(allowedUrl('https://glovoapp.com/en/pl/krakow/order-summary?storeId=123', config), true);
  assert.equal(allowedUrl('https://glovoapp.com/pl/pl/krakow/stores/other', config), false);
});

test('only exact approved additions and configured searches are executable', () => {
  const controls = [control('Add item', { product: job.items[0].query }), control('Add item', { product: 'Other juice' }), control('Przejdź do kasy'), control('Continue'), control('Order and pay'), control('Add card'), control('Upload file', { tag: 'input', type: 'file' }), control('Email', { tag: 'input', type: 'email' })];
  const actions = candidates(observation({ controls }), job, config);
  assert.equal(actions.length, 1); assert.match(actions[0].description, /Add one Test apple/);
  const full = observation({ controls, cart: [{ name: job.items[0].query, qty: 1 }] });
  assert.equal(candidates(full, job, config).length, 1);
  assert.match(candidates(full, job, config)[0].description, /final order summary/);
  assert.deepEqual(candidates(checkout({ controls }), job, config), []);
});

test('checkout verification rejects wrong basket, destination, merchant, price, count or loading UI', () => {
  const cart = [{ name: job.items[0].query, qty: 1 }];
  assert.equal(verifyCheckout(checkout(), cart, job, config).passed, true);
  for (const changed of [{ totalMinor: 2700 }, { totalMinor: null }, { destinationVerified: false }, { checkoutMerchant: 'Other shop' }, { checkoutReady: false }, { checkoutUnits: 2 }]) assert.equal(verifyCheckout(checkout(changed), cart, job, config).passed, false);
  assert.equal(verifyCheckout(checkout(), [...cart, { name: 'Other', qty: 1 }], job, config).passed, false);
});

test('model prompt contains shopping data and no account, address, raw DOM or payment data', () => {
  const obs = observation({ text: 'secret@example.com card ending 1234 Test Street 20', controls: [control('secret@example.com')] });
  const request = decisionRequest(obs, [], job, []);
  for (const secret of ['secret@example.com', '1234', 'Test Street 20']) assert.ok(!JSON.stringify(request).includes(secret));
  assert.throws(() => validateChoice(response('execute_arbitrary_javascript'), request));
  assert.equal(validateChoice(response('unavailable'), request), 'unavailable');
});

test('rendered DOM parser accepts Polish total and destination, fails unknown quantities', () => {
  const raw = { text: 'Test Street, 20\n1 prod. z: Test shop\nŁĄCZNIE\n25,24 zł', headings: ['Podsumowanie zamówienia'], cart: [], controls: [control('Zamów i zapłać')] };
  const parsed = parseObservation(raw, checkout().url, config);
  assert.equal(parsed.totalMinor, 2524); assert.equal(parsed.destinationVerified, true);
  assert.equal(parsed.checkoutUnits, 1); assert.equal(parsed.checkoutMerchant, 'Test shop');
  assert.equal(parsed.cartKnown, false);
});

test('the empty-basket wording observed on Glovo is recognized; neighboring street numbers do not match', () => {
  const raw = { text: 'Test Street 20\nGdy dodasz produkty z oferty punktu, pojawią się one w tym miejscu.',
    headings: ['Twoje zamówienie'], cart: [], controls: [] };
  assert.equal(parseObservation(raw, config.storeUrl, config).cartKnown, true);
  assert.equal(parseObservation({ ...raw, text: raw.text.replace('20', '201') }, config.storeUrl, config).destinationVerified, false);
  assert.equal(parseObservation({ ...raw, text: 'Punkt Duży Ben jest tymczasowo zamknięty\nSprawdź otwarte lokale' }, config.storeUrl, config).unavailable, true);
});

test('defense in depth blocks order/payment mutations; API keys do not enter browser env', () => {
  assert.equal(blocksMutation('POST', 'https://api.glovoapp.com/v3/orders'), true);
  assert.equal(blocksMutation('GET', 'https://api.glovoapp.com/v3/orders'), false);
  assert.equal(blocksMutation('POST', 'https://api.glovoapp.com/v3/cart'), false);
  assert.ok(!Object.hasOwn(browserEnvironment(), 'TYPESAFE_API_KEY'));
});
