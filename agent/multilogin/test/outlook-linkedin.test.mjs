import test from 'node:test';
import assert from 'node:assert/strict';
import { sites, verifyIdentity, classifyPage, LoginBrowser, isMicrosoftPortalSignedIn } from '../src/login.mjs';import { operationKinds, riskByOperation, defaultPostconditions } from '../src/execution.mjs';
import { validateJobs } from '../src/jobs.mjs';
import { parseAccounts } from '../src/core.mjs';

const outlookAccount = { platform: 'outlook', username: 'ShawnteLaden13841@hotmail.com', password: 'x' };
const linkedinAccount = { platform: 'linkedin', username: 'ShawnteLaden13841@hotmail.com', password: 'x' };

test('outlook and linkedin sites keep credentials on their own origins', () => {
  assert.equal(sites.outlook.loginUrl, 'https://login.live.com/');
  assert.equal(sites.outlook.homeUrl, 'https://outlook.live.com/mail/0/');
  assert.deepEqual(sites.outlook.credentialOrigins, ['https://login.live.com']);
  assert.equal(sites.outlook.origins.includes('https://outlook.live.com'), true);
  assert.equal(sites.linkedin.loginUrl, 'https://www.linkedin.com/login');
  assert.deepEqual(sites.linkedin.credentialOrigins, ['https://www.linkedin.com', 'https://linkedin.com']);
});

test('outlook identity requires the account surface AND the expected identity', () => {
  const positive = { url: 'https://outlook.live.com/mail/0/', text: 'Inbox New mail Sign out ShawnteLaden13841@hotmail.com', controls: [] };
  assert.equal(verifyIdentity(outlookAccount, positive, sites.outlook), true);
  const localPart = { url: 'https://outlook.live.com/mail/0/', text: 'Inbox New mail Sign out shawnteladen13841', controls: [] };
  assert.equal(verifyIdentity(outlookAccount, localPart, sites.outlook), true);
  // The portal is accepted on the account-manager control naming the display
  // name derived from the address, even when the email is not rendered as text.
  const portal = { url: 'https://account.microsoft.com/', text: 'Microsoft account',
    controls: [{ tag: 'button', label: 'Account manager for Shawnte Laden', type: '', name: '', autocomplete: '', href: null, formAction: null, enabled: true, key: 'am', id: 'am', required: false }] };
  assert.equal(verifyIdentity(outlookAccount, portal, sites.outlook), true);
  // A mailbox without the identity, or a page that still offers a password, is not proof.
  const anonymous = { url: 'https://outlook.live.com/mail/0/', text: 'Inbox New mail Sign out', controls: [] };
  assert.equal(verifyIdentity(outlookAccount, anonymous, sites.outlook), false);
  const password = { url: 'https://outlook.live.com/mail/0/', text: 'Inbox Sign out ShawnteLaden13841@hotmail.com Enter password',
    controls: [{ type: 'password' }] };
  assert.equal(verifyIdentity(outlookAccount, password, sites.outlook), false);
  // The sign-in origin itself is never a signed-in surface.
  assert.equal(verifyIdentity(outlookAccount, { url: 'https://login.live.com/', text: 'Sign out', controls: [] }, sites.outlook), false);
});

test('a signed-in Microsoft portal is a post-auth stop, not a mailbox proof', () => {
  const portal = { url: 'https://account.microsoft.com/', text: 'ShawnteLaden13841@hotmail.com Sign out', controls: [] };
  assert.equal(isMicrosoftPortalSignedIn(outlookAccount, portal), true);
  const masked = { url: 'https://login.live.com/', text: 's•••@hotmail.com Sign out', controls: [] };
  assert.equal(isMicrosoftPortalSignedIn(outlookAccount, masked), false, 'a masked address is not identity proof');
  const other = { url: 'https://www.linkedin.com/feed/', text: 'ShawnteLaden13841@hotmail.com Sign out', controls: [] };
  assert.equal(isMicrosoftPortalSignedIn(outlookAccount, other), false);
});

test('linkedin identity requires the member feed, not a public page', () => {  const feed = { url: 'https://www.linkedin.com/feed/', text: 'Start a post My Network Jobs Messaging', controls: [] };
  assert.equal(verifyIdentity(linkedinAccount, feed, sites.linkedin), true);
  const loggedOut = { url: 'https://www.linkedin.com/feed/', text: 'Start a post My Network Join now', controls: [] };
  assert.equal(verifyIdentity(linkedinAccount, loggedOut, sites.linkedin), false);
  const login = { url: 'https://www.linkedin.com/login', text: 'Sign in to LinkedIn', controls: [] };
  assert.equal(verifyIdentity(linkedinAccount, login, sites.linkedin), false);
});

