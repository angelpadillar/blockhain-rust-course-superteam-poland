import test from 'node:test';
import assert from 'node:assert/strict';
import { blockedMutationDiagnostic, navigationEndpointTemplate, navigationActionContext, createNavigationDiagnostics } from '../src/navigation-diagnostics.mjs';

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

test('blocked request diagnostics contain only coarse endpoint and allowlisted action metadata', () => {
  for (const [path, endpointClass] of [['cart', 'cart'], ['carts', 'cart'], ['basket', 'basket'], ['baskets', 'basket'],
    ['order', 'order'], ['orders', 'order'], ['payment', 'payment'], ['payments', 'payment'],
    ['transaction', 'transaction'], ['transactions', 'transaction'], ['address', 'address'], ['addresses', 'address']]) {
    const diagnostic = blockedMutationDiagnostic('post', `https://private.example/api/${path}/customer-secret?token=secret`,
      { sequence: 4, type: 'click', description: 'private label', headers: { authorization: 'secret' }, body: 'private body' });
    assert.deepEqual(diagnostic, { type: 'navigation_mutation_blocked', method: 'POST', endpointClass,
      endpointTemplate: `/:segment/${path}/:segment`,
      actionSequence: 4, actionType: 'click' });
    assert(!JSON.stringify(diagnostic).includes('secret'));
  }
  assert.deepEqual(blockedMutationDiagnostic('private-token', 'https://private.example/ORDERS/123/payments',
    { sequence: 'private-id', type: 'private-action' }),
  { type: 'navigation_mutation_blocked', method: 'OTHER', endpointClass: 'order', endpointTemplate: '/orders/:segment/payments' });
  assert.throws(() => blockedMutationDiagnostic('POST', 'https://private.example/catalogue/123'), /unclassified/);
});

test('endpoint templates retain only fixed path literals, never private path data, host or query', () => {
  const url = 'https://secret-user:secret-password@secret-host.test/v3/stores/secret-store/addresses/secret-address/products/secret-product/details?secret-query=secret-value#secret-fragment';
  assert.equal(navigationEndpointTemplate(url), '/v3/stores/:segment/addresses/:segment/products/:segment/details');
  assert.equal(navigationEndpointTemplate('https://secret.test/v4/stores/secret-store/addresses/secret-address/products/secret-product/view?productExternalId=secret-id'),
    '/v4/stores/:segment/addresses/:segment/products/:segment/view');
  assert.equal(navigationEndpointTemplate('https://secret.test/v6/%61ddresses/secret%2Fproducts/ADDRESS/PRODUCT'),
    '/:segment/:segment/:segment/address/product');
  const allowed = ['v1', 'v2', 'v3', 'v4', 'v5', 'stores', 'addresses', 'address', 'products', 'product',
    'details', 'view', 'catalog', 'catalogue', 'search', 'availability', 'collections', 'menus', 'cart', 'carts', 'basket', 'baskets',
    'orders', 'order', 'payments', 'payment', 'transactions', 'transaction'];
  for (const literal of allowed) assert.equal(navigationEndpointTemplate(`https://secret.test/${literal}`), `/${literal}`);
  const long = navigationEndpointTemplate(`https://secret.test/${Array.from({ length: 30 }, (_, i) => `secret-${i}`).join('/')}`);
  assert.equal(long, '/' + Array(24).fill(':segment').join('/'));
  assert(!JSON.stringify(blockedMutationDiagnostic('POST', url)).includes('secret'));
});

test('action context survives execution and observation and ends with the completed step', () => {
  let action = navigationActionContext(null, { type: 'action_planned', step: 2, kind: 'fill', action: 'Search for private text' });
  assert.deepEqual(action, { sequence: 2, type: 'fill' });
  action = navigationActionContext(action, { type: 'action_executed', step: 2, action: 'Search for private text' });
  assert.deepEqual(action, { sequence: 2, type: 'fill' });
  assert.deepEqual(navigationActionContext(action, { type: 'page_observed' }), action);
  assert.equal(navigationActionContext(action, { type: 'step_completed', entry: { step: 2 } }), null);
  assert.deepEqual(navigationActionContext(null,
    { type: 'action_planned', step: 3, action: 'repeat_scoped_age_confirmation' }),
  { sequence: 3, type: 'authorized_site_confirmation' });
  assert.deepEqual(navigationActionContext(action, { type: 'action_executed', step: 9 }), { sequence: 9 });
  assert.deepEqual(navigationActionContext(null, { type: 'action_executed' }), {});
});

