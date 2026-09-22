import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFireworksVision, interpretDecision, frontierInput, loadSecret, l3Triggers,
  decisionToolSchema, defaultFireworksSecretPath, createViewportCapture } from '../src/frontier.mjs';
import { createFrontierLedger, summarizeFrontierMetrics } from '../src/frontier-ledger.mjs';
import { loadPricing, mapUsage, estimatedUsd, defaultPricing } from '../src/pricing.mjs';
import { createAdvisorChain, createFrontierVisionAdvisor, createJevAdvisor } from '../src/advisor.mjs';

const OBSERVATION = { epoch: 'epoch-7', url: { origin: 'https://www.youtube.com', pathname: '/' },
  text: 'Recommended videos 12:04', controls: [
    { id: 'e0', role: 'button', name: 'Account menu', enabled: true },
    { id: 'e1', role: 'link', name: 'Skip', enabled: true }] };
const ACTIONS = [{ id: 'a0', description: 'open_account_menu', kind: 'click' },
  { id: 'a1', description: 'dismiss_onboarding', kind: 'dismiss' }];
const screenshot = { base64: 'cG5n', width: 1280, height: 720, bytes: 3, name: 'shot.png' };

function payload(toolArguments, { usage = null, id = 'req-1' } = {}) {
  return { id, model: 'fixture', usage,
    choices: [{ message: { tool_calls: [{ function: { name: 'report_decision', arguments: toolArguments } }] } }] };
}
function responder(body, { status = 200 } = {}) {
  const calls = [];
  return { calls, fetchImpl: async (url, options) => {
    calls.push({ url, headers: options.headers, body: JSON.parse(options.body) });
    return { ok: status >= 200 && status < 300, status, json: async () => body };
  } };
}
async function secretFile(t, value = 'fw_fixture_key_value') {
  const directory = await mkdtemp(join(tmpdir(), 'frontier-secret-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'fireworks-api-key');
  await writeFile(path, `${value}\n`, { mode: 0o600 });
  return path;
}

test('the secret is read from a private file and never falls back to an env var', async t => {
  const path = await secretFile(t);
  const good = await loadSecret(path);
  assert.equal(good.ok, true);
  assert.equal(good.value, 'fw_fixture_key_value');
  const missing = join(path, '..', 'missing-key');
  assert.equal((await loadSecret(missing)).code, 'secret_missing');
  const loose = join(path, '..', 'loose-key');
  await writeFile(loose, 'x\n', { mode: 0o644 });
  assert.equal((await loadSecret(loose)).code, 'secret_not_private');
  const empty = join(path, '..', 'empty-key');
  await writeFile(empty, '\n', { mode: 0o600 });
  assert.equal((await loadSecret(empty)).code, 'secret_empty');
});

test('no secret means L3 fails closed with frontier_unavailable (L1/L2 keep working)', async t => {
  const vision = createFireworksVision({ secretPath: '/nonexistent/fireworks-api-key' });
  assert.equal(await vision.available(), false);
  assert.deepEqual(await vision.diagnostics(),
    { frontier: 'unavailable', code: 'secret_missing', secretPath: '/nonexistent/fireworks-api-key',
      model: 'accounts/fireworks/models/deepseek-v4p1-flash' });

  const frontier = createFrontierVisionAdvisor({ vision });
  const chain = createAdvisorChain({ frontier });
  const error = await chain({ page: {}, actions: ACTIONS, observation: OBSERVATION })
    .then(() => null, thrown => thrown);
  assert.equal(error.code, 'no_advisor_decision');
  // L1 is untouched: one permitted action still decides without any advisor.
  const single = await chain({ page: {}, actions: [ACTIONS[0]], observation: OBSERVATION });
  assert.equal(single.method, 'exact-single-match');
});

test('the frontier returns a permitted action and the request carries only sanitized input', async t => {
  const path = await secretFile(t);
  const { calls, fetchImpl } = responder(payload(JSON.stringify({ decision: 'action', actionId: 'a1',
    confidence: 0.82, reason: 'the Skip control is visible' }),
  { usage: { prompt_tokens: 1200, completion_tokens: 40, total_tokens: 1240,
    prompt_tokens_details: { cached_tokens: 200 } } }));
  const ledger = { recorded: [], async record(metric) { this.recorded.push(metric); } };
  const vision = createFireworksVision({ secretPath: path, fetchImpl, ledger, capture: async () => screenshot });

  const decision = await vision.decide({ goal: 'verify identity', operation: 'dismiss_onboarding',
    observation: OBSERVATION, permittedActions: ACTIONS, trigger: 'visual_only_ui',
    screenshot: await vision.capture({ observation: OBSERVATION }) });

  assert.equal(decision.actionId, 'a1');
  assert.equal(decision.confidence, 0.82);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].headers.Authorization, 'Bearer fw_fixture_key_value');
  assert.equal(calls[0].body.model, 'accounts/fireworks/models/deepseek-v4p1-flash');
  // Structured output is enforced with a tool schema whose actionId is an enum.
  const schema = calls[0].body.tools[0].function.parameters.properties.actionId;
  assert.deepEqual(schema.enum, ['a0', 'a1']);
  assert.deepEqual(calls[0].body.tool_choice.function.name, 'report_decision');
  const content = calls[0].body.messages[0].content;
  assert.equal(content[1].image_url.url.startsWith('data:image/png;base64,'), true);
  assert.equal(content[0].text.includes('epoch-7'), true);
  assert.equal(content[0].text.includes('fw_fixture'), false);

  // Usage came from the provider and was priced with the configured rates.
  const metric = ledger.recorded[0];
  assert.equal(metric.usageSource, 'provider');
  assert.equal(metric.uncachedInputTokens, 1000, 'cached input is separated from uncached');
  assert.equal(metric.cachedInputTokens, 200);
  assert.equal(metric.outputTokens, 40);
  assert.equal(metric.estimatedUsd, estimatedUsd({ uncachedInputTokens: 1000, cachedInputTokens: 200,
    outputTokens: 40 }, defaultPricing));
  assert.equal(metric.policy, 'accepted');
  assert.equal(metric.requestId, 'req-1');
  assert.equal(metric.imageWidth, 1280);
  assert.equal(JSON.stringify(metric).includes('cG5n'), false, 'no image bytes in the ledger');
});

