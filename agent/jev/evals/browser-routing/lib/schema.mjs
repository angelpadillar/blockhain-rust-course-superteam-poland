/**
 * Browser-decision record schema (v1), secret guard and label taxonomy.
 *
 * One record = one meaningful browser decision. Records are append-only and
 * versioned; no credentials, cookies, tokens, proxy secrets or webhook URLs may
 * ever enter the store.
 */
import { createHash } from 'node:crypto';

export const SCHEMA = 'buena.browser-decision.record/1';
export const TOOL_VERSION = '1.0.0';

/** Only the first four labels automatically qualify for the fine-tuning corpus. */
export const LABEL_QUALITY = [
  'CURATED_REQUIRED_ACTION',
  'VERIFIED_SUCCESSFUL_ACTION',
  'VERIFIED_RECOVERY_ACTION',
  'VERIFIED_HUMAN_ESCALATION',
  'OBSERVED_SUCCESSFUL_ACTION',
  'AMBIGUOUS',
  'FAILED_ACTION',
];

export const HIGH_QUALITY_LABELS = new Set([
  'CURATED_REQUIRED_ACTION',
  'VERIFIED_SUCCESSFUL_ACTION',
  'VERIFIED_RECOVERY_ACTION',
  'VERIFIED_HUMAN_ESCALATION',
]);

export const ESCALATION_ACTIONS = new Set(['escalate_to_human', 'escalate_security_checkpoint', 'human_verification_required']);

export function isHighQuality(label) {
  return HIGH_QUALITY_LABELS.has(label);
}

/** A record is a security example only when it is a genuine escalation, never a solution. */
export function isSecurityExample(record) {
  return (
    record?.human_escalation?.kind === 'security_checkpoint' ||
    /captcha|recaptcha|hcaptcha|challenge|security_checkpoint|human_verification/i.test(record?.state?.page_class ?? '')
  );
}

export class RecordValidationError extends Error {}

export class SecretRejectedError extends Error {
  constructor(path, reason) {
    super(`secret material rejected at ${path}: ${reason}`);
    this.path = path;
    this.reason = reason;
  }
}