test('linkedin and microsoft challenge surfaces classify for a human, never for a guess', () => {
  assert.equal(classifyPage({ url: 'https://www.linkedin.com/checkpoint/challenge', text: "Let's do a quick security check", controls: [] }),
    'human_verification_required');
  assert.equal(classifyPage({ url: 'https://www.linkedin.com/checkpoint/challenge',
    text: "We've emailed a code to s•••@hotmail.com. Enter the code.", controls: [] }),
  'email_or_sms_verification_required');
  assert.equal(classifyPage({ url: 'https://login.live.com/', text: 'Help us protect your account. We will send a code to your phone.', controls: [] }),
    'email_or_sms_verification_required');
  assert.equal(classifyPage({ url: 'https://login.live.com/', text: 'Stay signed in?', controls: [] }), null);
});

function browserFor(account, site) {
  return new LoginBrowser({ url: () => site.loginUrl }, account, { site });
}
const button = (label, key) => ({ tag: 'button', type: '', label, name: '', autocomplete: '', href: null,
  formAction: null, enabled: true, key, id: key, required: false });

test('microsoft "stay signed in" is a deterministic login step, not a security surface', () => {
  const browser = browserFor(outlookAccount, sites.outlook);
  const candidates = browser.candidates({ url: 'https://login.live.com/', fingerprint: 'f1',
    text: 'Stay signed in? Yes No', controls: [button('Yes', 'yes-1'), button('No', 'no-1')] });
  assert.deepEqual(candidates.map(action => action.kind), ['stay_signed_in']);
  // The same button without the prompt is not offered.
  const bare = browser.candidates({ url: 'https://login.live.com/', fingerprint: 'f2', text: 'Something else',
    controls: [button('Yes', 'yes-2')] });
  assert.deepEqual(bare.map(action => action.kind), []);
  assert.equal(operationKinds.stay_signed_in, 'click');
  assert.equal(riskByOperation.stay_signed_in, 'reversible_navigation');
  assert.equal(defaultPostconditions.stay_signed_in.type, 'page_fingerprint_changed');
});

test('outlook and linkedin expose their own account entry as the identity menu', () => {
  const outlook = browserFor(outlookAccount, sites.outlook);
  assert.deepEqual(outlook.candidates({ url: 'https://outlook.live.com/mail/0/', fingerprint: 'o1',
    text: 'Inbox', controls: [button('Account manager for Shawnte Laden', 'am-1')] }).map(a => a.kind),
  ['open_account_menu']);
  const linkedin = browserFor(linkedinAccount, sites.linkedin);
  assert.deepEqual(linkedin.candidates({ url: 'https://www.linkedin.com/feed/', fingerprint: 'l1',
    text: 'Start a post My Network', controls: [button('Me', 'me-1')] }).map(a => a.kind),
  ['open_account_menu']);
});

test('the portal Outlook tile outranks the account-menu toggle', () => {
  const browser = browserFor(outlookAccount, sites.outlook);
  const candidates = browser.candidates({ url: 'https://account.microsoft.com/', fingerprint: 'p1',
    text: 'Microsoft account', controls: [
      { tag: 'a', type: '', label: 'Open Outlook.com', name: '', autocomplete: '', href: 'https://outlook.live.com/mail/0/', formAction: null, enabled: true, key: 'outlook-tile', id: 'outlook-tile', required: false },
      button('Account manager for Shawnte Laden', 'am-2'),
    ] });
  assert.deepEqual(candidates.map(action => action.kind), ['open_outlook']);
});

test('the two-step identity is one account and one profile; crossing them is refused', () => {
  const pair = validateJobs({ jobs: [
    { id: 'ol-01-outlook', platform: 'outlook', accountRef: 'ol-01', profileRef: 'profile-ol-01' },
    { id: 'ol-01-linkedin', platform: 'linkedin', accountRef: 'ol-01', profileRef: 'profile-ol-01' },
  ] });
  assert.equal(pair.length, 2);
  assert.throws(() => validateJobs({ jobs: [
    { id: 'a', platform: 'outlook', accountRef: 'ol-01', profileRef: 'profile-ol-01' },
    { id: 'b', platform: 'linkedin', accountRef: 'ol-02', profileRef: 'profile-ol-01' },
  ] }), /duplicate_profile_ref/);
  assert.throws(() => validateJobs({ jobs: [
    { id: 'a', platform: 'outlook', accountRef: 'ol-01', profileRef: 'profile-ol-01' },
    { id: 'b', platform: 'linkedin', accountRef: 'ol-01', profileRef: 'profile-ol-02' },
  ] }), /duplicate_account_ref/);
  const accounts = parseAccounts(JSON.stringify([{ ref: 'ol-01', platform: 'outlook',
    username: 'a@hotmail.com', password: 'x' }]));
  assert.equal(accounts[0].platform, 'outlook');
});