test('the model may abstain or report that a person is required, and nothing else', async t => {
  const path = await secretFile(t);
  const abstain = createFireworksVision({ secretPath: path, capture: async () => screenshot,
    fetchImpl: responder(payload(JSON.stringify({ decision: 'abstain', reason: 'unclear' }))).fetchImpl });
  assert.deepEqual(await abstain.decide({ observation: OBSERVATION, permittedActions: ACTIONS, screenshot }),
    { abstain: true, reason: 'unclear' });

  const human = createFireworksVision({ secretPath: path, capture: async () => screenshot,
    fetchImpl: responder(payload(JSON.stringify({ decision: 'human_verification_required',
      reason: 'recaptcha visible' }))).fetchImpl });
  const decision = await human.decide({ observation: OBSERVATION, permittedActions: ACTIONS, screenshot });
  assert.equal(decision.humanVerificationRequired, true);
  assert.equal(decision.actionId, undefined, 'it classifies the challenge, it never solves it');

  for (const bad of [
    { decision: 'action', actionId: 'a9' },
    { decision: 'action', actionId: 'a0', selector: '#submit' },
    { decision: 'click', actionId: 'a0' },
    { decision: 'action', actionId: 'a0', script: 'document.forms[0].submit()' },
    { decision: 'action', actionId: 'a0', url: 'https://evil.example' },
  ]) {
    assert.throws(() => interpretDecision({ payload: payload(JSON.stringify(bad)), permittedIds: ['a0', 'a1'] }),
      /frontier_(invalid_decision|action_not_permitted)/, JSON.stringify(bad));
  }
  assert.deepEqual(Object.keys(decisionToolSchema(['a0']).function.parameters.properties).sort(),
    ['actionId', 'confidence', 'decision', 'reason']);
});

