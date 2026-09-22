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
export function recoveryCandidates({ snapshot, browser, site }) {
  const origin = new URL(snapshot.url).origin;
  const homeOrigin = new URL(site.homeUrl).origin;
  const usable = snapshot.controls.filter(control => control.enabled);
  const menuButton = usable.find(control => accountMenuLabel.test(normalize(control.label)));
  const switchRow = usable.find(control => switchAccountLabel.test(normalize(control.label)));

  const shortlist = [];
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

// Deterministic executor for the chosen capability.
export async function executeRecoveryAction({ action, browser, site, navigate,
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) }) {
  requireThat(recoveryCapabilities[action.kind], 'unsupported_recovery_action');
  switch (action.kind) {
    case 'retry_observation':
      return { performed: true, detail: 'retry_observation' };
    case 'wait':
      await sleep(1000);
      return { performed: true, detail: 'wait' };
    case 'reopen_account_menu':
    case 'open_switch_account': {
      requireThat(action.control?.handle, 'stale_control');
      await action.control.handle.click({ timeout: 5000, noWaitAfter: true }).catch(() => {});
      browser.menuClicks.set(action.control.key, (browser.menuClicks.get(action.control.key) || 0) + 1);
      if (action.kind === 'reopen_account_menu') browser.menuOpenedKeys.add(action.control.key);
      browser.recovery.actions++;
      return { performed: true, detail: action.kind };
    }
    case 'navigate_home':
      await navigate(browser.page, site.homeUrl);
      browser.recovery.actions++;
      return { performed: true, detail: 'navigate_home' };
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
