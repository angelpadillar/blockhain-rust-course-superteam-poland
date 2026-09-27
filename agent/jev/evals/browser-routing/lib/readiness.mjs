/**
 * Retraining gates. Readiness is computed from canonical (deduplicated)
 * decisions and never mutates the registry unless the caller asks.
 */
import { isHighQuality, isSecurityExample, ESCALATION_ACTIONS } from './schema.mjs';

export const THRESHOLDS = {
  STRICT_HELDOUT: 100,
  HIGH_QUALITY_TRAIN: 500,
  PAGE_FAMILIES: 5,
  SECURITY_EXAMPLES: 1,
  FAILED_ACTION_NEGATIVES: 25,
  LEAKAGE: 0,
};

export function readinessMetrics(records, { leakage }) {
  const canonical = records.filter((record) => record.dedupe?.role !== 'near_duplicate');
  const highQuality = canonical.filter((record) => isHighQuality(record.label_quality));
  const train = highQuality.filter((record) => record.split === 'train');
  const test = highQuality.filter((record) => record.split === 'test');
  const families = new Set(train.map((record) => record.state?.page_class).filter(Boolean));
  const allFamilies = new Set(canonical.map((record) => record.state?.page_class).filter(Boolean));
  // A *trainable* security example must be a high-quality record whose target is
  // an escalation: a mere detection (AMBIGUOUS checkpoint observation) is not
  // training evidence.
  const security = canonical.filter((record) =>
    isHighQuality(record.label_quality)
    && ESCALATION_ACTIONS.has(record.label?.target_action)
    && (isSecurityExample(record) || record.label?.basis === 'human_clearance' || record.label_quality === 'VERIFIED_HUMAN_ESCALATION'));
  const securityDetected = canonical.filter((record) => isSecurityExample(record) || record.security === true);
  const failures = canonical.filter((record) => record.label_quality === 'FAILED_ACTION');
  const duplicates = records.filter((record) => record.dedupe?.role === 'near_duplicate').length;
  return {
    TOTAL_DECISIONS: records.length,
    HIGH_QUALITY_TRAIN: train.length,
    STRICT_HELDOUT: test.length,
    PAGE_FAMILIES: families.size,
    PAGE_FAMILIES_ALL: allFamilies.size,
    SECURITY_EXAMPLES: security.length,
    SECURITY_STATES_DETECTED: securityDetected.length,
    FAILED_ACTION_NEGATIVES: failures.length,
    NEAR_DUPLICATES_REMOVED: duplicates,
    leakage_clean: Boolean(leakage?.clean ?? true),
  };
}

export function evaluateReadiness(metrics) {
  const blockers = [];
  const gap = (name, have, need) => (have >= need ? null : { gate: name, have, need, missing: need - have });
  const checks = [
    gap('STRICT_HELDOUT', metrics.STRICT_HELDOUT, THRESHOLDS.STRICT_HELDOUT),
    gap('HIGH_QUALITY_TRAIN', metrics.HIGH_QUALITY_TRAIN, THRESHOLDS.HIGH_QUALITY_TRAIN),
    gap('PAGE_FAMILIES', metrics.PAGE_FAMILIES, THRESHOLDS.PAGE_FAMILIES),
    gap('SECURITY_EXAMPLES', metrics.SECURITY_EXAMPLES, THRESHOLDS.SECURITY_EXAMPLES),
    gap('FAILED_ACTION_NEGATIVES', metrics.FAILED_ACTION_NEGATIVES, THRESHOLDS.FAILED_ACTION_NEGATIVES),
  ];
  for (const check of checks) if (check) blockers.push(check);
  if (!metrics.leakage_clean) blockers.push({ gate: 'LEAKAGE', have: 1, need: 0, missing: 1 });
  // Priority order: hard gates first, then the preferred training-volume gate.
  const priority = ['LEAKAGE', 'STRICT_HELDOUT', 'PAGE_FAMILIES', 'SECURITY_EXAMPLES', 'FAILED_ACTION_NEGATIVES', 'HIGH_QUALITY_TRAIN'];
  const sorted = blockers.slice().sort((a, b) => priority.indexOf(a.gate) - priority.indexOf(b.gate));
  return {
    ready: blockers.length === 0,
    blockers,
    exact_next_threshold: blockers.length
      ? `${sorted[0].gate} >= ${sorted[0].need} (have ${sorted[0].have}; +${sorted[0].missing})`
      : 'NONE — ready to retrain (retraining itself still requires an explicit decision)',
    all_gaps: blockers,
  };
}

export function readinessReport(metrics) {
  const readiness = evaluateReadiness(metrics);
  const lines = [
    `TOTAL_DECISIONS=${metrics.TOTAL_DECISIONS}`,
    `HIGH_QUALITY_TRAIN=${metrics.HIGH_QUALITY_TRAIN}`,
    `STRICT_HELDOUT=${metrics.STRICT_HELDOUT}`,
    `PAGE_FAMILIES=${metrics.PAGE_FAMILIES}`,
    `SECURITY_EXAMPLES=${metrics.SECURITY_EXAMPLES}`,
    `FAILED_ACTION_NEGATIVES=${metrics.FAILED_ACTION_NEGATIVES}`,
    `NEAR_DUPLICATES_REMOVED=${metrics.NEAR_DUPLICATES_REMOVED}`,
    `READY_TO_RETRAIN=${readiness.ready}`,
  ];
  return { lines, readiness };
}
