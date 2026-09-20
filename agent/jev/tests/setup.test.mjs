import test from 'node:test';
import assert from 'node:assert/strict';
import { verifySetupObservation, setupErrorMessage, setupPage, setupPolicyDigest } from '../src/setup.mjs';
import { allowedSetupUrl, candidates } from '../src/policy.mjs';
import { config, observation, control, job } from './helpers.mjs';

test('onboarding reports the exact failed requirement and keeps the basket/address guards', () => {
  verifySetupObservation(observation());
  for (const [change, code] of [
    [{ destinationVerified: false }, 'setup_address_mismatch'],
    [{ unavailable: true }, 'setup_store_unavailable'],
    [{ cartKnown: false }, 'setup_cart_unreadable'],
    [{ cart: [{ name: 'Existing product', qty: 1 }] }, 'setup_cart_not_empty'],
    [{ blocked: true }, 'setup_browser_challenge'],
    [{ url: 'https://glovoapp.com/pl/pl/krakow/order-summary' }, 'setup_checkout_open'],
  ]) {
    assert.throws(() => verifySetupObservation(observation(change)), error => error.code === code);
    assert.ok(setupErrorMessage({ code }).length > 30);
  }
});

test('setup page shows the expected destination and safely renders errors', () => {
  const html = setupPage({ ...config, expectedAddress: '<unsafe> Street 1' }, 'test-nonce', 'A different address is selected.');
  assert.ok(html.includes('&lt;unsafe&gt; Street 1'));
  assert.ok(!html.includes('<unsafe>'));
  assert.ok(html.includes('A different address is selected.'));
  assert.ok(html.includes('Test shop'));
  assert.ok(!setupErrorMessage(new Error('private@example.com')).includes('private@example.com'));
});

test('signed-in account setup may finish on a listing page without claiming its basket or store is ready', () => {
  const current = observation({ url: 'https://glovoapp.com/pl/pl/krakow/categories/jedzenie_1',
    cartKnown: false, unavailable: true, controls: [control('Test user')] });
  const configured = { ...config, expectedAccountLabel: 'Test user' };
  assert.equal(allowedSetupUrl(current.url), true);
  assert.deepEqual(verifySetupObservation(current, configured), { accountVerified: true, basketVerifiedEmpty: false, storeReady: false });
  assert.deepEqual(candidates(current, job, configured), []);
  assert.throws(() => verifySetupObservation({ ...current, controls: [control('Zaloguj się')] }, configured), e => e.code === 'setup_login_required');
  assert.throws(() => verifySetupObservation({ ...current, destinationVerified: false }, configured), e => e.code === 'setup_address_mismatch');
  assert.throws(() => verifySetupObservation({ ...current, cartKnown: true, cart: [{ name: 'Existing', qty: 1 }] }, configured), e => e.code === 'setup_cart_not_empty');
  assert.notEqual(setupPolicyDigest(configured), setupPolicyDigest({ ...configured, expectedAddress: 'New Street 3' }));
});
