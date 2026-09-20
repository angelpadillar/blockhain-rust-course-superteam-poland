import { assert, Stop } from './config.mjs';

export function createJev({ apiKey, model, fetchImpl = fetch }) {
  assert(typeof apiKey === 'string' && apiKey.length > 10, 'missing_typesafe_key');
  return async function decide(request, signal) {
    assert(JSON.stringify(request).length <= 64000, 'model_request_too_large');
    const start = performance.now();
    let response;
    try {
      response = await fetchImpl('https://api.typesafe.ai/v1/systemone', {
        method: 'POST', redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]),
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, ...request }),
      });
    } catch { throw new Stop(signal.aborted ? 'cancelled_or_timed_out' : 'provider_network_error'); }
    if (!response.ok) throw new Stop(`provider_http_${response.status}`);
    let data;
    try { data = await response.json(); } catch { throw new Stop('invalid_provider_json'); }
    // Usage must be known to report a cost; never silently treat missing usage as free.
    for (const key of ['input_tokens', 'output_tokens']) {
      assert(Number.isSafeInteger(data.usage?.[key]) && data.usage[key] >= 0, 'provider_usage_missing');
    }
    return { answers: data.answers, usage: data.usage, model: data.model,
      latencyMs: performance.now() - start };
  };
}
