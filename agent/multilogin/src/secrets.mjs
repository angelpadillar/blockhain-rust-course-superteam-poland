import { requireThat, totp } from './core.mjs';

// Secret indirection. A BrowserAction carries a valueRef - a name - and never a
// secret value. The model/advisor may name these references; only trusted
// executor code resolves them, and only AFTER authorization and freshness
// validation. Resolved values must never reach prompts, observations, receipts,
// journals, ordinary logs or screenshots.
export const modelVisibleValueRefs = ['account_username', 'account_password', 'current_totp',
  'verification_code', 'authorized_shipping_address'];
// Internal-only references, still never a value in a decision payload.
export const internalValueRefs = ['account_recovery_email'];

// Which reference a workflow operation needs. Absent means the operation carries
// no secret at all.
export const valueRefForOperation = {
  fill_username: 'account_username',
  fill_password: 'account_password',
  fill_recovery_email: 'account_recovery_email',
  fill_totp: 'current_totp',
  fill_verification_code: 'verification_code',
};
// Codes are time-based; everything else is a stable stored value.
export const timeBasedValueRefs = ['current_totp', 'verification_code'];
// A code with less than this much life left would likely arrive expired.
export const minimumCodeValidityMs = 5000;

export function createValueResolver({ account, shippingAddress = null,
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), now = Date.now }) {
  requireThat(account && typeof account === 'object', 'account_required');
  const stored = () => ({
    account_username: account.username,
    account_password: account.password,
    account_recovery_email: account.recoveryEmail ?? null,
    authorized_shipping_address: shippingAddress ?? null,
  });
  const resolver = {
    refs: [...modelVisibleValueRefs, ...internalValueRefs],
    // Resolving is a trusted-code operation. An unknown or unavailable
    // reference fails closed instead of returning an empty value.
    resolve: async ref => {
      requireThat(resolver.refs.includes(ref), 'unknown_value_ref');
      if (timeBasedValueRefs.includes(ref)) {
        requireThat(typeof account.totp === 'string' && account.totp.length > 0, 'secret_unavailable');
        let code = totp(account.totp, now());
        if (code.validForMs < minimumCodeValidityMs) {
          await sleep(code.validForMs + 100);
          code = totp(account.totp, now());
        }
        return code.code;
      }
      const value = stored()[ref];
      requireThat(typeof value === 'string' && value.length > 0, 'secret_unavailable');
      return value;
    },
  };
  return resolver;
}

// A short-lived vault for text supplied by an external surface (MCP): the action
// carries the reference, only trusted executor code resolves it, and the value is
// never recorded in a receipt, journal or observation.
export function createEphemeralVault({ prefix = 'operator_value' } = {}) {
  let counter = 0;
  const values = new Map();
  return {
    register(value) {
      requireThat(typeof value === 'string' && value.length > 0, 'invalid_value');
      counter++;
      const ref = `${prefix}_${counter}`;
      values.set(ref, value);
      return ref;
    },
    resolve(ref) {
      const value = values.get(ref);
      requireThat(typeof value === 'string', 'unknown_value_ref');
      return value;
    },
    has: ref => values.has(ref),
    refs: () => [...values.keys()],
  };
}

// Test/assertion helper: returns the leaked secret when a payload contains one.
// Used to prove that resolved values stay out of prompts and journals.
export function findLeakedSecret({ payload, secrets = [] } = {}) {
  const text = typeof payload === 'string' ? payload : JSON.stringify(payload ?? null);
  for (const secret of secrets) {
    if (typeof secret === 'string' && secret.length >= 4 && text.includes(secret)) return secret;
  }
  return null;
}
