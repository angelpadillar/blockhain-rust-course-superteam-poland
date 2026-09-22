import { requireThat } from './core.mjs';

// Level 2 of the execution policy: bounded recovery for browser states the
// deterministic adapter did not anticipate. A model may only name one of these
// typed capabilities; browser code executes it. The model never receives
// selectors, JavaScript, shell commands or raw page access.
export const maxRecoverySteps = 8;

export const recoveryCapabilities = {
  retry_observation: 'Re-read the current page without acting. It may still be rendering.',
  wait: 'Wait briefly for a pending redirect or client render, then re-observe.',
  reopen_account_menu: 'Reopen the account menu. It was opened earlier but is closed now, so the identity rows are not visible.',
  open_switch_account: 'Open "Switch account", which lists the signed-in identity that verification needs.',
  dismiss_onboarding: 'Dismiss a harmless onboarding or interstitial screen by clicking its own safe skip/continue control. Never used on a security page.',
  navigate_home: 'Navigate to the platform home page (an allowed origin) and re-observe.',
  complete: 'The expected identity is already verified, so the flow is complete.',
  escalate_security_checkpoint: 'Only a person can proceed: the platform is asking for an external code, confirmation or challenge this system must not attempt to bypass.',
};

const accountMenuLabel = /^(account|account menu|avatar image|google account: .+|konto|menu konta)$/;
const switchAccountLabel = /^(switch account|przełącz konto)$/;
const normalize = value => String(value || '').trim().toLowerCase().replace(/\s+/g, ' ');

// Hrefs are only reported when they stay inside the site's allowed origins, and
// only as origin+path so a query string can never carry auth material out.
export function safeHref(href, site) {
  if (!href) return null;
  try {
    const url = new URL(href);
    return site.origins.includes(url.origin) ? `${url.origin}${url.pathname}` : null;
  } catch { return null; }
}

// --- Safe onboarding dismissal -------------------------------------------------
// Non-security interstitials (for example Google's "Add a profile picture ...
// Skip") block progress but must never be dismissed on a security page. The
// capability is generated from an OBSERVED, VISIBLE control whose accessible
// name is on a strict allow-list, and is refused outright when the control's own
// meaning could touch account or security settings. It is not text clicking:
// the executor clicks the same candidate handle that was observed.
export const safeOnboardingLabels = /^(skip|not now|later|maybe later|continue|done|pomiń|nie teraz|później|gotowe|kontynuuj)$/;
const refusedOnboardingTerms = /(password|hasło|security|bezpiecze|verification|weryfikac|two.?step|recovery|odzyskiw|phone|telefon|card|payment|purchase|delete|remove|unlink|sign out|log out|wyloguj|privacy|permission|subscribe|enable|turn on)/;
// Pages that require a real person. Onboarding dismissal is never offered here.
const securityPageText = /captcha|verify you are human|confirm you.re human|unusual traffic|automated queries|check your phone|tap yes on|approve.{0,25}(phone|device)|security key|passkey|suspicious|recovery (email|phone|options)|confirm.{0,20}recovery|verify.{0,20}recovery|password reset|reset your password|change your password|account.{0,15}(disabled|suspended|locked|restricted)|konto.{0,15}zawieszon|two-step verification|2-step verification|\bcode\b.{0,60}\b(sent|email|sms)\b|\bsent\b.{0,60}\b(code|email)\b|text message/i;

export function looksLikeSecurityPage(snapshot) {
  if (snapshot.challengeFrame) return true;
  return securityPageText.test(normalize(snapshot.text));
}

export function onboardingControl(snapshot) {
  if (looksLikeSecurityPage(snapshot)) return null;
  for (const control of snapshot.controls) {
    if (!control.enabled) continue;
    const label = normalize(control.label);
    if (!safeOnboardingLabels.test(label)) continue;
    if (refusedOnboardingTerms.test(`${label} ${control.href}`)) continue;
    return control;
  }
  return null;
}

// Sanitized observation for the model. Credentials, cookies, headers, proxy
// credentials, API keys and query strings never enter this payload; text and
// labels pass through the account redactor, which masks codes and addresses.
export function recoveryObservation({ goal, snapshot, browser, recentActions = [], deterministicState = {} }) {
  const url = new URL(snapshot.url);
  const page = browser.publicPage(snapshot);
  return {
    goal,
    url: { origin: url.origin, pathname: url.pathname },
    title: typeof snapshot.title === 'string' ? snapshot.title.slice(0, 200) : null,
    deterministicState,
    recentActions: recentActions.slice(-8),
    text: page.text,
    controls: snapshot.controls.slice(0, 120).map(control => ({
      tag: control.tag,
      type: control.type,
      role: control.role || null,
      name: browser.redact(control.label || control.name),
      href: safeHref(control.href, browser.site),
      enabled: control.enabled,
    })),
  };
}


