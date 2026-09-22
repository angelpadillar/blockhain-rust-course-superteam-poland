import test from 'node:test';
import assert from 'node:assert/strict';
import { sites, LoginBrowser, runLogin, verifyIdentity, classifyPage } from '../src/login.mjs';
import { recoveryCandidates, recoveryObservation, validateRecoveryDecision, executeRecoveryAction,
  isInfrastructureFailure, maxRecoverySteps, recoveryCapabilities } from '../src/recovery.mjs';
import { failurePolicy } from '../src/core.mjs';

// The exact origins observed in the profile's own Chromium history after a real
// Google + TOTP sign-in: gds.google.com/web/landing was the page observe()
// rejected, and accounts.youtube.com/accounts/SetSID is the SetSID hop.
const observedPostAuthOrigins = ['https://gds.google.com', 'https://accounts.youtube.com'];
const seed = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
const account = { platform: 'youtube', username: 'fixture@example.com',
  password: 'fixture-password', totp: seed, id: 'fixture' };

// A minimal Playwright stand-in: LoginBrowser.observe() only needs $$ handles,
// body innerText and an iframe count, and execute() needs visibility plus a click.
function fakeControl({ id, tag = 'button', type = '', label = '', role = '', href = '',
  enabled = true, visible = true, onClick = null } = {}) {
  const attributes = {};
  if (label) attributes['aria-label'] = label;
  if (type) attributes.type = type;
  if (role) attributes.role = role;
  const element = { tagName: tag.toUpperCase(), id: '', innerText: label, labels: [],
    disabled: !enabled, readOnly: false, required: false, form: null, href,
    getAttribute: name => (name in attributes ? attributes[name] : null),
    querySelector: () => null };
  return {
    isVisible: async () => visible,
    isEnabled: async () => enabled,
    evaluate: async fn => fn(element),
    dispose: async () => {},
    click: async () => { if (onClick) onClick(); },
    fill: async () => {},
  };
}

function fakePage(frames) {
  const state = { index: 0, navigations: [] };
  const frame = () => frames[Math.min(state.index, frames.length - 1)];
  const advance = () => { state.index = Math.min(state.index + 1, frames.length - 1); };
  const handles = frame => frame.controls.map(control => fakeControl({ ...control, onClick: advance }));
  return { state,
    url: () => frame().url,
    goto: async url => { state.navigations.push(url);
      if (state.navigations.length > 1) advance(); return { status: () => 200 }; },
    $$: async () => handles(frame()),
    locator: () => ({ count: async () => 0, first() { return this; }, innerText: async () => frame().text || '' }),
    on: () => {}, off: () => {} };
}

// Deterministic stand-in for the shared choice policy: it prefers a named typed
// capability and otherwise takes the first candidate.
function picker(preferred = []) {
  const calls = [];
  const choose = async request => {
    calls.push(request);
    const chosen = request.actions.find(action =>
      preferred.some(kind => new RegExp(`^${kind}:`).test(action.description))) || request.actions[0];
    return { action: chosen, method: 'fixture', confidence: 0.95, probability: 0.95, reason: 'fixture choice' };
  };
  choose.calls = calls;
  return choose;
}

function browserFor(frames, { account: who = account } = {}) {
  const page = fakePage(frames);
  const browser = new LoginBrowser(page, who, { site: sites.youtube });
  return { page, browser };
}

test('the post-auth origins observed in the live flow are allowed for navigation', () => {
  for (const origin of observedPostAuthOrigins) {
    assert.equal(sites.youtube.origins.includes(origin), true, `${origin} must be navigable`);
  }
});

test('credential entry stays restricted to the Google sign-in origin', () => {
  assert.deepEqual(sites.youtube.credentialOrigins, ['https://accounts.google.com']);
  for (const origin of observedPostAuthOrigins) {
    assert.equal(sites.youtube.credentialOrigins.includes(origin), false,
      `${origin} must never be a credential origin`);
  }
});

test('a closed account menu is reopened deterministically a bounded number of times', async () => {
  const menuOnly = { url: 'https://www.youtube.com/', controls: [{ id: 'menu', label: 'Account menu' }], text: '' };
  const { browser } = browserFor([menuOnly, menuOnly, menuOnly]);

  const first = await browser.observe();
  const initial = browser.candidates(first, {});
  assert.deepEqual(initial.map(action => action.kind), ['open_account_menu']);

  await browser.execute(initial[0], first);
  assert.equal(browser.menuClicks.size, 1, 'the first deterministic reopen is counted');

  const second = await browser.observe();
  const reopening = browser.candidates(second, {});
  assert.deepEqual(reopening.map(action => action.kind), ['open_account_menu'],
    'a second deterministic attempt is still allowed');

  await browser.execute(reopening[0], second);
  const third = await browser.observe();
  assert.deepEqual(browser.candidates(third, {}).map(action => action.kind), [],
    'after the bounded attempts the menu is no longer offered, so the toggle cannot loop');
  assert.equal(browser.menuClicks.get([...browser.menuClicks.keys()][0]), 2);
});


