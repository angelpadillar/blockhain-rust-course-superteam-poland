/**
 * Ingester for the live controller's passive decision journal
 * (`<job>/decision-journal.ndjson`, written by src/decision-journal.mjs).
 *
 * The journal is append-only and already in the flywheel record shape; this
 * module groups its lines by decisionId and derives one corpus record per
 * decision, taking the strongest available evidence:
 *
 *   receipt verified + postcondition met -> VERIFIED_SUCCESSFUL_ACTION
 *   receipt verified in a recovery phase -> VERIFIED_RECOVERY_ACTION
 *   receipt failed                        -> FAILED_ACTION
 *   dispatched outcome only               -> OBSERVED_SUCCESSFUL_ACTION
 *   nothing stronger                      -> AMBIGUOUS
 *   human_checkpoint + checkpoint cleared -> VERIFIED_HUMAN_ESCALATION
 *                                           (target escalate_security_checkpoint)
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { guardSecrets, SCHEMA } from './schema.mjs';

export function readJournalLines(path) {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

/** Pure grouping/labelling so it can be tested without filesystem fixtures. */
export function recordsFromJournalLines(lines, { sourceFile = null } = {}) {
  const groups = new Map();
  for (const line of lines) {
    const key = line.decisionId ?? `orphan-${line.at}-${line.kind}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(line);
  }
  const output = [];
  for (const [decisionId, group] of groups) {
    const decision = group.find((line) => line.kind === 'decision') ?? null;
    if (!decision) continue;
    const receipts = group.filter((line) => line.kind === 'receipt');
    const outcomes = group.filter((line) => line.kind === 'outcome');
    const pending = group.find((line) => line.kind === 'human_checkpoint') ?? null;
    const cleared = group.find((line) => line.kind === 'human_checkpoint_cleared') ?? null;

    let labelQuality = 'AMBIGUOUS';
    let targetAction = null;
    let verified = false;
    let evidence = null;
    if (pending) {
      if (cleared) {
        labelQuality = 'VERIFIED_HUMAN_ESCALATION';
        targetAction = 'escalate_security_checkpoint';
        verified = true;
        evidence = `human cleared at ${cleared.human_escalation?.cleared_at ?? cleared.at}`;
      } else {
        labelQuality = 'AMBIGUOUS';
        targetAction = null;
      }
    } else {
      const verifiedReceipt = receipts.find((line) => line.receipt?.state === 'verified' && line.receipt?.postconditionMet === true);
      const failedReceipt = receipts.find((line) => line.receipt?.state === 'failed');
      const outcome = outcomes[outcomes.length - 1] ?? null;
      if (verifiedReceipt) {
        labelQuality = verifiedReceipt.label_quality === 'VERIFIED_RECOVERY_ACTION' || /recovery/i.test(decision.phase ?? '')
          ? 'VERIFIED_RECOVERY_ACTION'
          : 'VERIFIED_SUCCESSFUL_ACTION';
        targetAction = verifiedReceipt.operation ?? decision.chosen?.tool ?? decision.chosen?.id ?? null;
        verified = true;
        evidence = `receipt ${verifiedReceipt.receipt?.state} postconditionMet=${verifiedReceipt.receipt?.postconditionMet}`;
      } else if (failedReceipt) {
        labelQuality = 'FAILED_ACTION';
        targetAction = failedReceipt.operation ?? null;
        evidence = `receipt ${failedReceipt.receipt?.state}`;
      } else if (outcome?.outcome?.status === 'success') {
        labelQuality = 'OBSERVED_SUCCESSFUL_ACTION';
        targetAction = null;
        evidence = 'dispatched outcome';
      } else if (outcome) {
        labelQuality = outcome.outcome?.status === 'failure' ? 'FAILED_ACTION' : 'AMBIGUOUS';
        targetAction = null;
        evidence = `outcome ${outcome.outcome?.status ?? 'unknown'}`;
      }
    }

    const candidates = (decision.candidates ?? []).map((candidate) => ({
      id: candidate.tool ?? candidate.id,
      description: `Journal candidate ${candidate.tool ?? candidate.id}`,
      tool: candidate.tool ?? null,
    }));
    const attempted = decision.chosen?.tool ?? decision.chosen?.id ?? null;
    if (targetAction && !candidates.some((candidate) => candidate.id === targetAction)) {
      candidates.push({ id: targetAction, description: `Journal action ${targetAction}`, tool: targetAction });
    }
    const record = {
      schema: SCHEMA,
      record_id: `journal-${decisionId}`,
      decision_id: `journal_${decisionId}`,
      job_id: decision.jobId ?? 'unknown-job',
      profile_id: decision.profileId ?? null,
      trajectory_id: decision.jobId ?? 'unknown-job',
      step: decision.step ?? 0,
      timestamp: decision.at,
      state: {
        text: `${decision.phase ?? 'login'} phase, state class ${decision.stateClass ?? 'unknown'}.`,
        page_class: `journal.${decision.stateClass ?? 'unknown'}`,
        state_class: decision.stateClass ?? null,
        fingerprint_material: [decision.stateClass ?? '', decision.phase ?? ''],
      },
      candidates,
      chosen: attempted,
      recommendations: {
        deterministic: decision.recommendations?.deterministic ?? null,
        jev: decision.recommendations?.jev ?? null,
        valen: null,
      },
      executed: {
        action: attempted,
        result: evidence,
        source: decision.source ?? null,
      },
      recovery: { is_recovery: decision.phase === 'jev_recovery', reason: null },
      human_escalation: pending
        ? {
            kind: 'security_checkpoint',
            reason: pending.reason ?? null,
            raised_at: pending.human_escalation?.raised_at ?? pending.at ?? null,
            cleared_at: cleared?.human_escalation?.cleared_at ?? cleared?.at ?? null,
            post_clear_verification: cleared ? { status: 'verified' } : null,
          }
        : { kind: 'none', reason: null, raised_at: null, cleared_at: null, post_clear_verification: null },
      outcome: {
        status: labelQuality.startsWith('VERIFIED') ? 'success' : labelQuality === 'FAILED_ACTION' ? 'failure' : 'unknown',
        verified,
        evidence,
      },
      label_quality: labelQuality,
      ...(labelQuality.startsWith('VERIFIED') && targetAction
        ? { label: { target_action: targetAction, basis: pending ? 'human_clearance' : 'receipt', evidence_refs: sourceFile ? [sourceFile] : [] } }
        : {}),
      ...(labelQuality.startsWith('VERIFIED') ? {} : { attempted_action: attempted }),
      security: false,
      provenance: {
        source: 'decision-journal',
        files: sourceFile ? [sourceFile] : [],
        source_commit: null,
      },
      notes: pending ? 'Genuine human checkpoint cleared by a person; the only security label emitted.' : 'Passive live decision journal record.',
    };
    output.push(guardSecrets(record, { redact: true }).value);
  }
  return output;
}

export function ingestDecisionJournals(browserRepo) {
  const records = [];
  if (!browserRepo || !existsSync(browserRepo)) return records;
  const jobsRoot = join(browserRepo, '.browser-jobs');
  if (!existsSync(jobsRoot)) return records;
  const walk = (dir, depth = 4) => {
    if (depth < 0 || !existsSync(dir)) return;
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry);
      let isDirectory = false;
      try {
        isDirectory = readdirSync(path).length >= 0;
      } catch {
        isDirectory = false;
      }
      if (isDirectory) walk(path, depth - 1);
      else if (entry === 'decision-journal.ndjson') records.push(...recordsFromJournalLines(readJournalLines(path), { sourceFile: path }));
    }
  };
  walk(jobsRoot);
  return records;
}
