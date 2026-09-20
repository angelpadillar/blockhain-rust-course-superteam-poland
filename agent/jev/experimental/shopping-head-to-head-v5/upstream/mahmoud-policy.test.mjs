import test from 'node:test';
import assert from 'node:assert/strict';
import { createMahmoudPolicy, normalizeObservation, mapUpstreamAction, validateProposal } from './mahmoud-policy.mjs';
import { createLedger } from '../../browser-runtime-v3/providers.mjs';

const observation = { title: 'Fixture', url: 'http://fixture.invalid/', text: 'Choose a shop',
  elements: [{ ref: 'e1', tag: 'input', role: 'searchbox', label: 'Search', bbox: [1, 2, 50, 20], value: '' },
    { ref: 'e2', tag: 'button', role: 'button', label: 'Add', bbox: [1, 30, 50, 20] }] };
const task = { goal: 'Find "Paper Shop".', texts: ['Paper Shop', '1', '2', '3'], expectedUrl: 'SECRET_ANSWER' };
function envelope({ action = 'type', target = 'e1', pair = 'e1|t0', confidence = .99, done = .01 } = {}) {
  const choice = value => ({ type: 'choice', choice: value, confidence, probabilities: { [value]: 1 } });
  return { model: 'jev-1.13.0', usage: { input_tokens: 100, output_tokens: 20 }, answers: {
    action: choice(action), element: choice(target), type_target: choice(pair), key: choice('Enter'),
    goal_achieved: { type: 'noul', noul: done },
  } };
}
function setup(responses) {
  const requests = [], events = [];
  const ledger = createLedger({ maxCalls: 4, onEvent: async event => { events.push(event); } });
  const choose = createMahmoudPolicy({ apiKey: 'test-not-a-real-key', ledger, fetchImpl: async (url, options) => {
    assert.equal(events.at(-1).type, 'model_planned');
    requests.push(JSON.parse(options.body));
    const value = responses.shift();
    if (value instanceof Error) throw value;
    return new Response(JSON.stringify(value), { status: 200 });
  } });
  return { choose, requests, ledger, events };
}

test('unchanged upstream joint choice proposes literal fill without executing', async () => {
  const { choose, ledger, requests } = setup([envelope()]);
  const result = await choose({ observation, task, history: [{ outcome: 'opened', expectedUrl: 'SECRET_HISTORY' }] });
  assert.equal(result.status, 'action');
  assert.deepEqual(result.action, { type: 'fill', ref: 'e1', text: 'Paper Shop' });
  assert.equal(result.independentlyVerified, false);
  assert.equal(ledger.summary().modelCalls, 1);
  assert.ok(Math.abs(ledger.summary().costUsd - .0000042) < 1e-15);
  assert.equal(JSON.stringify(requests).includes('SECRET'), false);
});

test('original corrective retry executes twice and remains accounted', async () => {
  const { choose, ledger, requests } = setup([envelope({ confidence: .1 }), envelope()]);
  const result = await choose({ observation, task });
  assert.equal(result.status, 'action');
  assert.equal(result.upstream.retried, true);
  assert.equal(ledger.summary().modelCalls, 2);
  assert.match(requests[1].questions.action.instructions, /IMPORTANT/);
});

test('model DONE is a proposal, never independently verified success', async () => {
  const { choose } = setup([envelope({ action: 'done', done: .99 })]);
  const result = await choose({ observation, task });
  assert.equal(result.status, 'done');
  assert.equal(result.independentlyVerified, false);
  assert.equal(result.action, null);
});

test('unsupported upstream scroll is retained and rejected, not substituted', async () => {
  const { choose } = setup([envelope({ action: 'scroll_down' })]);
  const result = await choose({ observation, task });
  assert.equal(result.reason, 'unsupported_action');
  assert.deepEqual(result.action, { type: 'scroll', direction: 'down' });
});

test('network failure leaves unknown cost and stops next dispatch', async () => {
  const { choose, ledger, requests } = setup([new Error('private credential detail')]);
  await assert.rejects(choose({ observation, task }), /provider_network_error/);
  assert.equal(ledger.summary().costUsd, null);
  await assert.rejects(choose({ observation, task }), /previous_usage_incomplete/);
  assert.equal(requests.length, 1);
  assert.equal(JSON.stringify(ledger.summary()).includes('private credential'), false);
});

test('response usage recorded even if upstream answer shape is invalid', async () => {
  const { choose, ledger } = setup([{ model: 'jev-1.13.0', usage: { input_tokens: 100, output_tokens: 20 }, answers: {} }]);
  await assert.rejects(choose({ observation, task }));
  assert.equal(ledger.summary().costComplete, true);
  assert.ok(Math.abs(ledger.summary().costUsd - .0000042) < 1e-15);
});

test('missing response usage is unknown and pre-abort sends no request', async () => {
  const { choose, ledger, requests } = setup([{ ...envelope(), usage: {} }]);
  await assert.rejects(choose({ observation, task, signal: AbortSignal.abort() }), /cancelled/);
  assert.equal(requests.length, 0);
  await assert.rejects(choose({ observation, task }), /provider_usage_missing/);
  assert.equal(ledger.summary().costComplete, false);
});

test('boundary rejects invented refs and literal values; no hidden snapshot fields copied', () => {
  assert.equal(normalizeObservation({ ...observation, secret: 'hidden' }).secret, undefined);
  assert.equal(validateProposal({ type: 'fill', ref: 'e1', text: 'invented' }, observation, task.texts).ok, false);
  assert.equal(validateProposal({ type: 'click', ref: 'e99' }, observation, task.texts).reason, 'unobserved_reference');
  assert.deepEqual(mapUpstreamAction({ type: 'press_key', key: 'Enter' }), { type: 'press', key: 'Enter' });
});
