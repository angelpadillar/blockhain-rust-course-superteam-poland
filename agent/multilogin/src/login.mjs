import { createHash } from 'node:crypto';
import { PilotError, requireThat, navigationError, accountId, createRedactor } from './core.mjs';
import { maxRecoverySteps, recoveryObservation, recoveryCandidates, validateRecoveryDecision,
  executeRecoveryAction } from './recovery.mjs';
import { BrowserExecutionKernel, decisionSourceFor } from './execution.mjs';
import { createValueResolver, valueRefForOperation } from './secrets.mjs';

export const defaultLoginGoal = 'Sign in to the supplied existing account and confirm the expected '
  + 'identity. Do not create an account, change account settings, or post content. Human confirmation '
  + 'is only for an external verification this system cannot legitimately supply.';

export const sites = {
  instagram: {
    loginUrl: 'https://www.instagram.com/accounts/login/', homeUrl: 'https://www.instagram.com/',
    origins: ['https://www.instagram.com', 'https://instagram.com'],
    credentialOrigins: ['https://www.instagram.com', 'https://instagram.com'],
  },
  youtube: {
    loginUrl: 'https://accounts.google.com/ServiceLogin?service=youtube&continue=https%3A%2F%2Fwww.youtube.com%2F',
    homeUrl: 'https://www.youtube.com/',
    // Navigation permission only. Two post-auth origins were observed in the
    // real Google/YouTube flow and had to be allowed or the adapter aborted on a
    // legitimate redirect:
    //   https://gds.google.com          - the landing page observe() rejected
    //                                     (path /web/landing, then /web/recoveryoptions)
    //   https://accounts.youtube.com    - YouTube's SetSID hop on the way to youtube.com
    // credentialOrigins stays unchanged, so credentials can still only be typed
    // on the Google sign-in origin.
    origins: ['https://accounts.google.com', 'https://www.youtube.com', 'https://youtube.com', 'https://myaccount.google.com',
      'https://gds.google.com', 'https://accounts.youtube.com'],
    credentialOrigins: ['https://accounts.google.com'],
  },
};
const normalize = value => String(value || '').trim().toLowerCase().replace(/\s+/g, ' ');
function signature(control) {
  return JSON.stringify([control.tag, control.type, control.name, control.label, control.href, control.formAction]);
}
function fieldStage(snapshot) {
  return JSON.stringify(snapshot.controls.filter(control => control.tag === 'input' && control.type !== 'checkbox')
    .map(control => [control.type, control.label, control.autocomplete]));
}
export function classifyPage(snapshot) {
  const text = normalize(snapshot.text);
  if (/couldn.t find (your google|this) account|could not find your google account|nie (można|mogliśmy) znaleźć.{0,20}konta/.test(text)) return 'account_not_found';
  if (/enter a valid email|enter an email or phone number|wpisz poprawny adres/.test(text)) return 'invalid_login_identifier';
  if (/incorrect password|wrong password|password.{0,15}incorrect|invalid credentials|nieprawidłowe hasło|błędne hasło/.test(text)) return 'invalid_credentials';
  if (/incorrect code|invalid code|code.{0,12}expired|kod.{0,12}nieprawidł/.test(text)) return 'invalid_verification_code';
  if (/too many attempts|try again later|rate limit|zbyt wiele prób/.test(text)) return 'rate_limited';
  if (/account.{0,15}(disabled|suspended)|konto.{0,15}zawieszon/.test(text)) return 'account_restricted';
  if (/couldn.t sign you in|could not sign you in|didn.t provide enough info/.test(text)
    || String(snapshot.url || '').includes('/signin/rejected')) return 'signin_rejected';
  if (/wants to access your google account|grant.{0,20}access|create your account|agree to the terms/.test(text)) return 'account_setup_requires_attention';
  if (/captcha|verify you are human|confirm you.re human|unusual traffic|automated queries/.test(text)
    || snapshot.challengeFrame) return 'human_verification_required';
  if (/check your phone|tap yes on|approve.{0,25}(phone|device)|security key|passkey/.test(text)
    && !/authenticator|authentication app/.test(text)) return 'device_verification_required';
  if (/code.{0,60}(sent|email|sms)|sent.{0,60}(code|email)|text message/.test(text)
    && !/authenticator|authentication app/.test(text)) return 'email_or_sms_verification_required';
  return null;
}

