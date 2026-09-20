import test from 'node:test';
import assert from 'node:assert/strict';
import { runShopping } from '../src/runner.mjs';
import { createJev } from '../src/jev.mjs';
import { config, job, control, observation, checkout, response } from './helpers.mjs';

function session({ initial = observation(), final = checkout(), actionFailure = false } = {}) {
  let phase = 0, closed = 0;
  const cart = [{ name: job.items[0].query, qty: 1 }];
  const states = [observation({ controls: [control('Add item', { product: job.items[0].query })] }),
    observation({ cart, controls: [control('Przejdź do kasy')] }), final];
  return { close: async () => { closed++; }, closed: () => closed,
    page: { url: () => states[phase].url },
    adapter: { waitReady: async (_signal, checkout) => checkout ? final : initial,
      observe: async () => states[phase], execute: async () => { if (actionFailure) throw new Error('contains-private-value'); phase++; } } };
}
const run = (s, extra = {}) => runShopping({ id: 'test', job, config, signal: new AbortController().signal,
  open: async () => s, decide: async () => response('a0'), ...extra });

test('complete run verifies checkout, produces expiring intent and accurate model totals', async () => {
  const s = session(), result = await run(s);
  assert.equal(result.status, 'ready_for_review'); assert.equal(result.paymentExecuted, false);
  assert.equal(result.metrics.modelCalls, 2); assert.equal(result.metrics.inputTokens, 2000);
  assert.equal(result.metrics.estimatedModelUsd, 0.000084);
  assert.equal(result.intent.amountMinor, 1000); assert.equal(result.intent.status, 'requires_separate_approval');
  assert.equal(Date.parse(result.intent.expiresAt) - Date.parse(result.intent.createdAt), 300000);
  assert.equal(result.intent.sha256.length, 64); assert.equal(s.closed(), 1);
});
test('existing basket and wrong destination stop before any provider call', async () => {
  for (const initial of [observation({ cart: [{ name: 'Existing', qty: 1 }] }), observation({ destinationVerified: false })]) {
    const result = await run(session({ initial }));
    assert.equal(result.status, 'needs_attention'); assert.equal(result.metrics.modelCalls, 0);
  }
});
test('bad checkout never emits an intent and browser failure does not leak raw exception', async () => {
  const result = await run(session({ final: checkout({ totalMinor: 100000 }) }));
  assert.equal(result.status, 'needs_attention'); assert.equal(result.intent, null);
  const failed = await run(session({ actionFailure: true }));
  assert.equal(failed.reason, 'browser_or_runtime_error'); assert.ok(!JSON.stringify(failed).includes('private-value'));
});
test('invalid model choice, cost limit and cancellation stop execution', async () => {
  assert.equal((await run(session(), { decide: async () => response('done') })).reason, 'invalid_model_choice');
  const cost = await run(session(), { config: { ...config, maxModelUsd: 0.000001 } });
  assert.equal(cost.reason, 'model_cost_limit'); assert.equal(cost.metrics.actions, 0);
  const controller = new AbortController(); controller.abort();
  assert.equal((await run(session(), { signal: controller.signal })).status, 'cancelled');
});
test('provider failures count attempted calls, mark incomplete billing, and never retry', async () => {
  const result = await run(session(), { decide: async () => { throw new Error('network'); } });
  assert.equal(result.metrics.modelCalls, 1); assert.equal(result.metrics.usageComplete, false);
  assert.equal(result.metrics.actions, 0);
});
test('Jev client pins endpoint, disables redirects, validates usage and sanitizes errors', async () => {
  let calls = 0;
  const decide = createJev({ apiKey: 'test-secret-key', model: 'jev-latest', fetchImpl: async (url, options) => {
    calls++; assert.equal(url, 'https://api.typesafe.ai/v1/systemone'); assert.equal(options.redirect, 'error');
    return new Response(JSON.stringify(response('a0')), { status: 200 });
  } });
  assert.equal((await decide({ state: '{}', questions: {} }, new AbortController().signal)).usage.input_tokens, 1000);
  assert.equal(calls, 1);
  const broken = createJev({ apiKey: 'test-secret-key', model: 'jev-latest', fetchImpl: async () => new Response('private-secret', { status: 401 }) });
  await assert.rejects(broken({}, new AbortController().signal), /provider_http_401/);
});
