import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyAction, validateAction, classifyRequest, createMutationPermit, createRequestGuard, SafetyError } from './safety.mjs';

const origin = 'https://www.amazon.pl';
const context = () => ({ currentUrl: origin + '/dp/public-product', allowedOrigin: origin, guestSession: true,
  ownedCartItemKeys: new Set(['run-item-1']) });
const add = { operation: 'add_to_cart', kind: 'click', label: 'Dodaj do koszyka', tag: 'input', inputType: 'submit',
  formAction: '/gp/product/handle-buy-box/ref=dp_start', formMethod: 'POST' };
const request = (url, method = 'GET', resourceType = 'fetch', navigation = false) => ({ url, method, resourceType, navigation });
function mockRoute(descriptor) {
  const counts = { fallback: 0, abort: 0 };
  return { counts, request: () => ({ url: () => descriptor.url, method: () => descriptor.method,
    resourceType: () => descriptor.resourceType, isNavigationRequest: () => descriptor.navigation }),
    fallback: async () => { counts.fallback++; }, abort: async () => { counts.abort++; } };
}

test('Polish Amazon add-to-cart is allowed; buy-now, checkout and place-order labels are denied', () => {
  assert.equal(classifyAction(add, context()).allowed, true);
  for (const label of ['Kup teraz', 'Przejdź do realizacji zamówienia', 'Złóż zamówienie', 'Przejdź do kasy', 'Zapłać',
    'Buy now', 'Place your order', 'Proceed to checkout', 'Zaloguj się', 'Account settings', 'Prześlij plik']) {
    const decision = classifyAction({ ...add, label }, context());
    assert.equal(decision.allowed, false, label);
  }
  assert.throws(() => validateAction({ ...add, label: 'Kup teraz' }, context()), SafetyError);
});

test('safe native search, product options and bounded product quantities remain allowed', () => {
  const search = { operation: 'search', kind: 'fill', inputType: 'search', label: 'Szukaj', value: 'plecak' };
  assert.equal(classifyAction(search, context()).allowed, true);
  assert.equal(classifyAction({ ...search, kind: 'press', value: 'Enter' }, context()).allowed, true);
  assert.equal(classifyAction({ ...search, kind: 'press', value: 'Control+Enter' }, context()).allowed, false);
  const option = { operation: 'choose_option', kind: 'select', label: 'Kolor', value: 'Zielony', formAction: add.formAction };
  assert.equal(classifyAction(option, context()).allowed, true);
  const quantity = { operation: 'set_quantity', kind: 'fill', inputType: 'number', label: 'Ilość', value: '2', formAction: add.formAction };
  assert.equal(classifyAction(quantity, context()).allowed, true);
  for (const value of ['0', '-1', '2.5', '11', 'infinite']) assert.equal(classifyAction({ ...quantity, value }, context()).allowed, false);
  assert.equal(classifyAction({ ...option, inputType: 'file' }, context()).allowed, false);
  assert.equal(classifyAction({ ...search, inputType: 'password' }, context()).allowed, false);
  assert.equal(classifyAction({ ...search, script: 'anything' }, context()).reason, 'unsupported_action_field');
});

test('only this run own guest item can be removed or have cart quantity changed', () => {
  const remove = { operation: 'remove_own_cart_item', kind: 'click', label: 'Usuń', cartItemKey: 'run-item-1',
    formAction: '/cart/remove', formMethod: 'POST' };
  assert.equal(classifyAction(remove, context()).allowed, true);
  for (const change of [{ guestSession: false }, { ownedCartItemKeys: new Set() }]) {
    assert.equal(classifyAction(remove, { ...context(), ...change }).allowed, false);
  }
  assert.equal(classifyAction({ ...remove, cartItemKey: 'other-person-item' }, context()).reason, 'item_not_owned_by_run');
  const quantity = { operation: 'set_quantity', kind: 'select', label: 'Quantity', value: 2, cartItemKey: 'run-item-1', formAction: '/cart/update' };
  assert.equal(classifyAction(quantity, { ...context(), quantityScope: 'cart' }).allowed, true);
  assert.equal(classifyAction({ ...quantity, cartItemKey: undefined }, { ...context(), quantityScope: 'cart' }).allowed, false);
  assert.equal(classifyAction(add, { ...context(), guestSession: false }).reason, 'guest_session_required');
});

test('cart view and cookie rejection are scoped operations; consent acceptance is not dismissal', () => {
  assert.equal(classifyAction({ operation: 'view_cart', kind: 'click', label: 'Przejdź do koszyka', href: '/gp/cart/view.html' }, context()).allowed, true);
  for (const label of ['Odrzuć wszystkie', 'Zamknij', 'Continue without accepting']) {
    assert.equal(classifyAction({ operation: 'dismiss_cookie', kind: 'click', label }, context()).allowed, true);
  }
  assert.equal(classifyAction({ operation: 'dismiss_cookie', kind: 'click', label: 'Akceptuj wszystkie' }, context()).allowed, false);
});

