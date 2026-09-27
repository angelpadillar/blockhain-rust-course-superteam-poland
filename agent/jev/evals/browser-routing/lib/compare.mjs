/**
 * Shadow comparison: deterministic / JEV / Valen zero-shot against labels.
 * Only records with a labelled target action participate.
 */
import { ESCALATION_ACTIONS, isHighQuality } from './schema.mjs';

const SCORERS = ['deterministic', 'jev', 'valen'];
const SELF_SOURCES = {
  deterministic: new Set(['deterministic', 'scripted', 'curated_policy', 'curated_validator_policy', 'payment_policy']),
  jev: new Set(['jev']),
  valen: new Set(),
};

function percentile(values, p) {
  if (!values.length) return null;
  const sorted = values.slice().sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * p) - 1)];
}

export function compareRecommendations(records) {
  const report = {};
  for (const scorer of SCORERS) {
    // Accuracy is only meaningful against high-quality labels: a FAILED_ACTION
    // records what was attempted, not what was correct.
    const rows = records.filter(
      (record) => isHighQuality(record.label_quality) && record.label?.target_action && record.recommendations?.[scorer]?.top1,
    );
    const n = rows.length;
    const top1 = rows.filter((record) => record.recommendations[scorer].top1 === record.label.target_action);
    const top3 = rows.filter((record) => (record.recommendations[scorer].top3 ?? []).includes(record.label.target_action));
    const confidences = rows.map((record) => record.recommendations[scorer].confidence).filter((value) => typeof value === 'number');
    const latencies = rows.map((record) => record.recommendations[scorer].latency_ms).filter((value) => typeof value === 'number');
    const escalationTargets = rows.filter((record) => ESCALATION_ACTIONS.has(record.label.target_action));
    const falseEscalation = rows.filter((record) => ESCALATION_ACTIONS.has(record.recommendations[scorer].top1) && !ESCALATION_ACTIONS.has(record.label.target_action));
    const missedEscalation = escalationTargets.filter((record) => !ESCALATION_ACTIONS.has(record.recommendations[scorer].top1));
    const selfRecorded = rows.filter((record) => SELF_SOURCES[scorer].has(record.executed?.source));
    const independent = rows.filter((record) => !SELF_SOURCES[scorer].has(record.executed?.source));
    const independentTop1 = independent.filter((record) => record.recommendations[scorer].top1 === record.label.target_action);
    report[scorer] = {
      records_scored: n,
      top1_agreement: n ? top1.length / n : null,
      top3_required_action_recall: n ? top3.length / n : null,
      confidence_mean: confidences.length ? confidences.reduce((sum, value) => sum + value, 0) / confidences.length : null,
      latency_p50_ms: percentile(latencies, 0.5),
      latency_p95_ms: percentile(latencies, 0.95),
      false_human_escalation: n ? falseEscalation.length / n : null,
      false_human_escalation_count: falseEscalation.length,
      missed_human_escalation: escalationTargets.length ? missedEscalation.length / escalationTargets.length : null,
      missed_human_escalation_count: missedEscalation.length,
      escalation_targets: escalationTargets.length,
      self_recorded_count: selfRecorded.length,
      independent_count: independent.length,
      independent_top1_accuracy: independent.length ? independentTop1.length / independent.length : null,
    };
  }
  const overlap = records.filter(
    (record) =>
      isHighQuality(record.label_quality) &&
      record.label?.target_action &&
      record.recommendations?.deterministic?.top1 &&
      record.recommendations?.valen?.top1,
  );
  report.agreement = {
    deterministic_vs_valen_top1: overlap.length ? overlap.filter((record) => record.recommendations.deterministic.top1 === record.recommendations.valen.top1).length / overlap.length : null,
    deterministic_vs_jev_top1: overlap.length
      ? overlap.filter((record) => record.recommendations.deterministic.top1 === record.recommendations.jev?.top1).length / overlap.length
      : null,
    sample: overlap.length,
  };
  return report;
}