test('the sanitized input excludes anything that is not reachable state', () => {
  const input = frontierInput({ goal: 'g', operation: 'o',
    observation: { ...OBSERVATION, text: 'x'.repeat(9000) },
    permittedActions: ACTIONS, recentActions: [{ action: 'open_account_menu', result: 'page_changed' }],
    trigger: 'stale_rerender' });
  assert.equal(input.visibleText.length, 4000);
  assert.equal(input.origin, 'https://www.youtube.com');
  assert.equal(input.observationEpoch, 'epoch-7');
  assert.deepEqual(input.controls.map(control => control.id), ['e0', 'e1']);
  assert.deepEqual(input.permittedActions.map(action => action.id), ['a0', 'a1']);
  assert.deepEqual(input.recentActions, [{ action: 'open_account_menu', result: 'page_changed' }]);
  assert.deepEqual(Object.keys(input).sort(), ['controls', 'goal', 'observationEpoch', 'operation', 'origin',
    'pathname', 'permittedActions', 'recentActions', 'trigger', 'visibleText'].sort());
});

test('L3 runs only for its triggers, and a frontier human signal becomes L4', async t => {
  const path = await secretFile(t);
  const vision = createFireworksVision({ secretPath: path, capture: async () => screenshot,
    fetchImpl: responder(payload(JSON.stringify({ decision: 'action', actionId: 'a0',
      confidence: 0.9 }))).fetchImpl });
  const frontier = createFrontierVisionAdvisor({ vision });

  // A trigger that may not escalate is refused before any screenshot.
  const refused = await createAdvisorChain({ frontier, l3Triggers })({ page: {}, actions: ACTIONS,
    observation: OBSERVATION, trigger: 'something_else' }).then(() => null, thrown => thrown);
  assert.equal(refused.code, 'no_advisor_decision');
  assert.equal(frontier.metrics.screenshots, 0, 'no screenshot for a disallowed trigger');

  const allowed = await createAdvisorChain({ frontier, l3Triggers })({ page: {}, actions: ACTIONS,
    observation: OBSERVATION, trigger: 'visual_only_ui' });
  assert.equal(allowed.action.id, 'a0');
  assert.equal(allowed.decisionEpoch, 'epoch-7');
  assert.equal(allowed.screenshot.epoch, 'epoch-7');
  assert.equal(frontier.metrics.screenshots, 1);

  // Jev abstaining is the default trigger; a Jev that cannot answer escalates.
  const jev = createJevAdvisor({ choose: async () => { throw new Error('jev unavailable'); } });
  const escalated = await createAdvisorChain({ jev, frontier, l3Triggers })({ page: {},
    actions: ACTIONS, observation: OBSERVATION });
  assert.equal(escalated.action.id, 'a0');

  // A detected challenge is classified and handed to L4 - never solved.
  const humanFrontier = createFrontierVisionAdvisor({ vision: createFireworksVision({ secretPath: path,
    capture: async () => screenshot, fetchImpl: responder(payload(JSON.stringify({
      decision: 'human_verification_required', reason: 'recaptcha' }))).fetchImpl }) });
  const operator = await createAdvisorChain({ frontier: humanFrontier, l3Triggers })({ page: {},
    actions: ACTIONS, observation: OBSERVATION, trigger: 'visual_only_ui' })
    .then(() => null, thrown => thrown);
  assert.equal(operator.code, 'advisor_requested_operator');
  assert.equal(operator.reason, 'human_verification_required');
});

test('the ledger persists bounded metadata without prompt or image content', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'frontier-ledger-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const ledger = createFrontierLedger({ directory });
  await ledger.record({ at: '2026-09-22T00:00:00.000Z', jobId: 'j1', model: 'm', trigger: 'jev_abstained',
    observationEpoch: 'e1', latencyMs: 900, usageSource: 'provider', uncachedInputTokens: 1000,
    cachedInputTokens: 0, outputTokens: 50, estimatedUsd: 0.000253, decision: 'action',
    chosenAction: 'a0', policy: 'accepted', postconditionSuccess: true, prompt: 'SECRET PAGE TEXT',
    screenshot: { base64: 'cG5n' } });
  const entries = await ledger.entries();
  assert.equal(entries.length, 1);
  assert.equal(entries[0].prompt, undefined, 'prompt contents are never persisted');
  assert.equal(entries[0].screenshot, undefined, 'screenshot bytes are never persisted');
  assert.equal(entries[0].postconditionSuccess, true);
  assert.equal((await readFile(ledger.path, 'utf8')).includes('SECRET PAGE TEXT'), false);
  assert.equal(((await stat(ledger.path)).mode & 0o077) === 0, true, 'the ledger is private');
});