test('route diagnostics retain their action snapshot and serialize with all navigation events and finish', async () => {
  const held = deferred(), writes = [], controller = new AbortController();
  let activeWrites = 0;
  const diagnostics = createNavigationDiagnostics({ abort: error => controller.abort(error), journal: {
    async record(event) {
      assert.equal(activeWrites++, 0);
      try {
        writes.push(event);
        if (event.type === 'navigation_mutation_blocked' && writes.filter(e => e.type === event.type).length === 1) await held.promise;
      } finally { activeWrites--; }
    },
    async finish(result) { assert.equal(activeWrites, 0); writes.push({ type: 'finished', result }); },
  } });
  await diagnostics.onEvent({ type: 'action_planned', step: 1, kind: 'click' });
  let abortedRoutes = 0;
  const first = diagnostics.blockMutation('POST', 'https://example.test/carts/1', async () => { abortedRoutes++; });
  const second = diagnostics.blockMutation('DELETE', 'https://example.test/baskets/2', async () => { abortedRoutes++; });
  const executed = diagnostics.onEvent({ type: 'action_executed', step: 1 });
  await Promise.resolve(); await Promise.resolve();
  assert.equal(writes.length, 2);
  assert.equal(abortedRoutes, 0);
  held.resolve();
  await Promise.all([first, second, executed]);
  await diagnostics.blockMutation('PUT', 'https://example.test/addresses/3', async () => { abortedRoutes++; });
  await diagnostics.onEvent({ type: 'step_completed', entry: { step: 1 } });
  await diagnostics.blockMutation('PATCH', 'https://example.test/transactions/4', async () => { abortedRoutes++; });
  await diagnostics.flush();
  await diagnostics.finish({ status: 'incomplete' });
  const blocked = writes.filter(e => e.type === 'navigation_mutation_blocked');
  assert.deepEqual(blocked.slice(0, 3).map(e => [e.actionSequence, e.actionType]), [[1, 'click'], [1, 'click'], [1, 'click']]);
  assert.equal(blocked[3].actionSequence, undefined);
  assert.equal(blocked[3].actionType, undefined);
  assert.equal(writes.at(-1).type, 'finished');
  assert.equal(abortedRoutes, 4);
  assert.equal(controller.signal.aborted, false);
});

test('a failed mutation journal write cancels actions and still aborts its intercepted request', async () => {
  const controller = new AbortController(), writes = [], terminal = [];
  let abortCalls = 0, routeAborted = false;
  const diagnostics = createNavigationDiagnostics({ abort: error => { abortCalls++; controller.abort(error); }, journal: {
    async record(event) { writes.push(event); if (event.type === 'navigation_mutation_blocked') throw new Error('disk full'); },
    async finish(result) { terminal.push(result); },
  } });
  await diagnostics.onEvent({ type: 'action_planned', step: 1, kind: 'click' });
  await diagnostics.blockMutation('POST', 'https://example.test/payments/private-id', async () => {
    assert.equal(controller.signal.aborted, true);
    routeAborted = true;
    throw new Error('context already closed');
  });
  assert.equal(routeAborted, true);
  assert.equal(controller.signal.reason.code, 'navigation_journal_failed');
  await assert.rejects(diagnostics.onEvent({ type: 'action_planned', step: 2, kind: 'click' }), { code: 'navigation_journal_failed' });
  await assert.rejects(diagnostics.flush(), { code: 'navigation_journal_failed' });
  assert.equal(writes.length, 2);
  assert.equal(abortCalls, 1);
  await diagnostics.finish({ status: 'incomplete', reason: 'navigation_journal_failed' });
  assert.equal(terminal.length, 1);
});

test('a failed regular event write also cancels the run and settles queued intercepted requests', async () => {
  const held = deferred(), controller = new AbortController();
  let records = 0, routeAborted = false;
  const diagnostics = createNavigationDiagnostics({ abort: error => controller.abort(error), journal: {
    async record() { records++; await held.promise; }, async finish() {},
  } });
  const planned = diagnostics.onEvent({ type: 'action_planned', step: 1, kind: 'click' });
  const rejected = assert.rejects(planned, { code: 'navigation_journal_failed' });
  const blocked = diagnostics.blockMutation('POST', 'https://example.test/orders/1', async () => { routeAborted = true; });
  held.reject(new Error('journal unavailable'));
  await Promise.all([rejected, blocked]);
  assert.equal(records, 1);
  assert.equal(routeAborted, true);
  assert.equal(controller.signal.aborted, true);
});
