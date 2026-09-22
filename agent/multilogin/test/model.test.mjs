import test from 'node:test';
import assert from 'node:assert/strict';
import { createChooser, createFireworksJev, defaultFireworksModel, providers } from '../src/model.mjs';

const actions = [{ id: 'a0', description: 'Fill the supplied Google email' },
  { id: 'a1', description: 'Click Next' }];
const completion = (content, usage = { prompt_tokens: 19, completion_tokens: 7 }) => ({ ok: true,
  json: async () => ({ model: defaultFireworksModel, usage, choices: [{ message: { content: typeof content === 'string'
    ? content : JSON.stringify(content) } }] }) });

test('the default provider is the existing Jev path and needs its key', () => {
  assert.equal(providers.includes('typesafe') && providers.includes('fireworks'), true);
  assert.throws(() => createChooser({ provider: 'typesafe', environment: {} }), /missing_typesafe_key/);
  assert.throws(() => createChooser({ provider: 'fireworks', apiKey: 'short', environment: {} }), /missing_fireworks_key/);
  assert.throws(() => createChooser({ provider: 'openai', environment: {} }), /unsupported_model_provider/);
});

test('a single permitted action still uses no provider call', async () => {
  const chooser = createChooser({ provider: 'fireworks', apiKey: 'test-fireworks-key', environment: {},
    fetchImpl: async () => { throw new Error('must not be called'); } });
  const result = await chooser({ page: {}, actions: [actions[0]] });
  assert.equal(result.method, 'exact-single-match');
  assert.equal(chooser.metrics.calls, 0);
});

test('the Fireworks boundary uses the prepared model and validates the same choice contract', async () => {
  const bodies = [];
  const chooser = createChooser({ provider: 'fireworks', apiKey: 'test-fireworks-key', environment: {},
    fetchImpl: async (url, options) => { bodies.push({ url, options }); return completion({ choice: 'a1',
      confidence: 0.93, probabilities: { a0: 0.07, a1: 0.93, stop: 0 } }); } });
  const result = await chooser({ page: { text: 'Sign in' }, actions });
  assert.equal(result.action.id, 'a1');
  assert.equal(result.method, 'fireworks-chat-completion');
  assert.equal(result.probability, 0.93);
  const body = JSON.parse(bodies[0].options.body);
  assert.equal(body.model, defaultFireworksModel);
  assert.equal(bodies[0].url, 'https://api.fireworks.ai/inference/v1/chat/completions');
  assert.equal(body.response_format.type, 'json_object');
  assert.equal(body.messages.at(-1).content.includes('stop'), true);
  assert.deepEqual(chooser.metrics, { calls: 1, latencyMs: chooser.metrics.latencyMs, inputTokens: 19,
    outputTokens: 7, usageComplete: true, model: defaultFireworksModel, provider: 'fireworks', exactActions: 0 });
});

test('an alternative provider cannot weaken validation, invent actions or hide usage', async () => {
  for (const [content, usage, expected, usageComplete] of [
    [{ choice: 'a9', confidence: 1, probabilities: { a0: 0, a1: 0, a9: 1, stop: 0 } }, undefined, /jev_unknown_action/, true],
    [{ choice: 'a0', confidence: 0.5, probabilities: { a0: 1, a1: 0, stop: 0 } }, undefined, /jev_uncertain_or_invalid/, true],
    [{ choice: 'a0', confidence: 1, probabilities: { a0: 1, a1: 1, stop: 0 } }, undefined, /jev_invalid_probabilities/, true],
    [{ choice: 'a0', confidence: 1, probabilities: { a0: 1, a1: 0, stop: 0 } }, {}, /jev_usage_unknown/, false],
    ['not json at all', undefined, /invalid_provider_choice/, false],
  ]) {
    const chooser = createChooser({ provider: 'fireworks', apiKey: 'test-fireworks-key', environment: {},
      fetchImpl: async () => completion(content, usage) });
    await assert.rejects(chooser({ page: {}, actions }), expected);
    assert.equal(chooser.metrics.usageComplete, usageComplete, String(expected));
  }
  const stopped = createChooser({ provider: 'fireworks', apiKey: 'test-fireworks-key', environment: {},
    fetchImpl: async () => completion({ choice: 'stop', confidence: 1, probabilities: { a0: 0, a1: 0, stop: 1 } }) });
  await assert.rejects(stopped({ page: {}, actions }), /jev_requested_attention/);
  const failing = createChooser({ provider: 'fireworks', apiKey: 'test-fireworks-key', environment: {},
    fetchImpl: async () => ({ ok: false, status: 503 }) });
  await assert.rejects(failing({ page: {}, actions }), /provider_http_503/);
  const offline = createChooser({ provider: 'fireworks', apiKey: 'test-fireworks-key', environment: {},
    fetchImpl: async () => { throw new Error('socket closed'); } });
  await assert.rejects(offline({ page: {}, actions }), /provider_network_error/);
});

test('the Fireworks key and model come from the environment or explicit options', async () => {
  const chooser = createChooser({ provider: 'fireworks', environment: { FIREWORKS_API_KEY: 'env-fireworks-key',
    FIREWORKS_MODEL: 'accounts/fireworks/models/other' }, fetchImpl: async (url, options) => {
    assert.equal(JSON.parse(options.body).model, 'accounts/fireworks/models/other');
    return completion({ choice: 'a0', confidence: 1, probabilities: { a0: 1, a1: 0, stop: 0 } }); } });
  assert.equal((await chooser({ page: {}, actions })).action.id, 'a0');
  const direct = createFireworksJev({ apiKey: 'test-fireworks-key', fetchImpl: async (url, options) => {
    assert.equal(JSON.parse(options.body).model, defaultFireworksModel);
    return completion({ choice: 'a1', confidence: 1, probabilities: { a0: 0, a1: 1, stop: 0 } }); } });
  assert.equal((await direct({ page: {}, actions })).action.id, 'a1');
});