const FORBIDDEN_KEY = /(password|passwd|secret|api[_-]?key|apikey|access[_-]?token|refresh[_-]?token|id[_-]?token|bearer|cookie|authorization|auth[_-]?header|webhook|session[_-]?token|private[_-]?key|proxy[_-]?(url|user|pass|password|credential|auth))/i;
const FORBIDDEN_VALUE = [
  { pattern: /https?:\/\/(?:canary\.)?discord(?:app)?\.com\/api\/webhooks\//i, reason: 'discord webhook URL' },
  { pattern: /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/i, reason: 'bearer token' },
  { pattern: /\bop:\/\/[A-Za-z0-9/_-]+/i, reason: '1Password secret reference' },
  { pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/, reason: 'private key block' },
  { pattern: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/, reason: 'AWS access key id' },
  { pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/, reason: 'JWT' },
  { pattern: /[a-z]{3,8}:\/\/[^/@\s]+:[^/@\s]+@/i, reason: 'credential-in-URL' },
];

/** Walk a value; throw on secret keys/values unless `redact` is set. Returns {value, redactions}. */
export function guardSecrets(value, { redact = false, path = '$' } = {}) {
  const redactions = [];
  const walk = (node, currentPath) => {
    if (node === null || node === undefined) return node;
    if (typeof node === 'string') {
      for (const { pattern, reason } of FORBIDDEN_VALUE) {
        if (pattern.test(node)) {
          if (!redact) throw new SecretRejectedError(currentPath, reason);
          redactions.push({ path: currentPath, reason });
          return '[redacted]';
        }
      }
      return node;
    }
    if (Array.isArray(node)) return node.map((item, index) => walk(item, `${currentPath}[${index}]`));
    if (typeof node === 'object') {
      const output = {};
      for (const [key, item] of Object.entries(node)) {
        const childPath = `${currentPath}.${key}`;
        if (FORBIDDEN_KEY.test(key)) {
          if (!redact) throw new SecretRejectedError(childPath, `forbidden key "${key}"`);
          redactions.push({ path: childPath, reason: `forbidden key "${key}"` });
          output[key] = '[redacted]';
          continue;
        }
        output[key] = walk(item, childPath);
      }
      return output;
    }
    return node;
  };
  return { value: walk(value, path), redactions };
}

/** Security invariant: checkpoint states may only teach escalation, never solving. */
export function assertSecurityPolicy(record) {
  const security = isSecurityExample(record) || record.security === true;
  if (!security) return;
  const target = record?.label?.target_action ?? record?.executed?.action ?? null;
  if (!target || !ESCALATION_ACTIONS.has(target)) {
    throw new RecordValidationError(
      `security record ${record.decision_id ?? '(unknown)'} must target an escalation action, got ${target ?? 'none'}`,
    );
  }
  const forbidden = /(solve|captcha[_-]?answer|bypass|defeat|answer[_-]?challenge)/i;
  for (const candidate of record.candidates ?? []) {
    if (forbidden.test(String(candidate?.id ?? ''))) {
      throw new RecordValidationError(`security record contains a forbidden solution candidate "${candidate.id}"`);
    }
  }
  if (record.security_solution) throw new RecordValidationError('security records must not carry solution data');
}

const REQUIRED_TOP = ['schema', 'decision_id', 'job_id', 'profile_id', 'trajectory_id', 'timestamp', 'state', 'candidates', 'label_quality'];

export function validateRecord(record) {
  for (const field of REQUIRED_TOP) {
    if (record?.[field] === undefined || record?.[field] === null || record?.[field] === '') {
      throw new RecordValidationError(`missing required field ${field}`);
    }
  }
  if (record.schema !== SCHEMA) throw new RecordValidationError(`unexpected schema ${record.schema}`);
  if (!LABEL_QUALITY.includes(record.label_quality)) throw new RecordValidationError(`unknown label_quality ${record.label_quality}`);
  if (!Array.isArray(record.candidates)) throw new RecordValidationError('candidates must be an array');
  for (const candidate of record.candidates) {
    if (!candidate?.id || !candidate?.description) throw new RecordValidationError('each candidate needs id and description');
  }
  if (record.chosen && !record.candidates.some((candidate) => candidate.id === record.chosen)) {
    throw new RecordValidationError(`chosen ${record.chosen} is not in candidates`);
  }
  if (isHighQuality(record.label_quality) && !record.label?.target_action) {
    throw new RecordValidationError(`high-quality label ${record.label_quality} requires label.target_action`);
  }
  if (isHighQuality(record.label_quality) && !record.candidates.some((candidate) => candidate.id === record.label.target_action)) {
    throw new RecordValidationError(`label.target_action ${record.label.target_action} is not in candidates`);
  }
  assertSecurityPolicy(record);
  return record;
}

export function canonicalJson(value) {
  return `${JSON.stringify(sortKeys(value))}\n`;
}

function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortKeys(value[key])]));
  }
  return value;
}

export function sha256(text) {
  return createHash('sha256').update(text).digest('hex');
}

export function hashRecord(record) {
  return sha256(canonicalJson(record));
}

export function makeDecisionId({ trajectory_id, step, timestamp, executed_action, candidate_ids, observation_epoch }) {
  const material = [trajectory_id, step ?? '', timestamp ?? '', executed_action ?? '', (candidate_ids ?? []).join(','), observation_epoch ?? ''].join('|');
  return `dec_${sha256(material).slice(0, 20)}`;
}

/** Stable pseudonymous profile id; raw profile ids never enter the store. */
export function pseudonymizeProfile(rawProfileId) {
  if (!rawProfileId) return null;
  return `prof_${sha256(`profile:${rawProfileId}`).slice(0, 16)}`;
}