test('dangerous GET paths, action queries, encoded paths and redirects never become neutral product links', () => {
  const dangerous = ['/gp/buy/spc/handlers/display.html', '/checkout', '/orders/create', '/payment', '/account', '/settings',
    '/%2563heckout', '/product?action=place_order', '/product?proceedToCheckout=1', '/product?next=%2Fcheckout',
    '/cart/remove', '/gp/product/handle-buy-box', '/upload', 'javascript:alert(1)', 'https://other.test/product'];
  for (const href of dangerous) {
    assert.equal(classifyAction({ operation: 'open_product', kind: 'click', tag: 'a', label: 'Neutral label', href }, context()).allowed, false, href);
    assert.equal(classifyRequest(request(new URL(href, origin).href, 'GET', 'document', true), context()).allowed, false, href);
  }
  assert.equal(classifyAction({ operation: 'open_product', kind: 'click', tag: 'a', label: 'Backpack', href: '/dp/item' }, context()).allowed, true);
});

test('test preferences require explicit permission on a local fixture, never a production account', () => {
  const preference = { operation: 'test_preference', kind: 'click', label: 'Preferences', formAction: '/preferences', formMethod: 'POST' };
  const local = { ...context(), currentUrl: 'http://127.0.0.1:8123/reading', allowedOrigin: 'http://127.0.0.1:8123', allowTestSettings: true };
  assert.equal(classifyAction(preference, local).allowed, true);
  assert.equal(classifyAction(preference, { ...local, allowTestSettings: false }).allowed, false);
  assert.equal(classifyAction(preference, { ...context(), allowTestSettings: true }).allowed, false);
  assert.equal(classifyAction({ ...preference, formAction: '/account/settings' }, local).allowed, false);
  const permit = createMutationPermit(preference, local, { now: 100 });
  assert.equal(classifyRequest(request(local.allowedOrigin + '/preferences', 'POST'), local, { permit, now: 101 }).allowed, true);
});

test('mutation permits bind the exact observed endpoint and method; forgery, expiry and checkout endpoints fail', () => {
  const action = { ...add, formAction: '/cart/add?nonce=private-value' };
  const permit = createMutationPermit(action, context(), { now: 100, ttlMs: 50 });
  assert.equal(classifyRequest(request(origin + action.formAction, 'POST'), context(), { permit, now: 101 }).allowed, true);
  for (const [url, method] of [[origin + '/cart/add?nonce=different', 'POST'], [origin + action.formAction, 'DELETE'], [origin + '/checkout', 'POST']]) {
    assert.equal(classifyRequest(request(url, method), context(), { permit, now: 101 }).allowed, false);
  }
  assert.equal(classifyRequest(request(origin + action.formAction, 'POST'), context(), { permit, now: 150 }).allowed, false);
  assert.equal(classifyRequest(request(origin + action.formAction, 'POST'), context(), { permit: { ...permit }, now: 101 }).allowed, false);
  assert.equal(JSON.stringify(permit).includes('private-value'), false);
  assert.throws(() => createMutationPermit({ ...add, formAction: undefined }, context()), /observed_endpoint_required/);
  assert.throws(() => createMutationPermit({ ...add, formAction: '/checkout' }, context()), /dangerous_endpoint/);
});

test('passive external resources may load, but external navigation/fetch and arbitrary mutations cannot', () => {
  const asset = request('https://cdn.test/image.png', 'GET', 'image');
  assert.equal(classifyRequest(asset, context()).allowed, true);
  for (const change of [{ navigation: true }, { resourceType: 'fetch' }, { method: 'POST' }]) assert.equal(classifyRequest({ ...asset, ...change }, context()).allowed, false);
  const telemetry = classifyRequest(request(origin + '/events', 'POST'), context());
  assert.equal(telemetry.allowed, false); assert.equal(telemetry.stop, false);
  const order = classifyRequest(request(origin + '/orders', 'POST'), context());
  assert.equal(order.allowed, false); assert.equal(order.stop, true);
});

test('guard consumes a permit once and journals before allowing a cart request', async () => {
  const events = [], guard = createRequestGuard(context(), { now: () => 100, onEvent: async event => { events.push(event); } });
  guard.authorize(add);
  const first = mockRoute(request(origin + add.formAction, 'POST'));
  await guard.route(first);
  assert.equal(first.counts.fallback, 1); assert.equal(events[0].type, 'mutation_request_authorized');
  const second = mockRoute(request(origin + add.formAction, 'POST'));
  await guard.route(second);
  assert.equal(second.counts.abort, 1); assert.equal(guard.counts.authorizedMutations, 1);
  assert.equal(guard.signal.aborted, false);
  guard.authorize(add); guard.finishAction();
  const afterFinish = mockRoute(request(origin + add.formAction, 'POST')); await guard.route(afterFinish);
  assert.equal(afterFinish.counts.abort, 1);
});

test('unrelated analytics abort is nonfatal, dangerous navigation stops, and journal failures abort interception', async () => {
  const guard = createRequestGuard(context());
  const telemetry = mockRoute(request(origin + '/events', 'POST')); await guard.route(telemetry);
  assert.equal(telemetry.counts.abort, 1); assert.equal(guard.signal.aborted, false); assert.equal(guard.counts.unrelatedMutationAborts, 1);
  const checkout = mockRoute(request(origin + '/checkout', 'GET', 'document', true)); await guard.route(checkout);
  assert.equal(checkout.counts.abort, 1); assert.throws(() => guard.throwIfStopped(), /dangerous_endpoint/);
  const broken = createRequestGuard(context(), { onEvent: () => { throw new Error('private failure'); } });
  broken.authorize(add);
  const mutation = mockRoute(request(origin + add.formAction, 'POST')); await broken.route(mutation);
  assert.equal(mutation.counts.abort, 1); assert.equal(mutation.counts.fallback, 0); assert.equal(broken.signal.aborted, true);
});
