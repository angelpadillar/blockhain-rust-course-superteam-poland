import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compareRecommendations } from '../lib/compare.mjs';
import { shadowBatch, shadowConfig, shadowScore } from '../lib/shadow.mjs';

function record(id, { target = 'click_a', det = null, jev = null, candidates = null } = {}) {
  return {
    decision_id: id,
    trajectory_id: 'traj',
    candidates: candidates ?? [{ id: 'click_a', description: 'A' }, { id: 'click_b', description: 'B' }, { id: 'escalate_to_human', description: 'Escalate' }],
    state: { text: 'state', normalized: { url: 'https://example.test' } },
    label: { target_action: target },
    label_quality: 'VERIFIED_SUCCESSFUL_ACTION',
    recommendations: { deterministic: det, jev, valen: null },
  };
}

test('shadow config only accepts off|shadow and never enables by default', () => {
  assert.equal(shadowConfig({}).enabled, false);
  assert.equal(shadowConfig({ VALEN_MODE: 'shadow', VALEN_BASE_URL: 'https://valen.test' }).enabled, true);
  assert.throws(() => shadowConfig({ VALEN_MODE: 'execute' }), /unknown VALEN_MODE/);
});

test('shadow score is skipped when off and blocked when no endpoint exists', async () => {
  const off = await shadowScore(record('a'), { config: shadowConfig({}), fetchImpl: () => assert.fail('must not call network when off') });
  assert.equal(off.status, 'off');
  const blocked = await shadowScore(record('b'), { config: shadowConfig({ VALEN_MODE: 'shadow' }) });
  assert.equal(blocked.status, 'blocked');
  assert.match(blocked.reason, /VALEN_BASE_URL/);
});

test('shadow score records probabilities and is never executable', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return new Response(
      JSON.stringify({
        model: 'Valen-Preview-0923',
        choice: 'click_b',
        probabilities: { click_a: 0.2, click_b: 0.7, escalate_to_human: 0.1 },
        confidence: 0.6,
        latency_ms: 650,
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  };
  const result = await shadowScore(record('c'), {
    config: shadowConfig({ VALEN_MODE: 'shadow', VALEN_BASE_URL: 'https://valen.test', VALEN_CHECKPOINT: 'preview' }),
    fetchImpl,
  });
  assert.equal(result.status, 'ok');
  assert.equal(result.recommendation.executable, false);
  assert.equal(result.recommendation.top1, 'click_b');
  assert.deepEqual(result.recommendation.top3, ['click_b', 'click_a', 'escalate_to_human']);
  assert.equal(result.recommendation.latency_ms, 650);
  assert.equal(result.recommendation.action, undefined);
  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.question.type, 'choice');
  assert.deepEqual(Object.keys(body.question.criteria), ['click_a', 'click_b', 'escalate_to_human']);
  assert.equal(body.checkpoint, 'preview');
});

test('shadow batch never mutates inputs and survives endpoint errors', async () => {
  const inputs = [record('d'), record('e', { candidates: [{ id: 'only_one', description: 'One' }] })];
  const { records, summary } = await shadowBatch(inputs, {
    config: shadowConfig({ VALEN_MODE: 'shadow', VALEN_BASE_URL: 'https://valen.test' }),
    fetchImpl: async () => new Response('boom', { status: 500 }),
  });
  assert.equal(inputs[0].recommendations.valen, null);
  assert.equal(records[0].recommendations.valen.status, 'error');
  assert.equal(summary.error, 1);
  assert.equal(summary.off, 1); // single-candidate record adds no information
});

test('comparison computes agreement, recall, latency and escalation metrics', () => {
  const det = (top1) => ({ top1, top3: [top1], confidence: 0.5, latency_ms: 0 });
  const recommendations = [
    record('a', { target: 'click_a', det: det('click_a') }),
    record('b', { target: 'click_b', det: det('escalate_to_human') }),
    record('c', { target: 'escalate_to_human', det: det('click_a'), candidates: [{ id: 'click_a', description: 'A' }, { id: 'escalate_to_human', description: 'E' }] }),
  ];
  recommendations[0].recommendations.valen = { top1: 'click_a', top3: ['click_a', 'click_b'], confidence: 0.9, latency_ms: 700 };
  recommendations[1].recommendations.valen = { top1: 'click_b', top3: ['click_b'], confidence: 0.4, latency_ms: 800 };
  recommendations[2].recommendations.valen = { top1: 'click_a', top3: ['click_a'], confidence: 0.3, latency_ms: 900 };
  const report = compareRecommendations(recommendations);
  assert.equal(report.deterministic.records_scored, 3);
  assert.equal(report.deterministic.top1_agreement, 1 / 3);
  assert.equal(report.deterministic.false_human_escalation_count, 1);
  assert.equal(report.deterministic.missed_human_escalation_count, 1);
  assert.equal(report.valen.top1_agreement, 2 / 3);
  assert.equal(report.valen.latency_p50_ms, 800);
  assert.equal(report.agreement.deterministic_vs_valen_top1, 2 / 3);
});
