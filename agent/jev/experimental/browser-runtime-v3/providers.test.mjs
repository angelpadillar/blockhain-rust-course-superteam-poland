import test from 'node:test';
import assert from 'node:assert/strict';
import { createLedger, createOpenRouter, createOpenRouterChooser, createJevChooser } from './providers.mjs';
import { planGoal, validateTask } from './planner.mjs';

const envelope = (content = '{"query":"Maple Desk","targetText":"Maple Desk","context":""}', usage = {}) => ({
  model: 'google/gemini-2.5-flash-lite', provider: 'Google AI Studio',
  choices: [{ finish_reason: 'stop', message: { content } }],
  usage: { prompt_tokens: 250, completion_tokens: 30, cost: 0.000037, ...usage },
});
const ok = body => ({ ok: true, json: async () => body });
const apiKey = 'synthetic-provider-key-for-tests';
const choiceArgs = { kind: 'result', task: { query: 'Maple Desk', targetText: 'Maple Desk', context: 'Office' },
  observation: { title: 'Catalogue', text: 'PRIVATE BODY' },
  candidates: [{ ref: 's1:e4', what: 'Maple Desk', role: 'link', where: ['Office'], secret: 'PRIVATE FIELD' }] };

test('OpenRouter pins official endpoint/provider and logs only accounting while supporting explicit image input', async () => {
  const events = [], ledger = createLedger({ onEvent: e => events.push(e) });
  const complete = createOpenRouter({ apiKey, ledger, fetchImpl: async (url, options) => {
    assert.equal(url, 'https://openrouter.ai/api/v1/chat/completions');
    assert.equal(options.redirect, 'error');
    const body = JSON.parse(options.body);
    assert.deepEqual(body.provider, { only: ['google-ai-studio'], order: ['google-ai-studio'], allow_fallbacks: false, require_parameters: true });
    assert.equal(body.response_format.type, 'json_schema');
    assert.equal(body.messages[1].content[1].type, 'image_url');
    assert(!options.body.includes('PRIVATE'));
    return ok(envelope('{"ref":"s1:e4"}'));
  } });
  const choose = createOpenRouterChooser({ complete, screenshot: async () => Buffer.from('synthetic image bytes') });
  assert.equal(await choose(choiceArgs), 's1:e4');
  assert.equal(ledger.summary().costUsd, 0.000037);
  assert.equal(ledger.summary().screenshotCalls, 1);
  assert(!JSON.stringify(events).includes(apiKey));
  assert(!JSON.stringify(events).includes('synthetic image bytes'));
  assert(!JSON.stringify(events).includes('Maple Desk'));
});

test('invalid model JSON and truncated output retain billed usage before failing', async () => {
  for (const body of [envelope('not JSON'), { ...envelope(), choices: [{ finish_reason: 'length', message: { content: '{}' } }] }]) {
    const ledger = createLedger();
    const complete = createOpenRouter({ apiKey, ledger, fetchImpl: async () => ok(body) });
    await assert.rejects(planGoal({ goal: 'Find a maple desk for my office', complete }));
    assert.equal(ledger.summary().inputTokens, 250);
    assert.equal(ledger.summary().costUsd, 0.000037);
    assert.equal(ledger.summary().usageComplete, true);
  }
});

test('missing cost is unknown and prevents another provider call', async () => {
  let calls = 0;
  const ledger = createLedger();
  const complete = createOpenRouter({ apiKey, ledger, fetchImpl: async () => { calls++; return ok(envelope(undefined, { cost: undefined })); } });
  await assert.rejects(planGoal({ goal: 'Find a maple desk', complete }), /provider_usage_or_cost_missing/);
  assert.equal(ledger.summary().costUsd, null);
  assert.equal(ledger.summary().costComplete, false);
  await assert.rejects(planGoal({ goal: 'Find a maple desk', complete }), /previous_usage_incomplete/);
  assert.equal(calls, 1);
});

test('HTTP failures are sanitized, counted, never retried and never priced as zero', async () => {
  let calls = 0;
  const ledger = createLedger();
  const complete = createOpenRouter({ apiKey, ledger, fetchImpl: async () => { calls++; return { ok: false, status: 429 }; } });
  await assert.rejects(planGoal({ goal: 'Find a maple desk', complete }), /provider_http_429/);
  assert.equal(calls, 1);
  assert.equal(ledger.summary().modelCalls, 1);
  assert.equal(ledger.summary().costUsd, null);
  assert.equal(ledger.summary().usageComplete, false);
});

test('one ledger bounds all planning and selection calls and keeps a crossed cost', async () => {
  const ledger = createLedger({ maxCalls: 1 });
  const complete = createOpenRouter({ apiKey, ledger, fetchImpl: async () => ok(envelope()) });
  await planGoal({ goal: 'Find a maple desk', complete });
  await assert.rejects(createOpenRouterChooser({ complete })(choiceArgs), /model_call_budget/);
  assert.equal(ledger.summary().modelCalls, 1);
  const expensive = createLedger({ maxUsd: 0.00001 });
  const over = createOpenRouter({ apiKey, ledger: expensive, fetchImpl: async () => ok(envelope()) });
  await assert.rejects(planGoal({ goal: 'Find a maple desk', complete: over }), /model_cost_budget/);
  assert.equal(expensive.summary().costUsd, 0.000037);
});

test('an invented ref cannot escape the offered set even when structured output is malformed', async () => {
  const ledger = createLedger();
  const complete = createOpenRouter({ apiKey, ledger, fetchImpl: async () => ok(envelope('{"ref":"https://bad.example"}')) });
  await assert.rejects(createOpenRouterChooser({ complete })(choiceArgs), /invalid_model_reference/);
  assert.equal(ledger.summary().costUsd, 0.000037);
});

test('Jev selection uses only offered public evidence and labels token-derived cost estimated', async () => {
  const ledger = createLedger();
  const choose = createJevChooser({ apiKey, ledger, fetchImpl: async (url, options) => {
    assert.equal(url, 'https://api.typesafe.ai/v1/systemone');
    assert(!options.body.includes('PRIVATE'));
    return ok({ model: 'jev-1.13.0', usage: { input_tokens: 500, output_tokens: 50 },
      answers: { target: { type: 'choice', choice: 's1:e4' } } });
  } });
  assert.equal(await choose(choiceArgs), 's1:e4');
  assert.equal(ledger.summary().costUsd, 0.000021);
  assert.equal(ledger.summary().costBasis, 'includes_estimates');
});

test('task contract rejects verifier fields and literal parser refuses to drop extra constraints', async () => {
  assert.throws(() => validateTask({ query: 'Desk', targetText: 'Desk', expectedUrl: 'http://answer' }), /invalid_search_task/);
  assert.deepEqual(await planGoal({ goal: 'Find "Maple Desk" and open its details.' }), { query: 'Maple Desk', targetText: 'Maple Desk', context: '' });
  await assert.rejects(planGoal({ goal: 'Find "Maple Desk" and open its details. Only under $20.' }), /planner_required/);
  await assert.rejects(planGoal({ goal: 'Buy "Maple Desk" and open it.' }), /planner_required/);
});
