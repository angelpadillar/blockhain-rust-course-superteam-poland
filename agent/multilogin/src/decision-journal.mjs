import { appendFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';

// Passive decision journal. Observation/logging only: every method is
// best-effort and can never throw into the browser path. Records follow the
// flywheel's `buena.browser-decision.record/1` shape so the Mac-side ingester
// (agent/jev/evals/browser-routing) can consume them.
//
// Hard rules:
//   - no credentials, cookies, tokens, proxy secrets or webhook URLs (dropped);
//   - no page text: callers pass state classes and tool names, not page content;
//   - a security checkpoint may only target `escalate_security_checkpoint`, and
//     only after a human cleared it and the post-clear state verified;
//   - a failed write disables the journal and increments `failures`; execution
//     is never affected.

export const decisionJournalName = 'decision-journal.ndjson';
export const journalSchema = 'buena.browser-decision.record/1';

const FORBIDDEN_KEY = /(password|passwd|secret|api[_-]?key|apikey|access[_-]?token|refresh[_-]?token|id[_-]?token|bearer|cookie|authorization|auth[_-]?header|webhook|session[_-]?token|private[_-]?key|proxy[_-]?(url|user|pass|password|credential|auth))/i;
const FORBIDDEN_VALUE = [
  /https?:\/\/(?:canary\.)?discord(?:app)?\.com\/api\/webhooks\//i,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/i,
  /\bop:\/\/[A-Za-z0-9/_-]+/i,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/,
  /[a-z]{3,8}:\/\/[^/@\s]+:[^/@\s]+@/i,
];

export function sanitizeForJournal(value, counters = { dropped: 0 }) {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') {
    for (const pattern of FORBIDDEN_VALUE) if (pattern.test(value)) { counters.dropped += 1; return '[redacted]'; }
    return value;
  }
  if (Array.isArray(value)) return value.map(item => sanitizeForJournal(item, counters));
  if (typeof value === 'object') {
    const output = {};
    for (const [key, item] of Object.entries(value)) {
      if (FORBIDDEN_KEY.test(key)) { counters.dropped += 1; continue; }
      output[key] = sanitizeForJournal(item, counters);
    }
    return output;
  }
  return value;
}

export function pseudonymizeProfile(rawProfileId) {
  if (!rawProfileId) return null;
  return `prof_${createHash('sha256').update(`profile:${rawProfileId}`).digest('hex').slice(0, 16)}`;
}

/** High-quality labels require a receipt; otherwise the record stays weak. */
export function labelForOutcome({ phase = 'login', receipt = null } = {}) {
  if (!receipt) return 'AMBIGUOUS';
  const verified = receipt.state === 'verified' && receipt.postconditionMet === true;
  if (verified) return phase === 'jev_recovery' ? 'VERIFIED_RECOVERY_ACTION' : 'VERIFIED_SUCCESSFUL_ACTION';
  if (receipt.state === 'failed') return 'FAILED_ACTION';
  return 'AMBIGUOUS';
}

