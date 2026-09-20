import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { buildRequest, validateAnswer, callChoice, ENDPOINT } from '../src/choice.mjs';
import { summarize, percentile } from '../src/metrics.mjs';

const dataset = JSON.parse(await fs.readFile(new URL('../fixtures/cases.json', import.meta.url), 'utf8'));
const original = dataset.cases.find(c => c.id === 'original-fish-video');
function response(body, choice = 'none', confidence = 0.9) {
  return { model: 'jev-latest', answers: { action: { type: 'choice', choice, confidence,
    probabilities: Object.fromEntries(Object.keys(body.questions.action.criteria).map(k => [k, k === choice ? 1 : 0])),
  } }, usage: { input_tokens: 250, output_tokens: 12 } };
}

test('all fixtures build valid closed choices without leaking expected labels', () => {
  for (const fixture of dataset.cases) {
    const { body } = buildRequest(fixture);
    assert.ok(Object.hasOwn(body.questions.action.criteria, fixture.expected));
    assert.equal(body.model, 'jev-latest');
    assert.equal(body.questions.action.type, 'choice');
    assert.ok(Object.values(body.questions.action.criteria).every(v => typeof v === 'string'));
    assert.equal(Object.hasOwn(body, 'expected'), false);
    assert.equal(Object.hasOwn(body.state, 'expected'), false);
    assert.equal(Object.hasOwn(body.state, 'rationale'), false);
    assert.ok(body.state.candidates.every(c => !Object.hasOwn(c, 'permitted')));
  }
});
test('policy exclusions produce no model candidates and require no API call', () => {
  const { body, localOnly } = buildRequest(dataset.cases.find(c => c.id === 'all-candidates-policy-blocked'));
  assert.equal(localOnly, true);
  assert.deepEqual(Object.keys(body.questions.action.criteria), ['none']);
});
test('duplicate IDs, reserved ID, stale observation, and missing policy fail before transport', () => {
  for (const [mutate, code] of [
    [c => c.state.candidates.push(structuredClone(c.state.candidates[0])), 'duplicate_candidate_id'],
    [c => c.state.candidates[0].id = 'none', 'invalid_candidate_id'],
    [c => c.state.candidates[0].observation = 'old', 'stale_candidate'],
    [c => delete c.state.candidates[0].permitted, 'missing_policy_decision'],
  ]) {
    const fixture = structuredClone(original); mutate(fixture);
    assert.throws(() => buildRequest(fixture), { code });
  }
});
test('choice limit includes none and request size is checked in UTF-8 bytes', () => {
  const fixture = structuredClone(original);
  fixture.state.candidates = Array.from({ length: 255 }, (_, i) => ({ ...fixture.state.candidates[0], id: `id_${i}` }));
  assert.throws(() => buildRequest(fixture), { code: 'too_many_choices' });
  fixture.state.candidates = fixture.state.candidates.slice(0, 1);
  fixture.state.context = '💚'.repeat(10000);
  assert.throws(() => buildRequest(fixture), { code: 'request_too_large' });
});
test('valid response retains distribution, usage and unthresholded choice', () => {
  const { body } = buildRequest(original);
  const parsed = validateAnswer(response(body, original.expected, 0.4), body);
  assert.equal(parsed.choice, original.expected);
  assert.equal(parsed.confidence, 0.4);
  assert.equal(parsed.chosenProbability, 1);
  assert.deepEqual(parsed.usage, { input_tokens: 250, output_tokens: 12 });
});
test('response rejects unknown choices, malformed confidence, distribution and token usage', () => {
  const { body } = buildRequest(original);
  for (const [mutate, code] of [
    [r => r.answers.action.choice = 'invented', 'invalid_choice'],
    [r => r.answers.action.confidence = 1.01, 'invalid_confidence'],
    [r => delete r.answers.action.probabilities, 'missing_probabilities'],
    [r => r.answers.action.probabilities.extra = 0, 'probability_keys_mismatch'],
    [r => r.answers.action.probabilities.none = -1, 'invalid_probability'],
    [r => r.answers.action.probabilities.none = 0.5, 'probabilities_not_normalized'],
    [r => r.usage.input_tokens = -1, 'invalid_usage'],
    [r => delete r.model, 'invalid_response_model'],
  ]) {
    const r = response(body); mutate(r);
    assert.throws(() => validateAnswer(r, body), { code });
  }
});
test('mock transport uses official endpoint and no optional signal is required', async () => {
  const { body } = buildRequest(original);
  let calls = 0;
  const result = await callChoice(body, { apiKey: 'mock-test-key', fetchImpl: async (url, options) => {
    calls++; assert.equal(url, ENDPOINT); assert.equal(options.redirect, 'error');
    assert.equal(options.headers.Authorization, 'Bearer mock-test-key');
    assert.ok(options.signal instanceof AbortSignal);
    assert.deepEqual(JSON.parse(options.body), body);
    return new Response(JSON.stringify(response(body)), { status: 200 });
  } });
  assert.equal(calls, 1); assert.ok(Number.isFinite(result.latencyMs));
});
test('no configured key makes zero calls; rate limits are not automatically retried', async () => {
  const { body } = buildRequest(original);
  let calls = 0;
  const fetchImpl = async () => { calls++; return new Response('provider detail is not logged', { status: 429 }); };
  await assert.rejects(callChoice(body, { fetchImpl }), { code: 'missing_typesafe_key' });
  assert.equal(calls, 0);
  await assert.rejects(callChoice(body, { apiKey: 'mock', fetchImpl }), { code: 'typesafe_http_429' });
  assert.equal(calls, 1);
});
test('mock timeout and invalid JSON are distinct safe failure codes', async () => {
  const { body } = buildRequest(original);
  await assert.rejects(callChoice(body, { apiKey: 'mock', fetchImpl: async () => { throw new DOMException('private network info', 'TimeoutError'); } }), { code: 'timeout_or_aborted' });
  await assert.rejects(callChoice(body, { apiKey: 'mock', fetchImpl: async () => new Response('invalid') }), { code: 'invalid_response_json' });
});
test('offline reports never invent latency, confidence, usage or model accuracy', () => {
  const report = summarize([{ mode: 'offline-contract', status: 'validated' }]);
  assert.equal(report.liveRequests, 0); assert.equal(report.rawAccuracy, null);
  assert.equal(report.latencyMs.p50, null); assert.equal(report.latencyMs.p95, null);
  assert.equal(report.confidence, null); assert.equal(report.usage, null);
});
test('real-run metric aggregation separates failures, abstention, confidence and usage', () => {
  const sample = [
    { mode: 'live', status: 'ok', choice: 'a', expected: 'a', confidence: 0.9, latencyMs: 100, usage: { input_tokens: 10, output_tokens: 2 } },
    { mode: 'live', status: 'ok', choice: 'b', expected: 'none', confidence: 0.5, latencyMs: 200, usage: { input_tokens: 20, output_tokens: 2 } },
    { mode: 'live', status: 'failed', failure: 'typesafe_http_429', latencyMs: 300 },
  ];
  const report = summarize(sample);
  assert.equal(report.liveRequests, 3); assert.equal(report.rawAccuracy, 0.5);
  assert.equal(report.endToEndAccuracy, 1 / 3); assert.equal(report.thresholdedAccuracy, 2 / 3);
  assert.equal(report.coverage, 1 / 3); assert.equal(report.acceptedAccuracy, 1);
  assert.equal(report.latencyMs.p50, 200); assert.equal(report.latencyMs.p95, 300);
  assert.equal(report.usage.input_tokens, 30); assert.equal(report.usage.unknownResponses, 1);
  assert.equal(percentile([], 0.95), null);
});
