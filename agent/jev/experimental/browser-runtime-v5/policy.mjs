// Task spec validation and step gates. The spec is the contract between the
// caller and the runtime: what "done" means deterministically, which values
// may be typed (the model sees only their names), which operations are
// permitted, and which controls are off-limits.
import { parseDoneWhen } from './donewhen.mjs';

export class PolicyError extends Error {
  constructor(code) { super(code); this.name = 'PolicyError'; this.code = code; }
}
const requireValue = (ok, code) => { if (!ok) throw new PolicyError(code); };
const text = (value, max, empty = false) => typeof value === 'string' && (empty || value.trim().length > 0)
  && value.length <= max && !/[\x00-\x1f]/.test(value);
const ALL_OPERATIONS = ['click', 'fill', 'select', 'press', 'scroll_down', 'scroll_up', 'go_back', 'wait', 'done', 'blocked'];
const DEFAULT_DENY = ['checkout', 'payment', 'pay', 'pay now', 'purchase', 'buy now', 'place order', 'zamów i zapłać', 'delete account', 'log out', 'sign out'];
const DEFAULT_DENY_PATH = 'checkout|orders?|payments?|transactions?|accounts?|profiles?|delete|remove|login|logout';

export function validateSpec(spec) {
  requireValue(spec && typeof spec === 'object' && !Array.isArray(spec), 'invalid_spec');
  requireValue(text(spec.goal, 1500), 'invalid_goal');
  const policy = spec.policy || {};
  const operations = policy.operations || ALL_OPERATIONS;
  requireValue(Array.isArray(operations) && operations.length >= 1 && operations.every(op => ALL_OPERATIONS.includes(op)), 'invalid_operations');
  const values = {};
  const revealed = {};
  for (const [key, value] of Object.entries(spec.values || {})) {
    requireValue(/^[a-zA-Z][a-zA-Z0-9_]{0,39}$/.test(key), 'invalid_value_key');
    // Plain strings stay hidden from the model; {text, reveal:true} entries
    // may appear in question text (names, search terms — never secrets).
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      requireValue(text(value.text, 500) && value.reveal === true, 'invalid_value');
      values[key] = value.text;
      revealed[key] = true;
    } else {
      requireValue(text(value, 500), 'invalid_value');
      values[key] = value;
    }
  }
  requireValue(Object.keys(values).length <= 12, 'too_many_values');
  const compiledDoneWhen = spec.doneWhen?.length ? parseDoneWhen(spec.doneWhen) : null;
  const notes = (spec.notes || []).map(note => {
    requireValue(text(note, 300), 'invalid_note');
    return note.trim();
  }).slice(0, 12);
  return {
    goal: spec.goal.trim(),
    doneWhen: compiledDoneWhen ? { clauses: spec.doneWhen, compiled: compiledDoneWhen } : null,
    values,
    revealed,
    notes,
    policy: {
      operations,
      avoid: (policy.avoid || []).map(pattern => new RegExp(pattern, 'i')).slice(0, 12),
      deny: policy.deny || DEFAULT_DENY,
      denyPath: policy.denyPath === undefined ? DEFAULT_DENY_PATH : policy.denyPath,
      targetFloor: policy.targetFloor ?? 0.35,
      operationFloor: policy.operationFloor ?? 0.30,
      doneFloor: policy.doneFloor ?? 0.85,
      destructiveGate: policy.destructiveGate ?? 0.5,
      allowDestructive: Boolean(policy.allowDestructive),
    },
    handlers: Array.isArray(spec.handlers) ? spec.handlers.slice(0, 8) : [],
  };
}

/** Drop policy-excluded controls before the model ever sees them. Avoid
 * matches on the control's label, component label and href. */
export function constrain(controls, policy) {
  return controls.filter(control => {
    const haystack = [control.what, control.component?.label || '', control.href || '', ...control.where].join(' ');
    return !policy.avoid.some(pattern => pattern.test(haystack));
  });
}
