import { structured } from './vendor/mcp.mjs';
import { WorkerError, SESSION_ID } from './policy.mjs';

const clean = s => String(s || '').replace(/\s+/g, ' ').trim();
const isChallenge = s => /captcha|verify you are human|sprawdź, czy jesteś człowiekiem|access denied/i.test(s);
const fieldRules = [
  ['phone', /telefon|phone|mobile|numer komórkowy/i], ['email', /e-?mail/i],
  ['password', /hasło|password/i], ['otp', /kod (?:sms|weryfikacyjny)|verification code|one-time-code/i],
  ['first_name', /^imię$|given-name|first.?name/i], ['last_name', /nazwisko|family-name|last.?name/i],
];
function fieldKind(text, type) {
  if (type === 'tel') return 'phone';
  if (type === 'email') return 'email';
  if (type === 'password') return 'password';
  return fieldRules.find(([, pattern]) => pattern.test(text))?.[0] || 'unclassified';
}
function assertMerchant(snapshot) {
  let url; try { url = new URL(snapshot?.url); } catch { throw new WorkerError('merchant_page_unverified'); }
  if (url.origin !== 'https://delio.com.pl') throw new WorkerError('merchant_origin_mismatch');
  if ((snapshot.elements || []).some(e => isChallenge(clean(e.name)))) throw new WorkerError('merchant_challenge_required');
}

/** Export only a closed semantic vocabulary, never field values, free text or links. */
export function registrationStructure(snapshot, html = '') {
  assertMerchant(snapshot);
  const fields = [];
  for (const match of html.matchAll(/<input\b([^>]*)>/gi)) {
    const attrs = {};
    for (const attr of match[1].matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g)) attrs[attr[1].toLowerCase()] = attr[2] ?? attr[3] ?? attr[4];
    const type = String(attrs.type || 'text').toLowerCase();
    if (['hidden', 'submit', 'button', 'checkbox', 'radio'].includes(type) || attrs['aria-hidden'] === 'true') continue;
    const knownType = ['text', 'email', 'tel', 'password', 'number', 'search'].includes(type) ? type : 'other';
    fields.push({ ordinal: fields.length + 1, kind: fieldKind([attrs.placeholder, attrs['aria-label'], attrs.autocomplete, attrs.name].join(' '), type),
      inputType: knownType, required: /(?:^|\s)required(?:\s|=|$)/i.test(match[1]), source: 'scoped_form_markup' });
  }
  const controls = (snapshot.elements || []).filter(e => ['textbox', 'combobox'].includes(e.role));
  if (!fields.length) for (const control of controls) fields.push({ ordinal: fields.length + 1, kind: fieldKind(clean(control.name), ''),
    inputType: null, required: null, source: 'visible_snapshot' });
  const names = (snapshot.elements || []).filter(e => ['button', 'link', 'heading', 'checkbox'].includes(e.role)).map(e => clean(e.name));
  const combined = names.join(' ') + ' ' + html;
  return { fields: fields.slice(0, 20), fieldsTruncated: fields.length > 20,
    observedFieldOrder: [...new Set(fields.map(f => f.kind).filter(k => k !== 'unclassified'))],
    emailFieldObserved: fields.some(f => f.kind === 'email'), phoneFieldObserved: fields.some(f => f.kind === 'phone'),
    passwordFieldObserved: fields.some(f => f.kind === 'password'), otpFieldObserved: fields.some(f => f.kind === 'otp'),
    termsMentionObserved: /regulamin|terms and conditions/i.test(combined),
    privacyMentionObserved: /polityk[aię] prywatności|privacy policy/i.test(combined),
    registrationEntryObserved: names.some(n => /^(?:Zarejestruj się|Załóż konto|Rejestracja)$/i.test(n)),
    googleOptionObserved: names.some(n => /google/i.test(n)), appleOptionObserved: names.some(n => /apple/i.test(n)),
    accountCreated: false, otpRequested: false, fieldsFilled: false, termsAccepted: false,
    laterFieldOrderVerified: false };
}

export async function inspectRegistration({ client, check, remaining }) {
  let navigationClicks = 0;
  const call = async (name, args) => {
    check();
    const result = await client.call(name, { session_id: SESSION_ID, ...args }, { timeoutMs: Math.max(1, Math.min(5000, remaining())) });
    check(); return structured(result);
  };
  let snapshot = await call('browser_snapshot', { max_elements: 1000, interactive_only: false });
  assertMerchant(snapshot);
  let login = (snapshot.elements || []).filter(e => e.role === 'button' && clean(e.name) === 'Zaloguj się');
  for (let scan = 0; !login.length && scan < 5; scan++) {
    await new Promise(resolve => setTimeout(resolve, 200));
    snapshot = await call('browser_snapshot', { max_elements: 1000, interactive_only: false });
    assertMerchant(snapshot);
    login = (snapshot.elements || []).filter(e => e.role === 'button' && clean(e.name) === 'Zaloguj się');
  }
  if (!login.length) throw new WorkerError('registration_entry_missing');
  // A responsive page may expose both desktop/mobile copies in its snapshot.
  // Native strict matching must find exactly one visible button; never pick an
  // arbitrary index or relax the freshly observed exact name.
  const target = login.length === 1 ? { ref: login[0].ref } : { selector: 'button:visible:text-is("Zaloguj się")' };
  await call('browser_click', { ...target, timeout_ms: Math.max(1, Math.min(4000, remaining())) });
  navigationClicks++;
  async function readView() {
    let current, view, html = '';
    for (let scan = 0; scan < 5; scan++) {
      current = await call('browser_snapshot', { max_elements: 1000, interactive_only: false });
      assertMerchant(current);
      // A sign-in entry can navigate to a page rather than open a dialog. Scope
      // only when a dialog was actually observed; otherwise read the new page.
      const scope = (current.elements || []).some(e => e.role === 'dialog') ? { selector: '[role="dialog"]' } : {};
      const content = await call('browser_get_content', { ...scope, format: 'html', max_bytes: 120000 });
      html = typeof content.content === 'string' ? content.content : typeof content.html === 'string' ? content.html : typeof content.text === 'string' ? content.text : '';
      view = registrationStructure(current, html);
      if (view.phoneFieldObserved || view.emailFieldObserved || view.passwordFieldObserved || view.otpFieldObserved || view.registrationEntryObserved) break;
      if (scan < 4) await new Promise(resolve => setTimeout(resolve, 250));
    }
    return { snapshot: current, view };
  }
  let observed = await readView();
  snapshot = observed.snapshot;
  let result = observed.view;
  // Only a distinct observed link can open a second registration view. Never
  // click a submit button, enter values, accept checkboxes or request an OTP.
  const signup = (snapshot.elements || []).filter(e => e.role === 'link' && /^(?:Zarejestruj się|Załóż konto|Rejestracja)$/i.test(clean(e.name)));
  if (signup.length === 1 && !result.phoneFieldObserved && !result.otpFieldObserved) {
    await call('browser_click', { ref: signup[0].ref, timeout_ms: Math.max(1, Math.min(4000, remaining())) });
    navigationClicks++;
    observed = await readView();
    result = observed.view;
  }
  return { status: 'registration_inspected', ...result, navigationClicks,
    inspectionScope: 'Current sign-in/registration entry only; later fields require a separate authorized flow.',
    noCartOperationDispatched: true };
}