// Classifications describing an unfamiliar or security-related page, where a
// model may legitimately recognise a normal navigation or confirm that a person
// is genuinely required. A definitive credential outcome is deliberately absent:
// wrong password, unknown account or a rate limit stops deterministically.
export const recoverableClassifications = ['human_verification_required', 'device_verification_required',
  'email_or_sms_verification_required', 'account_setup_requires_attention'];
function recoverableClassification(reason) {
  return recoverableClassifications.includes(reason);
}

export function verifyIdentity(account, snapshot, site = sites[account.platform]) {
  if (new URL(snapshot.url).origin !== new URL(site.homeUrl).origin) return false;
  if (snapshot.controls.some(control => control.type === 'password')) return false;
  const username = account.username.toLowerCase();
  if (account.platform === 'instagram') {
    const paths = snapshot.controls.filter(control => control.href).map(control => {
      try { const url = new URL(control.href); return url.origin === new URL(site.homeUrl).origin ? url.pathname.toLowerCase() : ''; }
      catch { return ''; }
    });
    return paths.includes(`/${username}/`) && paths.some(path => path.startsWith('/direct/inbox'));
  }
  // Account-menu evidence, not a public channel name or the model's completion judgment.
  const text = snapshot.text.toLowerCase();
  const emails = [...new Set(text.match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/g) || [])];
  return emails.length === 1 && emails[0] === username && /sign out|wyloguj/.test(text)
    && /switch account|przełącz konto|google account|konto google|add account|dodaj konto/.test(text)
    && !/choose an account|wybierz konto/.test(text);
}

export async function navigate(page, url) {
  let response;
  try { response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 }); }
  catch (error) { throw navigationError(error); }
  if (response?.status() === 429) throw new PilotError('rate_limited');
  if ([401, 403].includes(response?.status())) throw new PilotError('site_access_denied');
  if (response?.status() >= 500) throw new PilotError('site_server_error');
}