test('pricing is configurable and the summary aggregates what the report needs', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'frontier-pricing-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'frontier-pricing.json');
  await writeFile(path, JSON.stringify({ uncachedInput: 1, cachedInput: 0.1, output: 2,
    effectiveFrom: '2026-10-01', source: 'operator override' }), { mode: 0o600 });
  const { pricing, pricingSource } = await loadPricing({ path });
  assert.equal(pricingSource, 'file');
  assert.equal(pricing.uncachedInput, 1);
  assert.equal(estimatedUsd({ uncachedInputTokens: 1_000_000, cachedInputTokens: 0, outputTokens: 500_000 },
    pricing), 2);

  const { pricing: fallback, pricingSource: source } = await loadPricing({});
  assert.equal(source, 'default');
  assert.deepEqual([fallback.uncachedInput, fallback.cachedInput, fallback.output], [0.22, 0.007, 0.66]);
  assert.equal(fallback.effectiveFrom, '2026-09-22');
  assert.equal(fallback.source.length > 0, true, 'a pricing snapshot carries its source and date');

  // No provider usage means no cost: never estimated from image size.
  assert.deepEqual(mapUsage(null), { available: false, uncachedInputTokens: null, cachedInputTokens: null,
    outputTokens: null, totalTokens: null });
  assert.equal(mapUsage({ prompt_tokens: 100, completion_tokens: 10 }).available, true);

  const summary = summarizeFrontierMetrics([
    { jobId: 'j1', trigger: 'jev_abstained', latencyMs: 100, usageSource: 'provider',
      uncachedInputTokens: 1000, cachedInputTokens: 0, outputTokens: 50, estimatedUsd: 0.0003,
      decision: 'action', policy: 'accepted', postconditionSuccess: true },
    { jobId: 'j1', trigger: 'stale_rerender', latencyMs: 300, usageSource: 'provider',
      uncachedInputTokens: 500, cachedInputTokens: 0, outputTokens: 20, estimatedUsd: 0.0001,
      decision: 'abstain', policy: 'accepted' },
    { jobId: 'j2', trigger: 'no_dom_candidate', latencyMs: 500, usageSource: 'provider',
      uncachedInputTokens: 700, cachedInputTokens: 0, outputTokens: 30, estimatedUsd: 0.0002,
      decision: 'action', policy: 'accepted', postconditionSuccess: false },
  ], { jobs: 2, completedTasks: 2 });
  assert.equal(summary.calls, 3);
  assert.equal(summary.callsPerJob, 1.5);
  assert.equal(summary.estimatedUsdTotal, 0.0006);
  // All frontier spend attributed to the recoveries it actually achieved.
  assert.equal(summary.estimatedUsdPerRecovery, 0.0006, 'cost per successful frontier recovery');
  assert.equal(summary.estimatedUsdPerCompletedTask, 0.0003);
  assert.equal(summary.recoveryRate, 0.5);
  assert.equal(summary.abstainRate, 0.333);
  assert.equal(summary.jobsReachingL3, 2);
  assert.equal(summary.jobsReachingL3Percentage, 1);
  assert.equal(summary.latencyMeanMs, 300);
  assert.equal(summary.latencyP50Ms, 300);
  assert.equal(summary.latencyP95Ms, 500);
  assert.deepEqual(summary.triggers, { jev_abstained: 1, stale_rerender: 1, no_dom_candidate: 1 });
  assert.equal(summary.usageReported, 3);
});

test('the viewport capture takes exactly one image per escalation and marks its epoch', async () => {
  let grabbed = 0;
  const capture = createViewportCapture({ grab: async () => { grabbed++;
    return { base64: 'cG5n', width: 800, height: 600, bytes: 3 }; } });
  const first = await capture({ observation: OBSERVATION });
  assert.equal(grabbed, 1);
  assert.equal(first.index, 1);
  assert.equal(first.epoch, 'epoch-7');
  assert.equal(typeof first.takenAt, 'string');
  assert.equal(defaultFireworksSecretPath, '/opt/buena-multilogin/private/fireworks-api-key');
});
