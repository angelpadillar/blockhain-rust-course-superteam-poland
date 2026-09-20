// The injected decider: one Jev request per step, ledgered. Answers are
// returned raw (choices + probabilities + confidence); the runtime resolves
// and gates them. Missing usage is never treated as free.
import { createJev } from '../../src/jev.mjs';
import { createLedger, ProviderError } from '../browser-runtime-v3/providers.mjs';

const modelName = value => typeof value === 'string' && /^[a-zA-Z0-9_./:-]{1,160}$/.test(value) ? value : 'unknown';
const integer = value => Number.isSafeInteger(value) && value >= 0;

export function createJevDecider({ apiKey, model = 'jev-latest', ledger = createLedger(), fetchImpl = fetch } = {}) {
  const decide = createJev({ apiKey, model, fetchImpl });
  return async function step(request, signal) {
    const call = await ledger.begin({ provider: 'typesafe', model, purpose: 'choose' });
    const started = performance.now();
    let recorded = false;
    try {
      const data = await decide({ state: request.state, questions: request.questions }, signal || AbortSignal.timeout(15000));
      recorded = true;
      const usageComplete = integer(data.usage?.input_tokens) && integer(data.usage?.output_tokens);
      await ledger.finish(call, { status: 'response_received', latencyMs: performance.now() - started,
        actualModel: modelName(data.model), usageComplete,
        inputTokens: usageComplete ? data.usage.input_tokens : null,
        outputTokens: usageComplete ? data.usage.output_tokens : null,
        costUsd: usageComplete ? data.usage.input_tokens * 0.042 / 1e6 : null, costBasis: 'estimated' });
      if (!usageComplete) throw new ProviderError('provider_usage_missing');
      return data.answers;
    } catch (error) {
      if (!recorded) await ledger.finish(call, { status: 'failed', latencyMs: performance.now() - started,
        reason: error.code || 'provider_error', usageComplete: false, costUsd: null });
      throw error;
    }
  };
}