test('the recovery capability list is exactly the typed, non-bypassing set', () => {
  assert.equal(maxRecoverySteps, 8);
  assert.deepEqual(Object.keys(recoveryCapabilities), ['retry_observation', 'wait', 'reopen_account_menu',
    'open_switch_account', 'navigate_home', 'complete', 'escalate_security_checkpoint']);
});

test('identity verification needs Switch account evidence, not just a channel handle', () => {
  const base = { url: 'https://www.youtube.com/', controls: [], challengeFrame: false };
  assert.equal(verifyIdentity(account, { ...base,
    text: 'Charles @Charles-o2z3x Switch account Sign out Google Account' }, sites.youtube), false);
  assert.equal(verifyIdentity(account, { ...base,
    text: 'fixture@example.com Switch account Sign out Google Account' }, sites.youtube), true);
});

test('recovery offers only capabilities the observed page actually supports', () => {
  const site = sites.youtube;
  const browser = { site, redact: value => value };
  const closedMenu = { url: 'https://www.youtube.com/', controls: [{ tag: 'button', label: 'Account menu', enabled: true }], text: '' };
  assert.deepEqual(recoveryCandidates({ snapshot: closedMenu, browser, site }).map(item => item.kind),
    ['reopen_account_menu', 'retry_observation', 'wait', 'escalate_security_checkpoint']);

  const openMenu = { url: 'https://www.youtube.com/', controls: [
    { tag: 'button', label: 'Account menu', enabled: true },
    { tag: 'tp-yt-paper-item', label: 'Switch account', enabled: true }], text: '' };
  assert.equal(recoveryCandidates({ snapshot: openMenu, browser, site })[0].kind, 'open_switch_account');

  const elsewhere = { url: 'https://gds.google.com/web/landing', controls: [], text: '' };
  assert.equal(recoveryCandidates({ snapshot: elsewhere, browser, site }).some(item => item.kind === 'navigate_home'), true);
});

test('a decision outside the offered capabilities is rejected', () => {
  const candidates = [{ id: 'r0', kind: 'retry_observation', description: 'retry_observation' }];
  assert.equal(validateRecoveryDecision({ decision: { action: { id: 'r0' } }, candidates }).kind, 'retry_observation');
  assert.throws(() => validateRecoveryDecision({ decision: { action: { id: 'zz' } }, candidates }), /unknown_recovery_action/);
});

test('escalate and complete are reported, never executed as a click', async () => {
  const browser = { page: {}, recovery: { actions: 0 }, menuClicks: new Map(), menuOpenedKeys: new Set() };
  const site = sites.youtube;
  assert.deepEqual(await executeRecoveryAction({ action: { kind: 'escalate_security_checkpoint' }, browser, site, navigate: async () => {} }),
    { performed: false, escalate: true });
  assert.deepEqual(await executeRecoveryAction({ action: { kind: 'complete' }, browser, site, navigate: async () => {} }),
    { performed: false, complete: true });
  assert.equal(browser.recovery.actions, 0);
});

test('a transport failure is infrastructure, never browser reasoning', () => {
  for (const code of ['proxy_connection_failed', 'tunnel_failed', 'dns_failed', 'connection_reset',
    'connection_timed_out', 'browser_attachment_failed']) {
    assert.equal(isInfrastructureFailure(code), true, code);
  }
  assert.equal(isInfrastructureFailure('multilogin_http_500'), true);
  assert.equal(failurePolicy('proxy_connection_failed').rotateProxy, true,
    'a proxy failure keeps the existing one bounded refresh policy');
  for (const code of ['unexpected_login_destination', 'unsupported_login_screen', 'human_verification_required']) {
    assert.equal(isInfrastructureFailure(code), false, code);
  }
});

// --- runLogin level: the three-level policy end to end -----------------------

const home = 'https://www.youtube.com/';
const menuRow = { id: 'menu', label: 'Account menu' };
const switchRow = { id: 'switch', tag: 'tp-yt-paper-item', label: 'Switch account' };
// Distinct page text per frame so a click is observably a new page state.
const menuFrame = marker => ({ url: home, controls: [menuRow], text: `render ${marker}` });
const switchFrame = marker => ({ url: home, controls: [switchRow], text: `render ${marker}` });
const identityFrame = { url: home, controls: [],
  text: 'fixture@example.com Switch account Sign out Google Account' };

test('a re-render that closes the menu goes to recovery, and the identity still verifies', async () => {
  const choose = picker(['reopen_account_menu']);
  let humans = 0;
  const page = fakePage([menuFrame('a'), menuFrame('b'), menuFrame('c'),
    { url: home, controls: [menuRow, switchRow], text: 'render d' }, identityFrame]);
  const result = await runLogin({ page, account, choose, site: sites.youtube, readyWindowMs: 200,
    onStep: async () => {}, requestHumanCheckpoint: async () => { humans++; return null; } });

  assert.equal(result.verified, true, 'the expected identity was verified');
  assert.equal(humans, 0, 'a person was not needed');
  assert.deepEqual(result.recovery.reasons, ['reopen_account_menu']);
  assert.equal(result.recovery.calls, 1, 'exactly one recovery model call');
  assert.equal(result.recovery.actions, 1);
  // Two deterministic menu openings, one recovery reopening, then the Switch
  // account row opened once for the identity evidence: four bounded menu actions.
  assert.equal(result.recovery.menuActions, 4);
});

