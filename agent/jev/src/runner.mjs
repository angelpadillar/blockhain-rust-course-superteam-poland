import { createHash } from 'node:crypto';
import { assert, Stop, normalize } from './config.mjs';
import { candidates, decisionRequest, validateChoice, verifyCheckout, paymentIntent, isCheckout } from './policy.mjs';

export async function runShopping({ id, job, config, open, decide, signal, progress = async () => {} }) {
  const start = performance.now();
  const metrics = { wallMs: 0, browserMs: 0, modelMs: 0, modelCalls: 0, actions: 0,
    inputTokens: 0, outputTokens: 0, estimatedModelUsd: 0, usageComplete: true,
    inputUsdPerMillion: config.inputUsdPerMillion, outputUsdPerMillion: config.outputUsdPerMillion,
    infrastructureUsd: null, steps: [] };
  const result = { status: 'running', reason: null, paymentExecuted: false, metrics, intent: null };
  let session, lastCart = [], lastHash = '', repetitions = 0;
  const deadline = AbortSignal.timeout(config.maxRunMs);
  const combined = AbortSignal.any([signal, deadline]);
  const closeOnAbort = () => { if (session) void session.close().catch(() => {}); };
  combined.addEventListener('abort', closeOnAbort, { once: true });
  async function timedBrowser(fn) {
    const before = performance.now();
    try { return await fn(); } finally { metrics.browserMs += performance.now() - before; }
  }
  try {
    combined.throwIfAborted();
    session = await timedBrowser(open);
    combined.throwIfAborted();
    let observation = await timedBrowser(() => session.adapter.waitReady(combined));
    assert(observation.cartKnown && observation.cart.length === 0, 'existing_cart_requires_attention');
    assert(observation.destinationVerified, 'destination_requires_setup');
    for (let step = 0; step <= config.maxSteps; step++) {
      combined.throwIfAborted();
      observation = await timedBrowser(() => isCheckout(session.page.url())
        ? session.adapter.waitReady(combined, true) : session.adapter.observe());
      if (isCheckout(observation.url)) {
        const verification = verifyCheckout(observation, lastCart, job, config);
        result.verification = verification;
        assert(verification.passed, 'checkout_verification_failed');
        result.status = 'ready_for_review';
        result.intent = paymentIntent(id, observation, lastCart, config);
        break;
      }
      assert(step < config.maxSteps, 'step_limit');
      assert(observation.cartKnown, 'cart_not_readable');
      assert(observation.destinationVerified, 'destination_changed');
      assert(!observation.blocked, 'browser_challenge');
      assert(!observation.unavailable, 'merchant_unavailable');
      // Stop immediately for any unexpected product or excess quantity.
      assert(observation.cart.every(row => job.items.some(i => normalize(i.query) === normalize(row.name) && row.qty <= i.qty)), 'unexpected_cart');
      lastCart = observation.cart;
      assert(metrics.estimatedModelUsd < config.maxModelUsd, 'model_cost_limit');
      const actions = candidates(observation, job, config);
      assert(actions.length > 0, 'no_supported_controls');
      const request = decisionRequest(observation, actions, job, metrics.steps.slice(-8).map(s => ({ action: s.action, choice: s.choice })));
      const modelStart = performance.now();
      metrics.modelCalls++;
      let response;
      try { response = await decide(request, combined); }
      catch (error) { metrics.usageComplete = false; throw error; }
      finally { metrics.modelMs += performance.now() - modelStart; }
      for (const key of ['input_tokens', 'output_tokens']) {
        if (!Number.isSafeInteger(response.usage?.[key]) || response.usage[key] < 0) {
          metrics.usageComplete = false; throw new Stop('provider_usage_missing');
        }
      }
      metrics.inputTokens += response.usage.input_tokens;
      metrics.outputTokens += response.usage.output_tokens;
      metrics.estimatedModelUsd = (metrics.inputTokens * config.inputUsdPerMillion + metrics.outputTokens * config.outputUsdPerMillion) / 1e6;
      const choice = validateChoice(response, request);
      assert(choice !== 'unavailable', 'model_cannot_proceed');
      const action = actions.find(a => a.id === choice);
      assert(action, 'invalid_model_choice');
      const hash = createHash('sha256').update(JSON.stringify({ actions, cart: observation.cart, choice })).digest('hex');
      repetitions = hash === lastHash ? repetitions + 1 : 0; lastHash = hash;
      assert(repetitions < 2, 'repeated_action');
      assert(metrics.estimatedModelUsd <= config.maxModelUsd, 'model_cost_limit');
      combined.throwIfAborted();
      const actionStart = performance.now();
      await timedBrowser(() => session.adapter.execute(action, job, combined));
      metrics.actions++;
      metrics.steps.push({ step: step + 1, choice, action: action.description, model: response.model || config.model,
        modelMs: response.latencyMs, browserMs: performance.now() - actionStart,
        inputTokens: response.usage.input_tokens, outputTokens: response.usage.output_tokens });
      await progress({ ...result, metrics: { ...metrics, wallMs: performance.now() - start } });
    }
  } catch (error) {
    result.status = signal.aborted ? 'cancelled' : 'needs_attention';
    result.reason = signal.aborted ? 'cancelled' : deadline.aborted ? 'time_limit'
      : error instanceof Stop ? error.code : 'browser_or_runtime_error';
  } finally {
    combined.removeEventListener('abort', closeOnAbort);
    if (session) await timedBrowser(() => session.close()).catch(() => {});
    metrics.wallMs = performance.now() - start;
  }
  return result;
}
