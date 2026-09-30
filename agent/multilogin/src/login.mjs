import { createHash } from 'node:crypto';
import { PilotError, requireThat, navigationError, accountId, createRedactor } from './core.mjs';
import { maxRecoverySteps, recoveryObservation, recoveryCandidates, validateRecoveryDecision,
  executeRecoveryAction } from './recovery.mjs';
import { BrowserExecutionKernel, decisionSourceFor } from './execution.mjs';
import { createValueResolver, valueRefForOperation } from './secrets.mjs';
import { attachObservation } from './observation.mjs';
import { installDialogGuard } from './dialog-containment.mjs';
import { readOutlookVerificationCode } from './mailbox-code.mjs';

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
  // Consumer Microsoft accounts: sign-in is on login.live.com, the signed-in
  // mailbox is on outlook.live.com. Credentials may only be typed on the
  // sign-in origin; the mailbox and the Office redirects are navigation-only.
  outlook: {
    loginUrl: 'https://login.live.com/',
    homeUrl: 'https://outlook.live.com/mail/0/',
    // The Microsoft account portal is the stable signed-in surface (the mailbox
    // hand-off is a client-side redirect that can bounce under automation); it is
    // used for session re-verification.
    sessionUrl: 'https://account.microsoft.com/',
    origins: ['https://login.live.com', 'https://outlook.live.com', 'https://outlook.office.com',
      'https://login.microsoftonline.com', 'https://account.live.com', 'https://account.microsoft.com',
      // Consumer Microsoft sessions are regularly handed off to these
      // navigation-only origins before the mailbox settles.
      'https://www.office.com', 'https://www.microsoft365.com', 'https://www.msn.com',
      'https://www.microsoft.com', 'https://outlook.office365.com', 'https://login.microsoft.com',
      // The account portal's Outlook tile links to outlook.com, which then
      // hands the session to outlook.live.com.
      'https://outlook.com', 'https://www.outlook.com'],
    credentialOrigins: ['https://login.live.com'],
  },
  // LinkedIn signs in on its own origin and then shows the member feed. No
  // third-party credential origin is ever allowed.
  linkedin: {
    loginUrl: 'https://www.linkedin.com/login',
    homeUrl: 'https://www.linkedin.com/feed/',
    origins: ['https://www.linkedin.com', 'https://linkedin.com'],
    credentialOrigins: ['https://www.linkedin.com', 'https://linkedin.com'],
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

// Reversible-navigation links (YouTube's masthead "Sign in", "try another way")
// are occasionally covered by an SPA overlay that swallows the pointer event,
// so Playwright's actionability check times out while the link itself is valid.
// The control has just been re-read (tag/label/href verified) before this call,
// so the fallback navigates to that same href provided its origin is already an
// allowed credential origin. It never resolves a secret and never touches an
// origin the site does not already allow; the caller's waitForChange still has
// to observe the resulting page change.
export const navigationFallbackKinds = new Set(['open_login', 'try_another_way']);

// YouTube's cookie-consent interstitial ("Before you continue to YouTube") is
// not a login screen and not a security control. A person simply clicks its own
// reject/accept button, so the same deterministic click is legitimate automated
// navigation: no cookie is fabricated and no challenge is answered. The dialog's
// buttons are clicked by accessible name because the overlay's controls can be
// absent from the generic control snapshot.
export const consentButtonPatterns = [
  /^(reject all|odrzuć wszystko|odrzuc wszystko|reject optional cookies|decline optional cookies)$/i,
  /^(accept all|zaakceptuj wszystko|akceptuję wszystko|zaakceptuj wszystkie|i agree)$/i,
];

export function isConsentScreen(snapshot) {
  const url = snapshot?.url || '';
  let origin = '';
  try { origin = new URL(url).origin; } catch { return false; }
  if (origin !== 'https://www.youtube.com') return false;
  const text = String(snapshot?.text || '').toLowerCase();
  return /before you continue to youtube|zanim przejdziesz do youtube|przed kontynuowaniem/.test(text);
}

// Google post-auth interstitials (birthday, recovery-info prompt, landing pages)
// are optional account-onboarding surfaces: a person can simply continue to the
// destination service. They are not security challenges and we must never fill
// recovery/account settings, so they are skipped by navigating home.
export function isPostAuthInterstitial(url) {
  try {
    const parsed = new URL(url);
    if (parsed.origin === 'https://myaccount.google.com') return parsed.pathname.includes('/interstitials/');
    if (parsed.origin === 'https://gds.google.com') return /^\/web\/(recoveryoptions|landing)/.test(parsed.pathname);
    return false;
  } catch { return false; }
}

export async function dismissConsent(page) {
  for (const pattern of consentButtonPatterns) {
    try {
      const locator = page.getByRole('button', { name: pattern }).first();
      await locator.waitFor({ state: 'visible', timeout: 2000 });
      await locator.click({ timeout: 5000 });
      return true;
    } catch { /* try the next label/fallback */ }
  }
  try {
    const fallback = page.locator('ytd-consent-bump-v2-lightbox button, tp-yt-paper-dialog button')
      .filter({ hasText: /reject all|odrzuć wszystko|accept all|zaakceptuj wszystko/i }).first();
    await fallback.waitFor({ state: 'visible', timeout: 2000 });
    await fallback.click({ timeout: 5000 });
    return true;
  } catch { return false; }
}

// A page can expose the same link twice (YouTube's signed-out home has a
// masthead "Sign in" and a body "Sign in" pointing at the same Google
// destination). Identical destinations are one capability, not two choices:
// collapsing them keeps the deterministic single-match shortcut instead of
// buying a model call that has nothing to distinguish. Only links with a
// non-empty href are collapsed, and only when kind + origin + path match.
export function dedupeLinkActions(actions) {
  const seen = new Set();
  return actions.filter(action => {
    const href = action?.control?.href;
    if (!href) return true;
    let destination = null;
    try { const url = new URL(href); destination = `${action.kind}|${url.origin}${url.pathname}`; } catch { return true; }
    if (seen.has(destination)) return false;
    seen.add(destination);
    return true;
  });
}

export async function clickWithNavigationFallback({ kind, control, current, site, page, clickTimeoutMs = 5000,
  fallbackTimeoutMs = 20000 } = {}) {
  const generous = navigationFallbackKinds.has(kind) || kind === 'submit_login' || kind === 'dismiss_cookies';
  try {
    await control.handle.click({ timeout: generous ? clickTimeoutMs + 3000 : clickTimeoutMs, noWaitAfter: true });
    return { method: 'click' };
  } catch (error) {
    const href = current?.href || '';
    let allowed = false;
    try { allowed = Boolean(href) && site.credentialOrigins.includes(new URL(href).origin); } catch { allowed = false; }
    if (navigationFallbackKinds.has(kind) && allowed) {
      await page.goto(href, { waitUntil: 'domcontentloaded', timeout: fallbackTimeoutMs });
      return { method: 'href_navigation', hrefOrigin: new URL(href).origin };
    }
    // Google's "Next" button can sit under a transient "Loading" overlay that
    // swallows the pointer event. The control was verified visible/enabled and
    // its signature was just re-read, so press Enter with the button focused —
    // exactly the keyboard path a person would use when the pointer is blocked.
    if (kind === 'submit_login') {
      try {
        await control.handle.focus({ timeout: 2000 });
        await page.keyboard.press('Enter');
        return { method: 'keyboard_submit' };
      } catch { throw error; }
    }
    throw error;
  }
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
  if (/captcha|verify you are human|confirm you.re human|unusual traffic|unusual activity|automated queries|quick security check/.test(text)
    || snapshot.challengeFrame) return 'human_verification_required';
  if (/check your phone|tap yes on|approve.{0,25}(phone|device)|security key|passkey/.test(text)
    && !/authenticator|authentication app/.test(text)) return 'device_verification_required';
  if (/(emailed|email|sent|send).{0,40}code|code.{0,60}(sent|email|sms)|text message/.test(text)
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
  const origin = new URL(snapshot.url).origin;
  // Outlook accepts its own account portal as a signed-in surface in addition to
  // the mailbox; every other platform verifies on its home origin only.
  const allowedOrigins = account.platform === 'outlook'
    ? [new URL(site.homeUrl).origin, 'https://account.microsoft.com', 'https://account.live.com']
    : [new URL(site.homeUrl).origin];
  if (!allowedOrigins.includes(origin)) return false;
  if (snapshot.controls.some(control => control.type === 'password')) return false;
  const username = account.username.toLowerCase();
  if (account.platform === 'instagram') {
    const paths = snapshot.controls.filter(control => control.href).map(control => {
      try { const url = new URL(control.href); return url.origin === new URL(site.homeUrl).origin ? url.pathname.toLowerCase() : ''; }
      catch { return ''; }
    });
    return paths.includes(`/${username}/`) && paths.some(path => path.startsWith('/direct/inbox'));
  }
  // Outlook: the signed-in Microsoft account surface. The mailbox hand-off is a
  // client-side redirect that can bounce under automation, so the portal itself
  // is accepted when the account surface names the expected identity. The email
  // is often not rendered as text, so the account-manager control (which carries
  // the display name derived from the account's own address) is accepted too.
  // A page that still offers a password field is never a signed-in surface.
  if (account.platform === 'outlook') {
    const mailboxOrigin = new URL(site.homeUrl).origin;
    const text = snapshot.text.toLowerCase();
    const localPart = username.split('@')[0];
    // The display name heuristic needs the ORIGINAL casing: ShawnteLaden13841 ->
    // "Shawnte Laden". The lowercased local part is used for text matching only.
    const displayName = account.username.split('@')[0].replace(/\d+$/, '')
      .replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase();
    const labelMatch = snapshot.controls.some(control => {
      const label = normalize(control.label);
      return label.includes(localPart) || (displayName.length >= 6 && label.includes(displayName));
    });
    const identity = text.includes(username) || (localPart.length >= 6 && text.includes(localPart)) || labelMatch;
    const accountSurface = /(sign out|wyloguj)/.test(text)
      || snapshot.controls.some(control => /account manager/i.test(normalize(control.label)));
    const mailboxSurface = origin === mailboxOrigin
      ? /(inbox|new mail|skrzynka odbiorcza|nowa wiadomość)/.test(text) : true;
    return accountSurface && mailboxSurface && identity && !/enter password|hasło/.test(text);
  }
  // LinkedIn: the member feed's own navigation. A logged-out page offers
  // "Join now"/"Sign in" instead, which disqualifies it.
  if (account.platform === 'linkedin') {
    const text = snapshot.text.toLowerCase();
    return /start a post|rozpocznij post/.test(text)
      && /my network|sieć/.test(text)
      && !/join now|dołącz teraz/.test(text)
      && !/sign in to linkedin|zaloguj się/.test(text);
  }
  // Account-menu evidence, not a public channel name or the model's completion judgment.
  const text = snapshot.text.toLowerCase();
  const emails = [...new Set(text.match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/g) || [])];
  return emails.length === 1 && emails[0] === username && /sign out|wyloguj/.test(text)
    && /switch account|przełącz konto|google account|konto google|add account|dodaj konto/.test(text)
    && !/choose an account|wybierz konto/.test(text);
}

// Known post-auth Microsoft surfaces that may appear between sign-in and the
// mailbox. Navigation only; credentials are still restricted to login.live.com.
// login.live.com is deliberately absent: it is the auth hand-off itself and
// must be allowed to finish.
export const microsoftPostAuthOrigins = new Set(['https://www.microsoft.com', 'https://www.office.com',
  'https://www.microsoft365.com', 'https://www.msn.com']);

// A signed-in Microsoft account portal page: the expected address (or its local
// part) plus a sign-out control. Masked addresses (s•••@hotmail.com) never match,
// so a pending verification screen is not mistaken for a session.
export function isMicrosoftPortalSignedIn(account, snapshot) {
  let origin = null;
  try { origin = new URL(snapshot.url).origin; } catch { return false; }
  if (!['https://account.microsoft.com', 'https://account.live.com'].includes(origin)) return false;
  const text = String(snapshot.text || '').toLowerCase();
  const username = account.username.toLowerCase();
  const localPart = username.split('@')[0];
  const identity = text.includes(username) || (localPart.length >= 6 && text.includes(localPart));
  return identity && /(sign out|wyloguj)/.test(text);
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
  constructor(page, account, { site = sites[account.platform], secrets = null,
    ttlMs = 15000, now = Date.now } = {}) {
    this.page = page; this.account = account; this.site = site;
    // How long an observation stays usable, and the clock it is measured with.
    this.ttlMs = ttlMs; this.now = now;
    // Trusted secret indirection: the flow names account_username,
    // account_password, current_totp ... and only this object resolves them,
    // only at fill time, and never towards a model, receipt or log.
    this.secrets = secrets || createValueResolver({ account });
    // Trusted code hands a mailbox-fetched code to the resolver for this run only.
    this.setVerificationCode = value => this.secrets.setVerificationCode?.(value);
    this.verificationCodeAvailable = () => this.secrets.verificationCodeAvailable?.() === true;
    this.mailboxCodeTried = false;
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
  // A Microsoft/SPA redirect can replace the document while a handle is being
  // evaluated; that is a transient navigation race, not a login failure, so a
  // bounded retry re-observes instead of killing the run.
  async observe() {
    let lastError = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      try { return await this.observeOnce(); }
      catch (error) {
        lastError = error;
        if (error instanceof PilotError) throw error;
        if (attempt === 2 || (!error?.transient && !/execution context was destroyed|target closed|frame was detached|navigation|detached from/i.test(String(error?.message || '')))) throw error;
        await new Promise(resolve => setTimeout(resolve, 250 * (attempt + 1)));
      }
    }
    throw lastError;
  }

  async observeOnce() {
    const url = this.page.url();
    const origin = (() => { try { return new URL(url).origin; } catch { return null; } })();
    // A navigation can leave the page on an empty/about:blank URL for a moment;
    // that is transient, not an unknown destination, and is retried above.
    if (!origin) {
      const error = new Error('transient_page_url');
      error.transient = true;
      throw error;
    }
    // The destination origin is part of the diagnostic so an unknown hand-off
    // can be allow-listed deliberately; it is never a credential or a path.
    requireThat(this.site.origins.includes(origin), `unexpected_login_destination:${origin}`);
    for (const handle of this.ownedHandles) await handle.dispose().catch(() => {});
    const handles = await this.page.$$('input,button,a,[role="button"],[role="link"],[role="option"],[role="listitem"],[role="menuitem"],[data-challengeid],[data-challengetype],[jsaction][tabindex="0"],tp-yt-paper-item'); this.ownedHandles = handles;
    const controls = [];
    for (const handle of handles.slice(0, 300)) {
      if (!await handle.isVisible().catch(() => false)) continue;
      const control = await handle.evaluate(element => ({
        tag: element.tagName.toLowerCase(), type: element.getAttribute('type') || '',
        name: element.getAttribute('name') || element.id || '',
        label: element.getAttribute('aria-label') || [...(element.labels || [])].map(label => label.innerText).join(' ')
          || element.getAttribute('placeholder') || element.innerText?.slice(0, 180) || element.querySelector('img')?.alt
          || (element.tagName === 'INPUT' && ['submit', 'button', 'reset'].includes(element.type) ? element.value : '') || '',
        autocomplete: element.getAttribute('autocomplete') || '',
        role: element.getAttribute('role') || '',
        href: element.tagName === 'A' ? element.href : '',
        formAction: element.form ? element.form.action : '',
        required: Boolean(element.required),
        enabled: !element.disabled && !element.readOnly && element.getAttribute('aria-disabled') !== 'true',
      }));
      control.key = signature(control); control.handle = handle; controls.push(control);
    }
    // A stalled or restored-blank tab can exceed the body read timeout; an empty
    // text is a valid observation (the loop's patience window retries) and must
    // not kill the run with an unclassified error.
    const text = (await this.page.locator('body').innerText({ timeout: 5000 }).catch(() => '')).slice(0, 14000);
    const challengeFrame = await this.page.locator('iframe[src*="recaptcha"],iframe[src*="hcaptcha"],iframe[src*="challenges.cloudflare.com"]').count() > 0;
    const snapshot = { url, controls, text, challengeFrame };
    snapshot.fingerprint = createHash('sha256').update(JSON.stringify([url, text, controls.map(control => control.key)])).digest('hex');
    // Reset fill tracking only after navigation or a genuinely new set of fields.
    const documentKey = JSON.stringify([url, controls.filter(control => control.tag === 'input').map(control => control.key)]);
    if (this.documentKey !== documentKey) { this.filled.clear(); this.documentKey = documentKey; }
    // The live path emits the shared observation contract: every control carries
    // an id scoped to this observation's epoch, and the epoch is what execution
    // must quote back.
    attachObservation({ snapshot, ttlMs: this.ttlMs, now: this.now() });
    return snapshot;
  }
  candidates(snapshot, { verifyOnly = false } = {}) {
    let actions = []; const fieldActions = []; let unknownRequiredField = false; let unhandledField = false;
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
          else if (this.verificationCodeAvailable()) kind = 'fill_verification_code';
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
      if (/^(reject all|reject optional cookies|reject|decline optional cookies|only allow essential cookies|odrzuć wszystkie|odrzuć opcjonalne pliki cookie)$/.test(label)) kind = 'dismiss_cookies';
      if (this.account.platform === 'youtube' && /^(account|account menu|avatar image|google account: .+|konto|menu konta)$/.test(label)) kind = 'open_account_menu';
      if (this.account.platform === 'youtube' && /^(switch account|przełącz konto)$/.test(label)) kind = 'open_switch_account';
      // Outlook's account manager flyout is where the exact address and the sign
      // out control appear; LinkedIn's "Me" menu is the signed-in account entry.
      if (this.account.platform === 'outlook' && /^(account manager.*|account|my account|moje konto)$/.test(label)) kind = 'open_account_menu';
      if (this.account.platform === 'linkedin' && /^(me|me menu|account|my account|moje konto)$/.test(label)) kind = 'open_account_menu';
      // The Microsoft account portal's own Outlook tile performs the SSO
      // hand-off into the mailbox; it is the site's intended navigation path.
      // Only links with an href are offered: the executor navigates that href in
      // the same tab instead of clicking (the tile often targets a new tab).
      if (this.account.platform === 'outlook' && control.tag === 'a' && control.href
        && /^(open )?outlook(\.com)?$/.test(label)) kind = 'open_outlook';
      // Microsoft's post-sign-in convenience prompt. Clicking Yes keeps the
      // session, which is exactly the session this job is establishing; it is a
      // login-flow step, never a security control.
      if (!verifyOnly && authOrigin && /^(yes|tak)$/.test(label)
        && /stay signed in|pozostań zalogowany/.test(normalize(snapshot.text))) kind = 'stay_signed_in';
      if (!verifyOnly && authOrigin && !unknownRequiredField && fieldActions.length === 0
        && !this.submittedStages.has(fieldStage(snapshot))
        && /^(log in|login|sign in|next|continue|confirm|verify|i agree|accept|zaloguj się|dalej|kontynuuj|potwierdź)$/.test(label)) kind = 'submit_login';
      // LinkedIn's suspicious-login check asks you to SEND the code first; that
      // is the platform's own step and it delivers to the account's own inbox.
      // Scoped to the challenge text so a generic "Send" button elsewhere is
      // never touched.
      if (!verifyOnly && authOrigin && this.account.platform === 'linkedin'
        && /^(wyślij|wyslij|send|send code|wyślij kod|wyślij ponownie|resend|send again|send a new code)$/.test(label)
        && /weryfikacj|verification code|podejrzan|suspicious/i.test(normalize(snapshot.text))) kind = 'submit_login';
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
    actions = dedupeLinkActions(actions);
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
    // The portal's Outlook tile is the SSO hand-off; it outranks a menu toggle
    // that only reveals identity evidence.
    const outlookActions = actions.filter(action => action.kind === 'open_outlook');
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
      : outlookActions.length ? outlookActions.slice(0, 1)
      : switchActions.length ? switchActions.slice(0, 1)
      : menuActions.length ? menuActions.slice(0, 1)
      : actions;
    // The decision payload names the REFERENCE a value would come from; the
    // value itself is never part of an observation, prompt or description.
    return permitted.slice(0, 80).map((action, index) => {
      const valueRef = valueRefForOperation[action.kind] || null;
      // Every candidate is stamped with the epoch it came from, the id that epoch
      // produced and the signature it was decided on; execution quotes all three.
      const binding = snapshot.observation
        ? { observationEpoch: snapshot.epoch, controlId: action.control.id,
          expectedControlSignature: action.control.key } : {};
      return { ...action, id: `a${index}`, valueRef, ...binding,
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
  async execute(action, snapshot, { decisionObservation = null } = {}) {
    requireThat(this.page.url() === snapshot.url, 'stale_page');
    const { control, kind } = action;
    // Epoch binding. A live observation may only be acted on by an action that
    // quotes the epoch, the control id that epoch produced and the signature it
    // was decided on. `decisionObservation` is the epoch the decision came from
    // when execution is looking at a newer one; without it, the epoch must match.
    if (snapshot.observation || action.observationEpoch !== undefined || action.controlId !== undefined) {
      const live = snapshot.observation || null;
      requireThat(live, 'observation_required');
      requireThat(action.observationEpoch, 'observation_epoch_required');
      requireThat(action.controlId, 'control_id_required');
      requireThat(action.expectedControlSignature, 'expected_control_signature_required');
      requireThat(control.id === action.controlId && control.epoch === live.epoch, 'stale_observation');
      requireThat(this.now() < live.expiresAt, 'expired_observation');
      const decided = decisionObservation || live;
      requireThat(action.observationEpoch === decided.epoch, 'stale_observation');
      requireThat(this.now() < decided.expiresAt, 'expired_observation');
    }
    requireThat(await control.handle.isVisible() && await control.handle.isEnabled(), 'stale_control');
    const current = await control.handle.evaluate(element => ({
      tag: element.tagName.toLowerCase(), type: element.getAttribute('type') || '',
      name: element.getAttribute('name') || element.id || '',
      label: element.getAttribute('aria-label') || [...(element.labels || [])].map(label => label.innerText).join(' ')
        || element.getAttribute('placeholder') || element.innerText?.slice(0, 180) || element.querySelector('img')?.alt
        || (element.tagName === 'INPUT' && ['submit', 'button', 'reset'].includes(element.type) ? element.value : '') || '',
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
    if (kind === 'type_observed') {
      // Operator-supplied text reaches the page only through a resolved reference,
      // and only on an origin this site already allows.
      requireThat(this.site.origins.includes(new URL(this.page.url()).origin), 'unexpected_login_destination');
      requireThat(action.valueRef, 'value_ref_required');
      const value = await this.secrets.resolve(action.valueRef);
      await control.handle.fill(value, { timeout: 5000 }); return;
    }
    if (kind === 'open_outlook') {
      // The portal's Outlook tile is often a target=_blank link; navigating its
      // own allowed href keeps the session in THIS page instead of spawning a tab
      // the flow cannot see.
      const href = control.href || action.destination || null;
      requireThat(href, 'outlook_link_missing');
      const destination = new URL(href).origin;
      requireThat(this.site.origins.includes(destination), 'unexpected_navigation_destination');
      await this.page.goto(href, { waitUntil: 'domcontentloaded', timeout: 30000 });
      return;
    }
    requireThat(['submit_login', 'open_login', 'choose_totp', 'try_another_way', 'dismiss_cookies',
      'open_account_menu', 'open_switch_account', 'click_observed', 'stay_signed_in'].includes(kind),
    'unsupported_action');
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
    await clickWithNavigationFallback({ kind, control, current, site: this.site, page: this.page });
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

// One compact causal episode per correction: the action that did not move the
// page, and the action that did. Only a fingerprint change is recorded; page
// text, credentials and query strings never are.
async function rememberCorrection({ memory, browser, account, snapshot, classifiedReason, action, scope }) {
  const after = await browser.observe().catch(() => null);
  const changed = Boolean(after && after.fingerprint !== snapshot.fingerprint);
  if (!changed) { browser.recovery.lastFailedAction = action.kind; return null; }
  const failedAction = browser.recovery.lastFailedAction || null;
  browser.recovery.lastFailedAction = null;
  const match = memory.observeCorrection?.({ correction: action.kind }) || { matchedRecall: false };
  let statePath = null;
  try { const url = new URL(snapshot.url); statePath = `${url.origin}${url.pathname}`; } catch {}
  return memory.record({ reason: classifiedReason || 'unexpected_state', statePath, failedAction,
    correction: action.kind, verification: 'page_changed', platform: account.platform,
    jobId: scope?.jobId || null, memoryMatched: match.matchedRecall === true });
}

export async function runLogin({ page, account, choose, maxSteps = 20, maxSeconds = 180,
  verifyOnly = false, onStep = async () => {}, requestHumanCheckpoint = null, site = sites[account.platform],
  goal = defaultLoginGoal, recoveryBudget = maxRecoverySteps, readyWindowMs = 15000,
  receipts = null, scope = null, recoveryMemory = null, startUrl = null, requestMailboxCode = null }) {
  const browser = new LoginBrowser(page, account, { site });
  // A stale dialog race must never kill the process (ported canary guard): the
  // dismissal happens inside the guard and is journalled as a diagnostic.
  const dialogGuard = typeof page.on === 'function'
    ? installDialogGuard(page, { onDiagnostic: async detail => { try { await onStep({ phase: 'dialog', ...detail }); } catch {} } })
    : null;
  // The single execution path for this run. The deterministic flow and the Jev
  // recovery episode both go through it; nothing else performs a browser
  // operation. Roles come from this workflow, never from a model.
  const kernel = new BrowserExecutionKernel({
    browser, account, site, workflow: 'login', runId: `login-${accountId(account)}`,
    observe: () => browser.observe(),
    identityVerified: snapshot => verifyIdentity(account, snapshot, site),
    journal: async entry => onStep({ step: entry.step ?? null, phase: 'receipt', ...entry }),
    // A durable receipt is written before every dispatch when the caller supplies
    // a store, so a crash leaves evidence a restart can reconcile read-only.
    receipts, scope,
  });
  let interstitialBypassed = false;
  let homeRefreshed = false;
  // Microsoft post-auth hand-offs are normalised to the mailbox, at most twice
  // per run, so an unexpected redirect cannot ping-pong.
  let microsoftPortalRedirects = 0;
  // Recent deterministic actions, so a recovery observation carries context
  // without ever carrying page content that is not already redacted.
  const recentActions = [];
  // Page states that already consumed a full patience window with no usable
  // controls, so they are not waited on again.
  const emptyFingerprints = new Set();
  // Visual escalations are capped for the whole run, so a vision advisor can never
  // be asked to look more than a handful of times.
  const visualEpisode = { escalations: 0 };
  const finish = result => {
    if (result.verified && recoveryMemory) recoveryMemory.markVerified().catch(() => {});
    return { ...result, visualEscalations: visualEpisode.escalations,
      recovery: { ...browser.recovery, menuActions: browser.menuActionCount } };
  };
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
  // The start surface is the cheapest authenticated-state check: for a YouTube
  // job the home page verifies an existing session directly and offers the
  // observed sign-in control when there is none. `verifyOnly` has always used it.
  await navigate(page, startUrl || (verifyOnly ? site.homeUrl : site.loginUrl));
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
    // A fresh profile lands on YouTube's cookie-consent interstitial before any
    // login control exists. Dismiss it deterministically (its own button), then
    // re-observe; credentials and TOTP stay automated. The consent text only
    // exists while the dialog is present, so this cannot loop on a cleared page.
    if (isConsentScreen(snapshot)) {
      const dismissed = await dismissConsent(page);
      await onStep({ step, phase: 'login', action: 'dismiss_consent', state: dismissed ? 'after' : 'failed' });
      await new Promise(resolve => setTimeout(resolve, 500));
      continue;
    }
    // A verification code emailed to the account's own Microsoft mailbox: read
    // it (read-only, bounded) and fill it rather than asking a person. This runs
    // once per run, only when the page actually shows a code field.
    const codeField = snapshot.controls.some(control => control.tag === 'input'
      && (/code|pin|otp|verification/i.test(`${control.name} ${control.autocomplete} ${control.label}`)
        // LinkedIn's challenge inputs carry obfuscated names: the challenge text
        // plus any visible free-text input is the code field.
        || (account.platform === 'linkedin' && ['text', 'tel', 'number', ''].includes(control.type)
          && /weryfikacj|verification code|podejrzan|suspicious|wpisz kod/i.test(normalize(snapshot.text)))));
    if (codeField && !account.totp && requestMailboxCode && !browser.mailboxCodeTried) {
      browser.mailboxCodeTried = true;
      const fetched = await requestMailboxCode({ platform: account.platform, page }).catch(() => null);
      if (fetched?.code) {
        browser.setVerificationCode(fetched.code);
        await onStep({ step, phase: 'login', action: 'mailbox_code', state: 'after',
          verification: 'code_from_mailbox' });
        continue;
      }
      await onStep({ step, phase: 'login', action: 'mailbox_code', state: 'failed',
        reason: fetched?.reason || 'no_matching_code' });
    }
    // The decision and its execution share ONE observation epoch: every control
    // id below is only meaningful against this epoch.
    const observation = kernel.observe(snapshot).observation;
    if (verifyIdentity(account, snapshot, site)) {
      return finish({ verified: true, steps: step, durationMs: Math.round(performance.now() - started) });
    }
    // Microsoft can land a signed-in session anywhere in its account portal.
    // When the portal shows the expected identity, or the page is a known
    // post-auth Microsoft surface with no password field and no classified
    // challenge, the flow continues to the mailbox the job is actually about.
    // Navigation only: no credential, consent or challenge is involved.
    const portalOrigin = (() => { try { return new URL(snapshot.url).origin; } catch { return null; } })();
    const microsoftPortal = account.platform === 'outlook'
      && (isMicrosoftPortalSignedIn(account, snapshot) || microsoftPostAuthOrigins.has(portalOrigin));
    // The portal's own Outlook tile is the intended SSO hand-off; when it is
    // present the flow must use it instead of a direct mailbox navigation.
    const hasOutlookHandoff = account.platform === 'outlook' && snapshot.controls.some(control => {
      if (control.tag !== 'a' || !control.href) return false;
      if (!/^(open )?outlook(\.com)?$/.test(normalize(control.label))) return false;
      try { return site.origins.includes(new URL(control.href).origin); } catch { return false; }
    });
    if (!verifyOnly && microsoftPortal && !hasOutlookHandoff && !classifyPage(snapshot)
      && !snapshot.controls.some(control => control.type === 'password') && microsoftPortalRedirects < 1) {
      microsoftPortalRedirects++;
      await onStep({ step, phase: 'login', action: 'navigate_home', state: 'before', reason: 'post_auth_portal' });
      await navigate(page, site.homeUrl);
      await onStep({ step, phase: 'login', action: 'navigate_home', state: 'after' });
      step++;
      continue;
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
      // Compact causal hints: at most a couple of past corrections relevant to
      // this state. No transcripts, no page content, no credentials.
      const memoryHints = recoveryMemory
        ? await recoveryMemory.hints({ reason: classifiedReason || 'unexpected_state', url: snapshot.url,
          failedAction: browser.recovery.lastFailedAction || null, limit: 2 }).catch(() => [])
        : [];
      const modelView = recoveryObservation({ goal, snapshot, browser, recentActions,
        deterministicState: { step, classifiedReason: classifiedReason || null, verifyOnly,
          menuOpenedBefore: browser.menuOpenedKeys.size > 0 },
        memory: memoryHints });
      let decision;
      try {
        decision = await choose({ page: modelView, observation, snapshot, livePage: page,
          classifiedReason: classifiedReason || null, episode: visualEpisode, phase: 'jev_recovery', step,
          actions: candidates.map(({ id, description }) => ({ id, description })) });
      } catch (error) {
        await onStep({ step, phase: 'jev_recovery', state: 'selection_failed',
          reason: classifiedReason || 'no_actions',
          detail: error instanceof PilotError ? error.code : 'selection_failed' });
        return { failed: true };
      }
      // The advisor chain (or frontier vision) may conclude a person is required.
      // That ends the recovery episode; the caller requests a real checkpoint.
      if (decision?.humanVerificationRequired === true) {
        await onStep({ step, phase: 'jev_recovery', state: 'human_required',
          reason: decision.reason || 'frontier_requested_human' });
        return { exhausted: true };
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
      if (outcome.performed) {
        recentActions.push({ step, action: action.kind, via: 'jev_recovery' });
        if (recoveryMemory) await rememberCorrection({ memory: recoveryMemory, browser, account, snapshot,
          classifiedReason, action, scope }).catch(() => {});
      }
      return outcome;
    };
    const failure = classifyPage(snapshot);
    if (failure) {
      // A mailbox-backed code challenge: the page may first offer the platform's
      // own "send code" control. With a mailbox reader available, let the normal
      // deterministic candidates click it and fill the code on the next
      // observation instead of routing straight to recovery/checkpoint.
      const mailboxFlow = failure === 'email_or_sms_verification_required' && requestMailboxCode && !account.totp
        && snapshot.controls.some(control => control.enabled
          && /^(wyślij|wyslij|send|send code|wyślij kod|wyślij ponownie|resend|send again|send a new code)$/.test(normalize(control.label)));
      // An email/SMS or device challenge may still offer a path to the
      // authenticator method we can complete; use the escape before stopping.
      const escape = !mailboxFlow
        && ['email_or_sms_verification_required', 'device_verification_required'].includes(failure)
        && account.totp && browser.candidates(snapshot, { verifyOnly })
          .some(action => action.kind === 'choose_totp' || action.kind === 'try_another_way');
      if (!mailboxFlow && !escape) {
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
      `${control.autocomplete} ${control.name}`))) {
      // The code was emailed to the account's own mailbox: read it there first
      // (same authenticated profile), fill it, and let the normal flow submit.
      // Reading is bounded and read-only; nothing is clicked, sent or deleted.
      if (requestMailboxCode && !browser.mailboxCodeTried) {
        browser.mailboxCodeTried = true;
        const fetched = await requestMailboxCode({ platform: account.platform, page }).catch(() => null);
        if (fetched?.code) {
          browser.setVerificationCode(fetched.code);
          await onStep({ step, phase: 'login', action: 'mailbox_code', state: 'after',
            verification: 'code_from_mailbox' });
          continue;
        }
        await onStep({ step, phase: 'login', action: 'mailbox_code', state: 'failed',
          reason: fetched?.reason || 'no_matching_code' });
      }
      // A code we do not hold (or could not read) is a genuine human checkpoint.
      const reason = 'email_or_sms_verification_required';
      await onStep({ step, phase: 'attention', reason, page: browser.publicPage(snapshot) });
      const paused = requestHumanCheckpoint
        ? await requestHumanCheckpoint({ reason, page, browser, account, site, snapshot, step, onStep })
        : null;
      if (paused?.resumed) { deadline += Number(paused.waitedMs) || 0; continue; }
      throw new PilotError(reason);
    }
    const actions = browser.candidates(snapshot, { verifyOnly });
    // Google post-auth interstitials (for example a missing birthday) can lack
    // data we do not have. If one appears after authentication, check whether
    // the destination service itself is already usable before giving up.
    if (!actions.length && !verifyOnly && !interstitialBypassed
      && isPostAuthInterstitial(snapshot.url)) {
      interstitialBypassed = true;
      await onStep({ step, phase: 'login', action: 'bypass_interstitial', state: 'before' });
      await navigate(page, site.homeUrl);
      continue;
    }
    // A signed-in YouTube home sometimes renders its shell (Home/Shorts/You)
    // before the masthead account-menu control exists. One bounded refresh is
    // the same thing a person does with a stalled page; it never changes
    // credentials, settings or identity. The signed-in-shell text keeps this
    // from interfering with menu/recovery fixtures.
    const signedInShell = /shorts/.test(String(snapshot.text || '').toLowerCase())
      && /subscriptions/.test(String(snapshot.text || '').toLowerCase())
      && !/sign in|zaloguj/.test(String(snapshot.text || '').toLowerCase());
    if (!actions.length && !verifyOnly && !homeRefreshed && signedInShell
      && new URL(snapshot.url).origin === new URL(site.homeUrl).origin) {
      homeRefreshed = true;
      await onStep({ step, phase: 'login', action: 'refresh_home', state: 'before' });
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
    // The decision carries the observation it was taken against, so an advisor can
    // bind a screenshot to this epoch and execution can refuse another one.
    try { decision = await choose({ page: browser.publicPage(snapshot), observation, snapshot, livePage: page,
      episode: visualEpisode, phase: verifyOnly ? 'verify_reopen' : 'login', step,
      actions: actions.map(({ id, description }) => ({ id, description })) }); }
    catch (error) { await attention(error instanceof PilotError ? error.code : 'selection_failed'); throw error; }
    if (decision?.episode) visualEpisode.escalations = decision.episode.escalations;
    // The advisor chain (or frontier vision) may conclude a person is required.
    // That is a checkpoint, never a crash and never a guessed action.
    if (decision?.humanVerificationRequired === true) {
      await attention('human_verification_required');
      const paused = requestHumanCheckpoint
        ? await requestHumanCheckpoint({ reason: 'human_verification_required', page, browser, account, site,
          snapshot, step, onStep })
        : null;
      if (paused?.resumed) { deadline += Number(paused.waitedMs) || 0; continue; }
      throw new PilotError('human_verification_required');
    }
    // An L3 decision taken on another epoch is never executed here.
    if (decision?.decisionEpoch && decision.decisionEpoch !== observation.epoch) {
      await onStep({ step, phase: verifyOnly ? 'verify_reopen' : 'login', state: 'stale_decision',
        decisionEpoch: decision.decisionEpoch, epoch: observation.epoch });
      continue;
    }
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
        // The kernel re-observed and re-resolved the control immediately before
        // this call, so the executor acts on the live handle and the live page.
        dispatch: async ({ action: browserAction, control: resolved, snapshot: liveSnapshot }) => {
          const target = liveSnapshot || snapshot;
          await browser.execute({ ...action, control: resolved || action.control,
            valueRef: browserAction.valueRef, observationEpoch: browserAction.observationEpoch,
            controlId: browserAction.controlId,
            expectedControlSignature: browserAction.expectedControlSignature }, target,
          { decisionObservation: observation });
          if (action.kind.startsWith('fill_')) return null;
          return browser.waitForChange(target, action);
        } });
    } catch (error) {
      // Single-page apps replace controls mid-render, and a live page can move on
      // between the decision and the dispatch; both simply mean the observation
      // aged out, so re-observe rather than fail the run.
      if (['stale_control', 'stale_page', 'stale_observation', 'expired_observation',
        'changed_page', 'changed_control', 'control_not_usable'].includes(error?.code)) {
        await onStep({ step, phase: verifyOnly ? 'verify_reopen' : 'login', action: action.kind, state: 'stale' });
        continue;
      }
      const current = await browser.observe().catch(() => null);
      if (current) await onStep({ step, phase: 'attention', reason: error instanceof PilotError ? error.code : 'browser_action_failed', page: browser.publicPage(current), network });
      throw error;
    }
    await onStep({ step, phase: verifyOnly ? 'verify_reopen' : 'login', action: action.kind, state: 'after' });
    recentActions.push({ step, action: action.kind, method: decision.method, via: 'deterministic' });
    // A performed action usually navigates: the next observation deserves a
    // fresh client-render patience window even if this fingerprint was already
    // seen (Google's redirects render an empty document first).
    emptyFingerprints.clear();
    // The account menu is client-rendered; without a bounded settle the next
    // observation can miss it and the deterministic policy would toggle the menu
    // closed again instead of verifying the identity inside it.
    if (['open_account_menu', 'open_switch_account'].includes(action.kind)) {
      await new Promise(resolve => setTimeout(resolve, 800));
    }
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
    dialogGuard?.dispose();
  }
}