test('recovery can open Switch account after the deterministic attempts are exhausted', async () => {
  const choose = picker(['open_switch_account']);
  const page = fakePage([switchFrame('a'), switchFrame('b'), switchFrame('c'), identityFrame]);
  const result = await runLogin({ page, account, choose, site: sites.youtube, readyWindowMs: 200,
    onStep: async () => {} });

  assert.equal(result.verified, true);
  assert.deepEqual(result.recovery.reasons, ['open_switch_account']);
  assert.equal(result.recovery.calls, 1);
});

test('the recovery budget is finite, and humans are not the first fallback', async () => {
  const choose = picker(['retry_observation']);
  let humans = 0;
  const frames = ['a', 'b', 'c', 'd', 'e', 'f'].map(marker => ({ url: home, controls: [], text: `render ${marker}` }));
  const error = await runLogin({ page: fakePage(frames), account, choose, site: sites.youtube, readyWindowMs: 200, recoveryBudget: 2,
    onStep: async () => {}, requestHumanCheckpoint: async () => { humans++; return null; } })
    .then(() => null, thrown => thrown);

  assert.equal(error.code, 'unsupported_login_screen', 'an unresolvable non-security state still fails');
  assert.equal(error.recovery.steps, 2, 'the episode stopped at its budget');
  assert.equal(humans, 0, 'no person was asked for a non-security state');
  assert.equal(choose.calls.length, 2, 'recovery was consulted before anything else');
  assert.equal(choose.calls.every(call => call.actions.every(action =>
    /^(retry_observation|wait|escalate_security_checkpoint):/.test(action.description))), true);
});


test('a security-looking page at an observed post-auth origin recovers without a person', async () => {
  const choose = picker(['navigate_home']);
  let humans = 0;
  const page = fakePage([{ url: 'https://gds.google.com/web/landing', controls: [], text: 'Verify you are human' },
    identityFrame]);
  const result = await runLogin({ page, account, choose, site: sites.youtube, readyWindowMs: 200,
    onStep: async () => {}, requestHumanCheckpoint: async () => { humans++; return null; } });

  assert.equal(result.verified, true);
  assert.equal(humans, 0);
  assert.deepEqual(result.recovery.reasons, ['navigate_home']);
});

test('a checkpoint that recovery escalates becomes a human checkpoint, not a bypass', async () => {
  const choose = picker(['escalate_security_checkpoint']);
  const seen = [];
  const page = fakePage([{ url: home, controls: [], text: 'Verify you are human' }]);
  const error = await runLogin({ page, account, choose, site: sites.youtube, readyWindowMs: 200, onStep: async () => {},
    requestHumanCheckpoint: async context => { seen.push(context.reason); return null; } })
    .then(() => null, thrown => thrown);

  assert.equal(error.code, 'human_verification_required');
  assert.deepEqual(seen, ['human_verification_required'], 'the human hook received the classified reason');
});

test('the recovery observation carries no credentials, codes or query strings', async () => {
  const choose = picker(['escalate_security_checkpoint']);
  const page = fakePage([{ url: home, text: 'fixture@example.com 123456', controls: [
    { id: 'internal', tag: 'a', label: '', href: 'https://www.youtube.com/redirect?q=secret' },
    { id: 'foreign', tag: 'a', label: '', href: 'https://evil.example/steal?x=1' }] }]);
  await runLogin({ page, account, choose, site: sites.youtube, recoveryBudget: 1, readyWindowMs: 200, onStep: async () => {},
    requestHumanCheckpoint: async () => null }).catch(() => {});

  const observation = choose.calls[0].page;
  const payload = JSON.stringify(observation);
  assert.equal(choose.calls.length, 1);
  assert.equal(payload.includes('fixture-password'), false, 'the password never enters the payload');
  assert.equal(payload.includes(seed), false, 'the authenticator seed never enters the payload');
  assert.equal(payload.includes('fixture@example.com'), false, 'the address is redacted');
  assert.equal(payload.includes('123456'), false, 'a code is redacted');
  assert.equal(payload.includes('evil.example'), false, 'a foreign href is dropped');
  assert.equal(payload.includes('?'), false, 'no query string anywhere in the payload');
  assert.deepEqual(observation.controls.map(control => control.href).filter(Boolean),
    ['https://www.youtube.com/redirect']);
  assert.equal(observation.url.origin, 'https://www.youtube.com');
  assert.equal(observation.goal.includes('Human confirmation'), true);
});