export class LoginBrowser {
  constructor(page, account, { site = sites[account.platform], secrets = null } = {}) {
    this.page = page; this.account = account; this.site = site;
    // Trusted secret indirection: the flow names account_username,
    // account_password, current_totp ... and only this object resolves them,
    // only at fill time, and never towards a model, receipt or log.
    this.secrets = secrets || createValueResolver({ account });
    this.filled = new Set(); this.clicked = new Set(); this.documentKey = null;
    this.submittedStages = new Set();
    this.redact = createRedactor([account.username, account.password, account.totp, account.recoveryEmail]);
    this.lastCode = null; this.ownedHandles = [];
    // Menu toggles are bounded rather than permanently deduped: YouTube re-renders
    // its masthead after the post-login load and discards an opened dropdown, and
    // a permanent dedup left the flow with zero legal actions. Attempts are
    // counted per control so a closed menu can be reopened a bounded number of
    // times without allowing an open/close toggle loop.
    this.menuClicks = new Map();
    this.menuOpenedKeys = new Set();
    this.recoverySteps = 0;
    this.recovery = { steps: 0, actions: 0, calls: 0, reasons: [] };
    this.recoveryFingerprint = null;
    this.recoveryStalls = 0;
  }
  // Level 1 reopening: how many deterministic reopen attempts a menu control gets
  // before recovery takes over.
  static get maxMenuReopenAttempts() { return 2; }
  get menuActionCount() {
    return [...this.menuClicks.values()].reduce((total, count) => total + count, 0);
  }
  async observe() {
    const url = this.page.url();
    requireThat(this.site.origins.includes(new URL(url).origin), 'unexpected_login_destination');
    for (const handle of this.ownedHandles) await handle.dispose().catch(() => {});
    const handles = await this.page.$$('input,button,a,[role="button"],[role="link"],[role="option"],[role="listitem"],[role="menuitem"],[data-challengeid],[data-challengetype],[jsaction][tabindex="0"],tp-yt-paper-item'); this.ownedHandles = handles;
    const controls = [];
    for (const handle of handles.slice(0, 300)) {
      if (!await handle.isVisible().catch(() => false)) continue;
      const control = await handle.evaluate(element => ({
        tag: element.tagName.toLowerCase(), type: element.getAttribute('type') || '',
        name: element.getAttribute('name') || element.id || '',
        label: element.getAttribute('aria-label') || [...(element.labels || [])].map(label => label.innerText).join(' ')
          || element.getAttribute('placeholder') || element.innerText?.slice(0, 180) || element.querySelector('img')?.alt || '',
        autocomplete: element.getAttribute('autocomplete') || '',
        role: element.getAttribute('role') || '',
        href: element.tagName === 'A' ? element.href : '',
        formAction: element.form ? element.form.action : '',
        required: Boolean(element.required),
        enabled: !element.disabled && !element.readOnly && element.getAttribute('aria-disabled') !== 'true',
      }));
      control.key = signature(control); control.handle = handle; controls.push(control);
    }
    const text = (await this.page.locator('body').innerText({ timeout: 5000 })).slice(0, 14000);
    const challengeFrame = await this.page.locator('iframe[src*="recaptcha"],iframe[src*="hcaptcha"],iframe[src*="challenges.cloudflare.com"]').count() > 0;
    const snapshot = { url, controls, text, challengeFrame };
    snapshot.fingerprint = createHash('sha256').update(JSON.stringify([url, text, controls.map(control => control.key)])).digest('hex');
    // Reset fill tracking only after navigation or a genuinely new set of fields.
    const documentKey = JSON.stringify([url, controls.filter(control => control.tag === 'input').map(control => control.key)]);
    if (this.documentKey !== documentKey) { this.filled.clear(); this.documentKey = documentKey; }
    return snapshot;
  }
  candidates(snapshot, { verifyOnly = false } = {}) {
    const actions = []; const fieldActions = []; let unknownRequiredField = false; let unhandledField = false;
    const authOrigin = this.site.credentialOrigins.includes(new URL(snapshot.url).origin);
    const authenticatorScreen = /go to your authentication app|authenticator app|code.{0,160}(authenticator|authentication app)/s.test(normalize(snapshot.text));
    for (const control of snapshot.controls) {
      if (!control.enabled) continue;
      const label = normalize(`${control.name} ${control.label} ${control.autocomplete}`);
      let kind;
      if (!verifyOnly && authOrigin && control.tag === 'input' && !this.filled.has(control.key)) {
        if (control.autocomplete === 'new-password' || /new password|confirm password/.test(label)) {
          unknownRequiredField = true; continue;
        }
        // Google keeps a decoy password input on its authenticator-code screen; it must not be filled or treated as required.
        if (control.type === 'password' && authenticatorScreen) continue;
        if (control.type === 'password') kind = 'fill_password';
        else if (/one-time-code|totp|verificationcode|security.code|authenticator|login code|kod logowania/.test(label)
          || (authenticatorScreen && /^(enter |type )?(your |the )?code$/.test(normalize(control.label))
            && ['text', 'tel', 'number'].includes(control.type))) {
          if (this.account.totp) kind = 'fill_totp';
        } else if (/recovery|backup|odzyskiwania/.test(label)) {
          if (this.account.recoveryEmail) kind = 'fill_recovery_email';
        } else if (/username|identifier|e.?mail|phone number|nazwa użytkownika/.test(label)) kind = 'fill_username';
        if (kind) fieldActions.push({ kind, control });
        else {
          if (control.type !== 'checkbox') unhandledField = true;
          if (control.required) unknownRequiredField = true;
        }
      }
    }
    actions.push(...fieldActions);
    for (const control of snapshot.controls) {
      if (!control.enabled || control.tag === 'input') continue;
      const label = normalize(control.label);
      let kind;
      if (/^(reject all|decline optional cookies|only allow essential cookies|odrzuć wszystkie|odrzuć opcjonalne pliki cookie)$/.test(label)) kind = 'dismiss_cookies';
      if (this.account.platform === 'youtube' && /^(account|account menu|avatar image|google account: .+|konto|menu konta)$/.test(label)) kind = 'open_account_menu';
      if (this.account.platform === 'youtube' && /^(switch account|przełącz konto)$/.test(label)) kind = 'open_switch_account';
      if (!verifyOnly && authOrigin && !unknownRequiredField && fieldActions.length === 0
        && !this.submittedStages.has(fieldStage(snapshot))
        && /^(log in|login|sign in|next|continue|confirm|verify|i agree|accept|zaloguj się|dalej|kontynuuj|potwierdź)$/.test(label)) kind = 'submit_login';
      if (!verifyOnly && authOrigin && fieldActions.length === 0 && this.account.totp
        && (/authenticator|aplikacji uwierzytelniaj/.test(label)
          || /^(use (an )?authenticator app|authentication app|use a verification code|użyj aplikacji uwierzytelniającej)$/.test(label))) kind = 'choose_totp';
      if (!verifyOnly && authOrigin && fieldActions.length === 0 && /^try another way$/.test(label)) kind = 'try_another_way';
      if (!verifyOnly && this.account.platform === 'youtube' && control.tag === 'a' && /^(sign in|zaloguj się)$/.test(label)) kind = 'open_login';
      if (!kind) continue;
      // Menu toggles change the page fingerprint every time they open or close,
      // so a fingerprint key would loop forever. They are instead bounded per
      // control: a control may be used a small fixed number of times, which
      // still allows recovering when a re-render discarded the opened menu.
      const menuKind = ['open_account_menu', 'open_switch_account'].includes(kind);
      const menuUsed = menuKind ? (this.menuClicks.get(control.key) || 0) : 0;
      if (menuKind && menuUsed >= LoginBrowser.maxMenuReopenAttempts) continue;
      const clickKey = menuKind
        ? `menu:${control.key}:${menuUsed}` : `${snapshot.fingerprint}:${control.key}`;
      if (this.clicked.has(clickKey)) continue;
      if (control.href) {
        try { if (!this.site.origins.includes(new URL(control.href).origin)) continue; } catch { continue; }
      }
      actions.push({ kind, control, clickKey });
    }
    // Resolve an observed cookie prompt before interacting with the form behind it.
    const cookieActions = actions.filter(action => action.kind === 'dismiss_cookies');
    // The known two-field form has a deterministic order. Duplicate/ambiguous
    // fields remain choices for Jev; values never enter the model request.
    const knownLoginForm = actions.length === 2 && actions.filter(action => action.kind === 'fill_username').length === 1
      && actions.filter(action => action.kind === 'fill_password').length === 1;
    // A direct authenticator option beats cycling through "Try another way" screens.
    const totpOptions = actions.filter(action => action.kind === 'choose_totp');
    const escapeActions = actions.filter(action => action.kind === 'try_another_way');
    const submitActions = actions.filter(action => action.kind === 'submit_login');
    // Equivalent menu entries are interchangeable; pick one deterministically.
    const switchActions = actions.filter(action => action.kind === 'open_switch_account');
    const menuActions = actions.filter(action => action.kind === 'open_account_menu');
    // An unfilled field we cannot complete means the challenge itself is wrong
    // (for example an email code); cycling options beats submitting empty.
    // Once every observed field is handled, a present submit control is the
    // deterministic next step rather than a model question.
    const permitted = cookieActions.length ? cookieActions
      : knownLoginForm ? actions.filter(action => action.kind === 'fill_username')
      : totpOptions.length ? totpOptions
      : unhandledField && escapeActions.length ? escapeActions
      : submitActions.length && !unhandledField ? submitActions
      : switchActions.length ? switchActions.slice(0, 1)
      : menuActions.length ? menuActions.slice(0, 1)
      : actions;
    // The decision payload names the REFERENCE a value would come from; the
    // value itself is never part of an observation, prompt or description.
    return permitted.slice(0, 80).map((action, index) => {
      const valueRef = valueRefForOperation[action.kind] || null;
      return { ...action, id: `a${index}`, valueRef,
        description: `${action.kind}: observed ${action.control.tag} labelled "${this.redact(action.control.label || action.control.name)}"`
          + (valueRef ? ` (valueRef ${valueRef}; code supplies the value)` : '') };
    });
  }
  publicPage(snapshot) {
    return { origin: new URL(snapshot.url).origin, path: this.redact(new URL(snapshot.url).pathname),
      text: this.redact(snapshot.text).slice(0, 5000),
      controls: snapshot.controls.slice(0, 80).map(control => ({ tag: control.tag, type: control.type,
        label: this.redact(control.label), enabled: control.enabled })) };
  }
  async execute(action, snapshot) {
    requireThat(this.page.url() === snapshot.url, 'stale_page');
    const { control, kind } = action;
    requireThat(await control.handle.isVisible() && await control.handle.isEnabled(), 'stale_control');
    const current = await control.handle.evaluate(element => ({
      tag: element.tagName.toLowerCase(), type: element.getAttribute('type') || '',
      name: element.getAttribute('name') || element.id || '',
      label: element.getAttribute('aria-label') || [...(element.labels || [])].map(label => label.innerText).join(' ')
        || element.getAttribute('placeholder') || element.innerText?.slice(0, 180) || element.querySelector('img')?.alt || '',
      href: element.tagName === 'A' ? element.href : '', formAction: element.form ? element.form.action : '',
    }));
    requireThat(signature(current) === control.key, 'stale_control');
    if (current.formAction) requireThat(this.site.credentialOrigins.includes(new URL(current.formAction).origin), 'unexpected_form_destination');
    if (kind.startsWith('fill_')) {
      requireThat(this.site.credentialOrigins.includes(new URL(this.page.url()).origin), 'credential_origin_mismatch');
      // The action carries a REFERENCE. Trusted code resolves it here - after the
      // page, origin and control checks above - and the value goes straight into
      // the field. It is never returned, logged, journaled or receipted.
      const ref = valueRefForOperation[kind];
      requireThat(ref, 'unsupported_action');
      if (action.valueRef) requireThat(action.valueRef === ref, 'value_ref_mismatch');
      const value = await this.secrets.resolve(ref);
      if (kind === 'fill_totp') { this.redact.add(value); this.lastCode = value; }
      await control.handle.fill(value, { timeout: 5000 }); this.filled.add(control.key); return;
    }
    requireThat(['submit_login', 'open_login', 'choose_totp', 'try_another_way', 'dismiss_cookies', 'open_account_menu', 'open_switch_account'].includes(kind), 'unsupported_action');
    this.clicked.add(action.clickKey || `${snapshot.fingerprint}:${control.key}`);
    if (kind === 'submit_login') this.submittedStages.add(fieldStage(snapshot));
    if (['open_account_menu', 'open_switch_account'].includes(kind)) {
      this.menuClicks.set(control.key, (this.menuClicks.get(control.key) || 0) + 1);
      if (kind === 'open_account_menu') this.menuOpenedKeys.add(control.key);
    }
    // A deterministic step is real progress, so a recovery episode restarts its
    // budget here.
    this.recoverySteps = 0;
    // Our own transition check handles both navigation and asynchronous form submissions.
    await control.handle.click({ timeout: 5000, noWaitAfter: true });
  }
  async waitForChange(previous, action) {
    const end = Date.now() + (action.kind === 'submit_login' ? 35000 : 10000);
    while (Date.now() < end) {
      await new Promise(resolve => setTimeout(resolve, 250));
      try {
        const next = await this.observe();
        if (action.kind === 'submit_login') {
          if (classifyPage(next) || verifyIdentity(this.account, next, this.site)
            || (fieldStage(next) !== fieldStage(previous) && next.controls.some(control => control.tag === 'input' && control.enabled))
            || (next.url !== previous.url && next.controls.length > 0 && !next.controls.some(control => control.tag === 'input'))) return next;
        } else if (next.fingerprint !== previous.fingerprint) return next;
      }
      catch (error) { if (error instanceof PilotError) throw error; }
    }
    throw new PilotError('page_did_not_advance');
  }
}

