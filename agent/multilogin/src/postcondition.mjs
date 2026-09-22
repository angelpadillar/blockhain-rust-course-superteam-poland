import { PilotError, requireThat } from './core.mjs';
import { validatePostcondition } from './contract.mjs';

// The real evaluator for the postcondition schema in contract.mjs. It is pure:
// the caller injects a `probe` whose functions read the live page, so the same
// engine serves a real browser, a fixture and a unit test. Nothing here touches
// Playwright, and nothing here records observed page text.
//
//   url: async () => 'https://host/path'        (origin + pathname)
//   text: async () => visible text
//   fingerprint: async () => page fingerprint
//   control: async target => observed control or null   (by signature or id)
//   identityVerified: async () => boolean
//   verifiers: { [name]: async () => boolean }
export function createProbeFailure(code) { const error = new PilotError(code); error.probe = true; return error; }

export async function evaluatePostcondition({ postcondition, probe, context = {}, pollMs = 250,
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), now = Date.now } = {}) {
  const validated = validatePostcondition(postcondition);
  if (!validated) return { met: true, type: null, attempts: 0, elapsedMs: 0, detail: 'no_postcondition' };
  requireThat(probe && typeof probe === 'object', 'postcondition_probe_required');
  const timeoutMs = validated.timeoutMs ?? 5000;
  const started = now();
  const deadline = started + timeoutMs;
  // A bounded attempt count means a frozen clock cannot spin the loop forever.
  const maxAttempts = Math.max(2, Math.ceil(timeoutMs / Math.max(1, pollMs)) + 2);
  let attempts = 0; let detail = 'not_met';
  for (;;) {
    attempts++;
    // A probe may cache one page read per attempt; between attempts it re-reads.
    if (typeof probe.refresh === 'function') probe.refresh();
    try {
      if (await check({ postcondition: validated, probe, context })) {
        return { met: true, type: validated.type, attempts, elapsedMs: now() - started, detail: 'met' };
      }
    } catch (error) {
      // An unavailable probe reading is a failure of the check, not of the run.
      detail = error instanceof PilotError ? error.code : 'postcondition_probe_failed';
    }
    if (attempts >= maxAttempts || now() >= deadline) {
      return { met: false, type: validated.type, attempts, elapsedMs: now() - started, detail };
    }
    await sleep(Math.min(pollMs, Math.max(1, deadline - now())));
  }
}

async function check({ postcondition, probe, context }) {
  const target = postcondition.signature ?? postcondition.controlId ?? null;
  switch (postcondition.type) {
    case 'url_matches':
      return (await probe.url()) === postcondition.value;
    case 'url_changed':
      return (await probe.url()) !== (postcondition.from ?? context.url ?? null);
    case 'control_present':
      return Boolean(await probe.control(target));
    case 'control_absent':
      return !(await probe.control(target));
    case 'control_state': {
      const control = await probe.control(target);
      return Boolean(control) && control.enabled === postcondition.state;
    }
    case 'visible_text':
      return String(await probe.text()).includes(postcondition.value);
    case 'page_fingerprint_changed':
      return (await probe.fingerprint()) !== (postcondition.fingerprint ?? context.fingerprint ?? null);
    case 'identity_verified':
      // Reuses the specialized verifyIdentity() through the probe.
      return (await probe.identityVerified()) === true;
    case 'custom_verifier':
      requireThat(typeof probe.verifiers?.[postcondition.verifier] === 'function', 'unknown_verifier');
      return (await probe.verifiers[postcondition.verifier]()) === true;
    default:
      throw new PilotError('unsupported_postcondition');
  }
}