// Only capabilities that are genuinely available on the observed page are
// offered, so the model cannot pick an action the executor would refuse.
export function recoveryCandidates({ snapshot, browser, site, classifiedReason = null }) {
  const origin = new URL(snapshot.url).origin;
  const homeOrigin = new URL(site.homeUrl).origin;
  const usable = snapshot.controls.filter(control => control.enabled);
  const menuButton = usable.find(control => accountMenuLabel.test(normalize(control.label)));
  const switchRow = usable.find(control => switchAccountLabel.test(normalize(control.label)));

  const shortlist = [];
  // A harmless onboarding interstitial gets its safe dismissal first. It is not
  // offered when the runtime already classified a checkpoint, and onboardingControl
  // independently refuses any page that looks security-related.
  if (!classifiedReason) {
    const onboarding = onboardingControl(snapshot);
    if (onboarding) shortlist.push({ kind: 'dismiss_onboarding', control: onboarding });
  }
  if (switchRow) shortlist.push({ kind: 'open_switch_account', control: switchRow });
  else if (menuButton && origin === homeOrigin) shortlist.push({ kind: 'reopen_account_menu', control: menuButton });
  if (origin !== homeOrigin) shortlist.push({ kind: 'navigate_home' });
  shortlist.push({ kind: 'retry_observation' });
  shortlist.push({ kind: 'wait' });
  shortlist.push({ kind: 'escalate_security_checkpoint' });

  return shortlist.map((entry, index) => ({ ...entry, id: `r${index}`,
    description: `${entry.kind}: ${recoveryCapabilities[entry.kind]}` }));
}

export function validateRecoveryDecision({ decision, candidates }) {
  const action = candidates.find(candidate => candidate.id === decision?.action?.id);
  requireThat(action, 'unknown_recovery_action');
  requireThat(recoveryCapabilities[action.kind], 'unsupported_recovery_action');
  return action;
}

// A recovery click must show a new page state. Bounded well below the
// deterministic wait so an unchanged page cannot stall the episode: the loop
// re-observes on the next step anyway.
export const recoveryClickPostcondition = { type: 'page_fingerprint_changed', timeoutMs: 2000 };

// Deterministic executor for the chosen capability. A capability that touches the
// page performs NO browser operation itself: it goes through the shared kernel
// (workflow authorization -> decision-epoch freshness -> receipt -> dispatch ->
// postcondition), exactly like a deterministic decision. Jev has no second path.
export async function executeRecoveryAction({ action, snapshot, observation = null, browser, site,
  navigate, kernel = null, source = 'jev', justification = null,
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) }) {
  requireThat(recoveryCapabilities[action.kind], 'unsupported_recovery_action');
  const viaKernel = async ({ dispatch, expectedPostcondition }) => {
    requireThat(kernel, 'execution_kernel_required');
    requireThat(snapshot && observation?.epoch, 'observation_required');
    const outcome = await kernel.execute({ candidate: action, snapshot, observation, source, justification,
      dispatch, expectedPostcondition });
    return { performed: true, detail: action.kind, receipt: outcome.receipt,
      postconditionMet: outcome.postcondition.met };
  };
  switch (action.kind) {
    case 'retry_observation':
    case 'wait':
      return viaKernel({ dispatch: async () => { if (action.kind === 'wait') await sleep(1000); return null; },
        expectedPostcondition: null });
    case 'reopen_account_menu':
    case 'open_switch_account':
    case 'dismiss_onboarding':
      requireThat(action.control?.handle, 'stale_control');
      return viaKernel({ expectedPostcondition: recoveryClickPostcondition,
        // The kernel re-observed and re-resolved the control, so this clicks the
        // live handle rather than the one the decision was taken on.
        dispatch: async ({ control: resolved }) => {
          const target = resolved || action.control;
          requireThat(target?.handle, 'stale_control');
          await target.handle.click({ timeout: 5000, noWaitAfter: true }).catch(() => {});
          if (['reopen_account_menu', 'open_switch_account'].includes(action.kind)) {
            browser.menuClicks.set(target.key, (browser.menuClicks.get(target.key) || 0) + 1);
            if (action.kind === 'reopen_account_menu') browser.menuOpenedKeys.add(target.key);
          }
          browser.recovery.actions++;
          return null;
        } });
    case 'navigate_home':
      return viaKernel({ expectedPostcondition: null,
        dispatch: async () => { await navigate(browser.page, site.homeUrl); browser.recovery.actions++; return null; } });
    case 'complete':
      return { performed: false, complete: true };
    case 'escalate_security_checkpoint':
      return { performed: false, escalate: true };
    default:
      return { performed: false };
  }
}

// Transport/infrastructure failures are never offered to browser reasoning.
export function isInfrastructureFailure(code) {
  return ['proxy_connection_failed', 'tunnel_failed', 'dns_failed', 'connection_reset',
    'connection_timed_out', 'multilogin_request_uncertain', 'browser_attachment_failed',
    'invalid_browser_port'].includes(code)
    || /^multilogin_http_5\d\d$/.test(String(code || ''));
}