export function createDecisionJournal({ directory, jobId, platform = null, accountRef = null, profileRef = null,
  now = Date.now, enabled = true } = {}) {
  const path = resolve(directory, decisionJournalName);
  const summary = { decisions: 0, executions: 0, outcomes: 0, checkpoints: 0, cleared: 0,
    failures: 0, droppedFields: 0, disabled: false, lastAt: null };
  let openDecisionId = null;

  const safeWrite = async record => {
    if (!enabled || summary.disabled) return null;
    try {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await appendFile(path, `${JSON.stringify(record)}\n`, { mode: 0o600 });
      summary.lastAt = record.at;
      return record;
    } catch { summary.failures += 1; summary.disabled = true; return null; }
  };
  const base = kind => ({ schema: journalSchema, kind, at: new Date(now()).toISOString(),
    jobId, platform, accountRef, profileId: pseudonymizeProfile(profileRef), executable: false });
  const emit = async record => {
    const counters = { dropped: 0 };
    const sanitized = sanitizeForJournal(record, counters);
    summary.droppedFields += counters.dropped;
    return safeWrite(sanitized);
  };

  return {
    path,
    summary,
    async decision({ phase = 'login', step = null, stateClass = null, candidates = [], chosen = null,
      method = null, confidence = null, probability = null, source = null, topCandidate = null, agreed = null } = {}) {
      const trimmed = candidates.slice(0, 80).map(candidate => ({ id: candidate.id ?? null, tool: candidate.tool ?? null,
        risk: candidate.risk ?? null }));
      openDecisionId = `dec_${createHash('sha256').update(`${jobId}|${step}|${now()}`).digest('hex').slice(0, 20)}`;
      const record = await emit({ ...base('decision'), decisionId: openDecisionId, step, phase, stateClass,
        candidates: trimmed, chosen: { id: chosen?.id ?? null, tool: chosen?.tool ?? null, method, confidence, probability },
        recommendations: {
          deterministic: topCandidate ? { top1: topCandidate, agreed } : null,
          jev: source === 'jev' && (chosen?.tool || chosen?.id) ? { top1: chosen.tool ?? chosen.id, confidence } : null,
          valen: null,
        }, source, executionChanged: false });
      if (record) summary.decisions += 1;
      return record;
    },
    async execution({ phase = 'login', action = null, actionKind = null, risk = null, decisionSource = null, result = null } = {}) {
      const record = await emit({ ...base('execution'), decisionId: openDecisionId, phase, action, actionKind, risk, decisionSource,
        executed: { action, result } });
      if (record) summary.executions += 1;
      return record;
    },
    async outcome({ phase = 'login', action = null, succeeded = null, receipt = null, recovery = null } = {}) {
      const labelQuality = labelForOutcome({ phase, receipt });
      const highQuality = labelQuality.startsWith('VERIFIED_');
      const record = await emit({ ...base('outcome'), decisionId: openDecisionId, phase, executed: { action },
        outcome: { status: highQuality ? 'success' : receipt?.state === 'failed' ? 'failure' : 'unknown',
          verified: labelQuality === 'VERIFIED_SUCCESSFUL_ACTION' || labelQuality === 'VERIFIED_RECOVERY_ACTION',
          succeeded: succeeded === null ? null : succeeded === true, evidence: receipt ? `receipt ${receipt.state}` : null },
        recovery: recovery ? { is_recovery: true, reason: recovery } : { is_recovery: phase === 'jev_recovery', reason: recovery },
        label_quality: labelQuality,
        ...(highQuality ? { label: { target_action: action, basis: 'receipt', evidence_refs: [] } } : {}),
        ...(highQuality ? {} : { attempted_action: action }) });
      if (record) summary.outcomes += 1;
      return record;
    },
    /** Strongest evidence: the durable receipt for an executed action. */
    async receipt({ operation = null, state = null, postconditionMet = null, decisionSource = null, phase = 'receipt' } = {}) {
      const labelQuality = labelForOutcome({ phase, receipt: { state, postconditionMet } });
      const highQuality = labelQuality.startsWith('VERIFIED_');
      const record = await emit({ ...base('receipt'), decisionId: openDecisionId, phase, operation,
        receipt: { state, postconditionMet }, decisionSource, label_quality: labelQuality,
        outcome: { status: highQuality ? 'success' : state === 'failed' ? 'failure' : 'unknown',
          verified: highQuality, evidence: `receipt ${state}` },
        ...(highQuality ? { label: { target_action: operation, basis: 'receipt', evidence_refs: [] } } : {}),
        ...(highQuality ? {} : { attempted_action: operation }) });
      if (record) summary.outcomes += 1;
      return record;
    },
    /** Pending checkpoint: recorded, but NOT labelled until a human clears it. */
    async checkpointPending({ reason = null, phase = 'human_checkpoint', stateClass = null, bundle = null } = {}) {
      const record = await emit({ ...base('human_checkpoint'), decisionId: openDecisionId, phase, reason, stateClass,
        human_escalation: { kind: 'security_checkpoint', target_action: 'escalate_security_checkpoint', reason,
          raised_at: new Date(now()).toISOString(), cleared_at: null, post_clear_verification: null },
        bundle: bundle ? { canonical: bundle.canonical ?? null, region: bundle.region ?? null, context: bundle.context ?? null } : null,
        label_quality: 'AMBIGUOUS', attempted_action: 'escalate_security_checkpoint' });
      if (record) summary.checkpoints += 1;
      return record;
    },
    /** Cleared checkpoint: the only security label ever emitted. */
    async checkpointCleared({ reason = null, clearedAt = null, postClearVerified = false, phase = 'human_checkpoint' } = {}) {
      if (postClearVerified !== true) return null;
      const record = await emit({ ...base('human_checkpoint_cleared'), decisionId: openDecisionId, phase, reason,
        human_escalation: { kind: 'security_checkpoint', target_action: 'escalate_security_checkpoint', reason,
          raised_at: null, cleared_at: clearedAt ?? new Date(now()).toISOString(), post_clear_verification: { status: 'verified' } },
        label_quality: 'VERIFIED_HUMAN_ESCALATION',
        label: { target_action: 'escalate_security_checkpoint', basis: 'human_clearance', evidence_refs: [] } });
      if (record) summary.cleared += 1;
      return record;
    },
  };
}
