import test from 'node:test';
import assert from 'node:assert/strict';
import { openBrowser } from '../src/glovo.mjs';
import { runShopping } from '../src/runner.mjs';
import { config, job, temp, response } from './helpers.mjs';
import { fixture } from './store-fixture.mjs';
import { candidates } from '../src/policy.mjs';

async function execute(t, options = {}) {
  const store = await fixture(options); t.after(() => store.close());
  const dataDir = await temp(t), cfg = { ...config, storeUrl: store.url };
  const result = await runShopping({ id: 'browser-test', job, config: cfg, signal: new AbortController().signal,
    open: () => openBrowser({ dataDir, config: cfg }), decide: async request => {
      const entries = Object.entries(request.questions.next_action.criteria);
      const chosen = entries.find(([, label]) => label.startsWith('Add one'))
        || entries.find(([, label]) => label.startsWith('Open the final'))
        || entries.find(([, label]) => label.startsWith('Search for'));
      return response(chosen?.[0] || 'unavailable');
    } });
  assert.equal(store.orders(), 0);
  return result;
}

test('real Playwright searches, adds exact product, reaches summary, stops before purchase', async t => {
  const result = await execute(t);
  assert.equal(result.status, 'ready_for_review', JSON.stringify(result));
  assert.equal(result.metrics.actions, 3); assert.equal(result.intent.amountMinor, 1000);
});
test('real Playwright rejects a final total over budget', async t => {
  const result = await execute(t, { total: '100,00' });
  assert.equal(result.reason, 'checkout_verification_failed'); assert.equal(result.intent, null);
});
test('real Playwright refuses a pre-existing basket without changing it', async t => {
  const result = await execute(t, { existing: true });
  assert.equal(result.reason, 'existing_cart_requires_attention'); assert.equal(result.metrics.actions, 0);
});
test('real Playwright refuses the wrong delivery destination', async t => {
  const result = await execute(t, { address: 'Wrong Street 99' });
  assert.equal(result.reason, 'destination_requires_setup'); assert.equal(result.metrics.modelCalls, 0);
});

test('a changed control cannot reuse a previously valid browser action', async t => {
  const store = await fixture(); t.after(() => store.close());
  const dataDir = await temp(t), cfg = { ...config, storeUrl: store.url };
  const session = await openBrowser({ dataDir, config: cfg });
  try {
    const initial = await session.adapter.observe();
    const action = candidates(initial, job, cfg)[0];
    await session.page.locator('input').evaluate(el => { el.setAttribute('aria-label', 'Payment card'); });
    await assert.rejects(session.adapter.execute(action, job, new AbortController().signal), /stale_or_forbidden_action/);
    assert.equal(store.orders(), 0);
  } finally { await session.close(); }
});
