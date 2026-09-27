// v6 spec validation: everything the frozen v5 contract enforces, plus the
// 'upload' operation and a declared `files` map. Files follow the same rule
// as values — the model sees only the key name; the absolute path is resolved
// by the executor at dispatch, so a decision can never name a path.
import { isAbsolute } from 'node:path';
import { validateSpec as validateBase, constrain, PolicyError } from '../../bench/frozen-v5/policy.mjs';

export { constrain, PolicyError };
const requireValue = (ok, code) => { if (!ok) throw new PolicyError(code); };

export function validateSpec(spec) {
  const operations = spec?.policy?.operations;
  const wantsUpload = !Array.isArray(operations) || operations.includes('upload');
  const inner = Array.isArray(operations) ? { ...spec, policy: { ...spec.policy, operations: operations.filter(op => op !== 'upload') } } : spec;
  const validated = validateBase(inner);
  if (wantsUpload) validated.policy.operations = [...validated.policy.operations, 'upload'];
  const files = {};
  for (const [key, value] of Object.entries(spec?.files || {})) {
    requireValue(/^[a-zA-Z][a-zA-Z0-9_]{0,39}$/.test(key), 'invalid_file_key');
    requireValue(typeof value === 'string' && isAbsolute(value) && value.length <= 500 && !/[\x00-\x1f]/.test(value), 'invalid_file_path');
    files[key] = value;
  }
  requireValue(Object.keys(files).length <= 8, 'too_many_files');
  // batchForms=false selects the legacy one-action-per-decision protocol —
  // an A/B measurement flag, not a behavior change: the plan questions simply
  // are not built, so Jev sees the original atom list only.
  if (spec.batchForms === false) return { ...validated, files, batchForms: false };
  return { ...validated, files };
}