export async function runLogin({ page, account, choose, maxSteps = 20, maxSeconds = 180,
  verifyOnly = false, onStep = async () => {}, requestHumanCheckpoint = null, site = sites[account.platform],
  goal = defaultLoginGoal, recoveryBudget = maxRecoverySteps, readyWindowMs = 5000 }) {
  const browser = new LoginBrowser(page, account, { site });
  // The single execution path for this run. The deterministic flow and the Jev
  // recovery episode both go through it; nothing else performs a browser
  // operation. Roles come from this workflow, never from a model.
  const kernel = new BrowserExecutionKernel({
    browser, account, site, workflow: 'login', runId: `login-${accountId(account)}`,
    observe: () => browser.observe(),
    identityVerified: snapshot => verifyIdentity(account, snapshot, site),
    journal: async entry => onStep({ step: entry.step ?? null, phase: 'receipt', ...entry }),
  });
  let interstitialBypassed = false;
  // Recent deterministic actions, so a recovery observation carries context
  // without ever carrying page content that is not already redacted.
  const recentActions = [];
  // Page states that already consumed a full patience window with no usable
  // controls, so they are not waited on again.
  const emptyFingerprints = new Set();
  const finish = result => ({ ...result,
    recovery: { ...browser.recovery, menuActions: browser.menuActionCount } });
  const network = [];
  const recordNetwork = (request, status, error) => {
    const url = new URL(request.url());
    if (!['xhr', 'fetch'].includes(request.resourceType()) || !site.origins.includes(url.origin)) return;
    // Only transport metadata: never request bodies, headers, query strings or response bodies.
    network.push({ method: request.method(), origin: url.origin, status,
      ...(error ? { error: /^net::ERR_[A-Z_]+$/.test(error) ? error : 'request_failed' } : {}) });
    if (network.length > 20) network.shift();
  };
  const responseListener = response => recordNetwork(response.request(), response.status());
  const failureListener = request => recordNetwork(request, null, request.failure()?.errorText);
  page.on('response', responseListener); page.on('requestfailed', failureListener);
  try {
  const started = performance.now(); let deadline = Date.now() + maxSeconds * 1000;
  await navigate(page, verifyOnly ? site.homeUrl : site.loginUrl);
  for (let step = 0; step < maxSteps; step++) {
    requireThat(Date.now() < deadline, 'login_time_budget_exceeded');
    // Client-rendered login pages can expose text before their controls exist.
    // Wait for actionable evidence without reloading or submitting anything.
    let snapshot = await browser.observe();
    const hasCandidates = () => browser.candidates(snapshot, { verifyOnly }).length > 0;
    // The patience window exists for client-rendered controls. A page state that
    // already had a full window and still offered nothing does not get a second
    // one, so an unstructured page reaches recovery promptly instead of being
    // re-waited on every single step.
    if (!emptyFingerprints.has(snapshot.fingerprint)) {
      const readyDeadline = Math.min(deadline, Date.now() + readyWindowMs);
      for (;;) {
        if (verifyIdentity(account, snapshot, site) || classifyPage(snapshot)
          || hasCandidates() || Date.now() >= readyDeadline) break;
        await new Promise(resolve => setTimeout(resolve, 250));
        snapshot = await browser.observe();
      }
    }
    if (!hasCandidates()) emptyFingerprints.add(snapshot.fingerprint);
    // The decision and its execution share ONE observation epoch: every control
    // id below is only meaningful against this epoch.
    const observation = kernel.observe(snapshot).observation;
    if (verifyIdentity(account, snapshot, site)) {
      return finish({ verified: true, steps: step, durationMs: Math.round(performance.now() - started) });
    }
    const attention = async reason => onStep({ step, phase: 'attention', reason, page: browser.publicPage(snapshot) });
    // Level 2 recovery episode. The model may only name a typed capability from
    // recovery.mjs; the shared choice policy validates it and browser code
    // executes it. A bounded budget stops a loop. Transport failures never
    // reach here - runner.mjs handles those as infrastructure.
    const requestRecovery = async classifiedReason => {
      if (browser.recoverySteps >= recoveryBudget) {
        await onStep({ step, phase: 'jev_recovery', state: 'budget_exhausted',
          reason: classifiedReason || 'no_actions', recoveryStep: browser.recoverySteps, budget: recoveryBudget });
        return { exhausted: true };
      }
      // A page state that is unchanged after two recovery attempts will not
      // resolve by trying again, so the episode ends instead of spinning.
      if (browser.recoveryFingerprint === snapshot.fingerprint) browser.recoveryStalls++;
      else browser.recoveryStalls = 0;
      browser.recoveryFingerprint = snapshot.fingerprint;
      if (browser.recoveryStalls >= 2) {
        await onStep({ step, phase: 'jev_recovery', state: 'stalled',
          reason: classifiedReason || 'no_actions', recoveryStep: browser.recoverySteps, budget: recoveryBudget });
        return { exhausted: true };
      }
      const candidates = recoveryCandidates({ snapshot, browser, site,
        classifiedReason: classifiedReason || null });
      if (!candidates.length) return { exhausted: false };
      const modelView = recoveryObservation({ goal, snapshot, browser, recentActions,
        deterministicState: { step, classifiedReason: classifiedReason || null, verifyOnly,
          menuOpenedBefore: browser.menuOpenedKeys.size > 0 } });
      let decision;
      try {
        decision = await choose({ page: modelView,
          actions: candidates.map(({ id, description }) => ({ id, description })) });
      } catch (error) {
        await onStep({ step, phase: 'jev_recovery', state: 'selection_failed',
          reason: classifiedReason || 'no_actions',
          detail: error instanceof PilotError ? error.code : 'selection_failed' });
        return { failed: true };
      }
      browser.recovery.calls++;
      let action;
      try { action = validateRecoveryDecision({ decision, candidates }); }
      catch { return { failed: true }; }
      browser.recoverySteps++; browser.recovery.steps++;
      browser.recovery.reasons.push(action.kind);
      await onStep({ step, phase: 'jev_recovery', state: 'decision', reason: classifiedReason || 'no_actions',
        action: action.kind, method: decision.method, confidence: decision.confidence,
        probability: decision.probability, rationale: decision.reason || null,
        recoveryStep: browser.recoverySteps, budget: recoveryBudget });
      // Jev never touches the browser: its capability goes through the same
      // kernel as a deterministic decision (authorize -> epoch -> receipt ->
      // existing executor -> postcondition).
      const outcome = await executeRecoveryAction({ action, snapshot, observation, browser, site, navigate,
        kernel, source: decisionSourceFor(decision), justification: decision.reason || null });
      if (outcome.performed) recentActions.push({ step, action: action.kind, via: 'jev_recovery' });
      return outcome;
    };
    const failure = classifyPage(snapshot);
    if (failure) {
      // An email/SMS or device challenge may still offer a path to the
      // authenticator method we can complete; use the escape before stopping.
      const escape = ['email_or_sms_verification_required', 'device_verification_required'].includes(failure)
        && account.totp && browser.candidates(snapshot, { verifyOnly })
          .some(action => action.kind === 'choose_totp' || action.kind === 'try_another_way');
      if (!escape) {
        // An unfamiliar security-looking page is offered to recovery before a
        // person is asked. Recovery can only resume normal navigation or escalate;
        // no capability answers a challenge. A definitive credential outcome
        // (wrong password, unknown account, rate limit) is not an unfamiliar
        // state, so it stops as before instead of being handed to a model.
        if (recoverableClassification(failure)) {
          const recovered = await requestRecovery(failure);
          if (recovered.performed) continue;
        }
        await attention(failure);
        // A person may be able to complete a security checkpoint in this same live
        // browser. The hook only observes and waits: it answers nothing, fills
        // nothing, and never changes proxy or browser identity. When no hook is
        // supplied the previous behaviour (stop this account) is unchanged.
        const paused = requestHumanCheckpoint
          ? await requestHumanCheckpoint({ reason: failure, page, browser, account, site, snapshot, step, onStep })
          : null;
        if (paused?.resumed) {
          // Time spent waiting for a person must not consume the login budget.
          deadline += Number(paused.waitedMs) || 0;
          continue;
        }
        throw new PilotError(failure);
      }
    }
    if (!account.totp && snapshot.controls.some(control => /one-time-code|totp|verificationcode|security.code/i.test(
      `${control.autocomplete} ${control.name}`))) throw new PilotError('totp_secret_missing');
    const actions = browser.candidates(snapshot, { verifyOnly });
    // Google post-auth interstitials (for example a missing birthday) can lack
    // data we do not have. If one appears after authentication, check whether
    // the destination service itself is already usable before giving up.
    if (!actions.length && !verifyOnly && !interstitialBypassed
      && new URL(snapshot.url).origin === 'https://myaccount.google.com'
      && new URL(snapshot.url).pathname.includes('/interstitials/')) {
      interstitialBypassed = true;
      await onStep({ step, phase: 'login', action: 'bypass_interstitial', state: 'before' });
      await navigate(page, site.homeUrl);
      continue;
    }
    if (!actions.length) {
      // Zero valid actions is the classic unexpected state: an unfamiliar page,
      // a re-render mid-flight, or a control that disappeared. Recovery is tried
      // before a person is asked.
      const recovered = await requestRecovery(null);
      if (recovered.performed) continue;
    }
    if (!actions.length) await attention(verifyOnly ? 'session_or_identity_not_verified' : 'unsupported_login_screen');
    requireThat(actions.length > 0, verifyOnly ? 'session_or_identity_not_verified' : 'unsupported_login_screen');
    let decision;
    try { decision = await choose({ page: browser.publicPage(snapshot), actions: actions.map(({ id, description }) => ({ id, description })) }); }
    catch (error) { await attention(error instanceof PilotError ? error.code : 'selection_failed'); throw error; }
    const action = actions.find(candidate => candidate.id === decision.action?.id);
    requireThat(action, 'unknown_selected_action');
    await onStep({ step, phase: verifyOnly ? 'verify_reopen' : 'login', action: action.kind,
      method: decision.method, confidence: decision.confidence, probability: decision.probability, state: 'before' });
    try {
      // The ONLY path to a browser operation: BrowserAction -> workflow
      // authorization -> decision-epoch freshness -> receipt (created BEFORE
      // dispatch) -> the existing executor -> postcondition. A fill carries a
      // valueRef, never a value.
      await kernel.execute({ candidate: action, snapshot, observation,
        source: decisionSourceFor(decision), justification: decision.reason || null,
        dispatch: async ({ action: browserAction }) => {
          await browser.execute({ ...action, valueRef: browserAction.valueRef }, snapshot);
          if (action.kind.startsWith('fill_')) return null;
          return browser.waitForChange(snapshot, action);
        } });
    } catch (error) {
      // Single-page apps replace controls mid-render; a stale target simply
      // means the observation aged out, so re-observe rather than fail the run.
      if (['stale_control', 'stale_page', 'stale_observation', 'expired_observation'].includes(error?.code)) {
        await onStep({ step, phase: verifyOnly ? 'verify_reopen' : 'login', action: action.kind, state: 'stale' });
        continue;
      }
      const current = await browser.observe().catch(() => null);
      if (current) await onStep({ step, phase: 'attention', reason: error instanceof PilotError ? error.code : 'browser_action_failed', page: browser.publicPage(current), network });
      throw error;
    }
    await onStep({ step, phase: verifyOnly ? 'verify_reopen' : 'login', action: action.kind, state: 'after' });
    recentActions.push({ step, action: action.kind, method: decision.method, via: 'deterministic' });
  }
  throw new PilotError('login_step_budget_exceeded');
  } catch (error) {
    // Counters travel with the failure so the job report can show how much
    // recovery was attempted before the run stopped.
    if (error && typeof error === 'object') {
      error.recovery = { ...browser.recovery, menuActions: browser.menuActionCount };
    }
    throw error;
  } finally {
    page.off('response', responseListener); page.off('requestfailed', failureListener);
  }
}
