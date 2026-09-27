/**
 * Append-only decision logger.
 *
 * The live browser controller writes one canonical JSON line per decision.
 * The logger is intentionally dependency-free so it can be imported from any
 * controller (including the browser worktree) without changing runtime
 * dependencies, and it fails closed on secret material.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  SCHEMA,
  guardSecrets,
  hashRecord,
  makeDecisionId,
  pseudonymizeProfile,
  validateRecord,
} from './schema.mjs';

export const DECISION_LOG_FILE = 'decisions-v1.ndjson';

export function createDecisionLogger({ dir, redact = false, onRedaction = null } = {}) {
  if (!dir) throw new Error('decision logger requires a directory');
  const file = join(dir, DECISION_LOG_FILE);

  return {
    file,
    append(record) {
      const normalized = normalizeDecisionInput(record);
      const { value, redactions } = guardSecrets(normalized, { redact });
      if (redactions.length && onRedaction) onRedaction(redactions);
      if (redactions.length) value.redactions = redactions;
      validateRecord(value);
      return write(value);
    },
    readAll() {
      return readDecisionLog(file);
    },
  };

  function write(record) {
    mkdirSync(dirname(file), { recursive: true });
    appendFileSync(file, `${JSON.stringify(record)}\n`, { encoding: 'utf8' });
    return { decision_id: record.decision_id, record_hash: hashRecord(record), file };
  }
}

/** Fill schema defaults from a controller input; never trust raw profile ids. */
export function normalizeDecisionInput(input) {
  const record = structuredClone(input);
  record.schema = record.schema ?? SCHEMA;
  record.profile_id = pseudonymizeProfile(record.profile_id ?? record.profileRef ?? record.scope?.profileId ?? record.scope?.profileRef);
  record.job_id = record.job_id ?? record.jobId ?? record.scope?.jobId ?? 'unknown-job';
  record.trajectory_id = record.trajectory_id ?? record.trajectoryId ?? `${record.job_id}:${record.profile_id ?? 'unknown'}`;
  record.timestamp = record.timestamp ?? new Date().toISOString();
  record.step = record.step ?? 0;
  record.candidates = (record.candidates ?? []).map((candidate) =>
    typeof candidate === 'string' ? { id: candidate, description: candidate } : candidate,
  );
  record.state = record.state ?? {};
  if (typeof record.state === 'string') record.state = { text: record.state };
  record.label_quality = record.label_quality ?? 'AMBIGUOUS';
  const chosen = record.chosen ?? record.executed?.action ?? null;
  record.chosen = chosen;
  if (!record.decision_id) {
    record.decision_id = makeDecisionId({
      trajectory_id: record.trajectory_id,
      step: record.step,
      timestamp: record.timestamp,
      executed_action: chosen,
      candidate_ids: record.candidates.map((candidate) => candidate.id),
      observation_epoch: record.state.observation_epoch,
    });
  }
  if (record.label?.target_action && !record.label.basis) record.label.basis = 'unknown';
  if (record.label?.target_action) {
    const target = record.candidates.find((candidate) => candidate.id === record.label.target_action);
    if (target) record.label.target_description = target.description;
  }
  return record;
}

export function readDecisionLog(file) {
  if (!existsSync(file)) return [];
  const records = [];
  const errors = [];
  const lines = readFileSync(file, 'utf8').split('\n');
  lines.forEach((line, index) => {
    if (!line.trim()) return;
    try {
      const parsed = JSON.parse(line);
      validateRecord(parsed);
      records.push(parsed);
    } catch (error) {
      errors.push({ line: index + 1, error: error.message });
    }
  });
  return Object.assign(records, { errors });
}
