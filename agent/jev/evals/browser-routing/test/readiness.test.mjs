import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateReadiness, readinessMetrics, readinessReport, THRESHOLDS } from '../lib/readiness.mjs';

function record(label, split, family, { image = false, security = false } = {}) {
  return {
    decision_id: `dec_${Math.random().toString(16).slice(2)}`,
    label_quality: label,
    split,
    state: { page_class: family },
    human_escalation: { kind: security ? 'security_checkpoint' : 'none' },
    security,
    ...(security ? { label: { target_action: 'escalate_to_human', basis: 'human_clearance' } } : {}),
    dedupe: { role: 'representative' },
    evidence: image ? { screenshot: { sha256: 'x' } } : undefined,
  };
}

test('readiness is false until every gate passes', () => {
  const records = [
    ...Array.from({ length: 26 }, (_, index) => record('VERIFIED_SUCCESSFUL_ACTION', 'test', `family-${index % 11}`)),
    ...Array.from({ length: 45 }, (_, index) => record('VERIFIED_SUCCESSFUL_ACTION', 'train', `family-${index % 11}`)),
    ...Array.from({ length: 101 }, (_, index) => record('FAILED_ACTION', 'train', `family-${index % 11}`)),
  ];
  const metrics = readinessMetrics(records, { leakage: { clean: true } });
  const report = evaluateReadiness(metrics);
  assert.equal(report.ready, false);
  assert.ok(report.blockers.some((blocker) => blocker.gate === 'STRICT_HELDOUT'));
  assert.ok(report.blockers.some((blocker) => blocker.gate === 'HIGH_QUALITY_TRAIN'));
  assert.ok(report.blockers.some((blocker) => blocker.gate === 'SECURITY_EXAMPLES'));
  assert.match(report.exact_next_threshold, /^STRICT_HELDOUT >= 100/);
  assert.deepEqual(THRESHOLDS, { STRICT_HELDOUT: 100, HIGH_QUALITY_TRAIN: 500, PAGE_FAMILIES: 5, SECURITY_EXAMPLES: 1, FAILED_ACTION_NEGATIVES: 25, LEAKAGE: 0 });
});

test('readiness is true only when all thresholds are met', () => {
  const records = [
    ...Array.from({ length: 100 }, (_, index) => record('VERIFIED_SUCCESSFUL_ACTION', 'test', `family-${index % 6}`)),
    ...Array.from({ length: 500 }, (_, index) => record('CURATED_REQUIRED_ACTION', 'train', `family-${index % 6}`)),
    ...Array.from({ length: 25 }, (_, index) => record('FAILED_ACTION', 'train', `family-${index % 6}`)),
    record('VERIFIED_HUMAN_ESCALATION', 'train', 'security.family', { security: true }),
  ];
  const metrics = readinessMetrics(records, { leakage: { clean: true } });
  const report = evaluateReadiness(metrics);
  assert.equal(report.ready, true);
  assert.equal(report.exact_next_threshold, 'NONE — ready to retrain (retraining itself still requires an explicit decision)');
});

test('a detected security state without a verified escalation is not trainable evidence', () => {
  const records = [
    ...Array.from({ length: 100 }, (_, index) => record('VERIFIED_SUCCESSFUL_ACTION', 'test', `family-${index % 6}`)),
    ...Array.from({ length: 500 }, (_, index) => record('CURATED_REQUIRED_ACTION', 'train', `family-${index % 6}`)),
    ...Array.from({ length: 25 }, (_, index) => record('FAILED_ACTION', 'train', `family-${index % 6}`)),
    record('AMBIGUOUS', 'train', 'router.checkpoint:human_verification_required', { security: true }),
  ];
  const metrics = readinessMetrics(records, { leakage: { clean: true } });
  assert.equal(metrics.SECURITY_EXAMPLES, 0);
  assert.equal(metrics.SECURITY_STATES_DETECTED, 1);
});

test('leakage blocks readiness and is reported first', () => {
  const records = Array.from({ length: 700 }, (_, index) => record('VERIFIED_SUCCESSFUL_ACTION', index < 100 ? 'test' : 'train', `family-${index % 6}`));
  const report = evaluateReadiness(readinessMetrics(records, { leakage: { clean: false } }));
  assert.equal(report.ready, false);
  assert.equal(report.exact_next_threshold.startsWith('LEAKAGE'), true);
});

test('readiness report prints the exact required fields', () => {
  const records = [record('VERIFIED_SUCCESSFUL_ACTION', 'test', 'f1')];
  const { lines } = readinessReport(readinessMetrics(records, { leakage: { clean: true } }));
  for (const field of ['TOTAL_DECISIONS', 'HIGH_QUALITY_TRAIN', 'STRICT_HELDOUT', 'PAGE_FAMILIES', 'SECURITY_EXAMPLES', 'FAILED_ACTION_NEGATIVES', 'NEAR_DUPLICATES_REMOVED', 'READY_TO_RETRAIN']) {
    assert.ok(lines.some((line) => line.startsWith(`${field}=`)), field);
  }
  assert.ok(lines.includes('READY_TO_RETRAIN=false'));
});
