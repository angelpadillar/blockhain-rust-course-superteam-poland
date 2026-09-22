import test from 'node:test';
import assert from 'node:assert/strict';
import { sites, LoginBrowser, runLogin, verifyIdentity, classifyPage } from '../src/login.mjs';
import { recoveryCandidates, recoveryObservation, validateRecoveryDecision, executeRecoveryAction,
  isInfrastructureFailure, maxRecoverySteps, recoveryCapabilities, onboardingControl } from '../src/recovery.mjs';
import { BrowserExecutionKernel } from '../src/execution.mjs';
import { validateChoice } from '../src/jev.mjs';
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
    'open_switch_account', 'dismiss_onboarding', 'navigate_home', 'complete', 'escalate_security_checkpoint']);
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


// --- dismiss_onboarding: safe, non-security interstitials only ----------------

// Exactly the page yt-live-02 reached: Google's profile-picture onboarding.
const onboardingPage = { url: 'https://gds.google.com/web/pgc', challengeFrame: false,
  text: 'Add a profile picture\nHelp people recognize you and know when you are signed in to your account\n[secret]\nSkip',
  controls: [{ tag: 'button', label: 'Skip', enabled: true }] };
const shallow = { site: sites.youtube, redact: value => value };

test('Skip is offered on the observed profile-picture onboarding page', () => {
  const candidates = recoveryCandidates({ snapshot: onboardingPage, browser: shallow, site: sites.youtube });
  assert.equal(candidates[0].kind, 'dismiss_onboarding');
  assert.equal(candidates[0].control.label, 'Skip');
  assert.equal(candidates[0].id, 'r0');
});

test('a safe onboarding dismissal clicks the observed candidate through the shared kernel', async () => {
  let clicks = 0;
  const browser = { page: {}, recovery: { actions: 0 }, site: sites.youtube };
  const control = { key: 'sig-skip', tag: 'button', type: '', label: 'Skip', enabled: true,
    handle: { click: async () => { clicks++; }, isVisible: async () => true, isEnabled: async () => true } };
  const snapshot = { url: 'https://gds.google.com/web/pgc', text: 'Add a profile picture', fingerprint: 'f1',
    controls: [control] };
  const changed = { ...snapshot, text: 'Home', fingerprint: 'f2' };
  // A decision may only reach the browser through the kernel.
  const kernel = new BrowserExecutionKernel({ account, site: sites.youtube, workflow: 'recovery',
    observe: async () => changed });
  const outcome = await executeRecoveryAction({ action: { kind: 'dismiss_onboarding', control },
    snapshot, observation: kernel.observe(snapshot).observation, browser, site: sites.youtube,
    navigate: async () => {}, kernel, source: 'jev' });

  assert.equal(outcome.performed, true);
  assert.equal(outcome.detail, 'dismiss_onboarding');
  assert.equal(outcome.postconditionMet, true, 'the page state was observed to change');
  assert.equal(outcome.receipt.state, 'verified');
  assert.equal(outcome.receipt.action.operation, 'dismiss_onboarding');
  assert.equal(outcome.receipt.action.controlId, 'e0', 'the epoch-scoped control id, not a selector');
  assert.equal(outcome.receipt.action.risk, 'reversible_navigation');
  assert.equal(outcome.receipt.decisionSource, 'jev');
  assert.equal(clicks, 1, 'the observed candidate handle was clicked once');
  assert.equal(browser.recovery.actions, 1);
});

test('a recovery capability without the shared kernel fails closed instead of clicking', async () => {
  let clicks = 0;
  const browser = { page: {}, recovery: { actions: 0 }, site: sites.youtube };
  const control = { key: 'sig-skip', tag: 'button', label: 'Skip', enabled: true,
    handle: { click: async () => { clicks++; }, isVisible: async () => true, isEnabled: async () => true } };
  await assert.rejects(executeRecoveryAction({ action: { kind: 'dismiss_onboarding', control },
    snapshot: { url: 'https://gds.google.com/web/pgc', text: 'Skip', controls: [control] },
    browser, site: sites.youtube, navigate: async () => {} }), /execution_kernel_required/);
  assert.equal(clicks, 0, 'no browser operation happened outside the kernel');
});

test('onboarding dismissal is never offered on a security page', () => {
  const pages = [
    { text: 'Verify you are human', challengeFrame: true, label: 'Skip' },
    { text: 'Enter the code sent to your phone', challengeFrame: false, label: 'Continue' },
    { text: 'Confirm your recovery email', challengeFrame: false, label: 'Continue' },
    { text: 'We detected suspicious activity on your account', challengeFrame: false, label: 'Continue' },
    { text: 'Reset your password', challengeFrame: false, label: 'Continue' },
    { text: 'Your account has been suspended', challengeFrame: false, label: 'Done' },
  ];
  for (const page of pages) {
    const snapshot = { url: 'https://accounts.google.com/signin/v2/challenge', challengeFrame: page.challengeFrame,
      text: page.text, controls: [{ tag: 'button', label: page.label, enabled: true }] };
    assert.equal(onboardingControl(snapshot), null, page.text);
    const kinds = recoveryCandidates({ snapshot, browser: shallow, site: sites.youtube }).map(item => item.kind);
    assert.equal(kinds.includes('dismiss_onboarding'), false, page.text);
  }
  // A checkpoint the runtime already classified suppresses it as well.
  const classified = recoveryCandidates({ snapshot: onboardingPage, browser: shallow, site: sites.youtube,
    classifiedReason: 'human_verification_required' }).map(item => item.kind);
  assert.equal(classified.includes('dismiss_onboarding'), false);
});


test('only allow-listed names pass, and settings-changing labels are refused', () => {
  const page = label => ({ url: 'https://gds.google.com/web/pgc', challengeFrame: false,
    text: 'Onboarding', controls: [{ tag: 'button', label, enabled: true }] });
  for (const label of ['Skip', 'Not now', 'Later', 'Maybe later', 'Continue', 'Done']) {
    assert.equal(onboardingControl(page(label))?.label, label, label);
  }
  for (const label of ['Add a profile picture', 'Accept', 'Agree', 'Delete account',
    'Turn on 2-step verification', 'Sign out', 'Change password', 'Remove recovery email',
    'Subscribe', 'Manage permissions']) {
    assert.equal(onboardingControl(page(label)), null, label);
  }
  // A visible control is required; a hidden one is not eligible.
  assert.equal(onboardingControl({ url: 'https://gds.google.com/web/pgc', challengeFrame: false,
    text: 'Onboarding', controls: [{ tag: 'button', label: 'Skip', enabled: false }] }), null);
});

test('recovery cannot become arbitrary selector or script execution', async () => {
  const browser = { page: {}, recovery: { actions: 0 }, site: sites.youtube };
  for (const kind of ['click_selector', 'evaluate', 'javascript', 'type_text', 'navigate_url', 'click']) {
    await assert.rejects(
      executeRecoveryAction({ action: { kind, selector: '#x' }, browser, site: sites.youtube, navigate: async () => {} }),
      /unsupported_recovery_action/, kind);
  }
  // A decision must map back to an offered candidate; a selector is not an id.
  const offered = recoveryCandidates({ snapshot: onboardingPage, browser: shallow, site: sites.youtube });
  assert.throws(() => validateRecoveryDecision({ decision: { action: { id: '#skip' } }, candidates: offered }),
    /unknown_recovery_action/);
  assert.equal(browser.recovery.actions, 0);
});

test('the shared confidence and policy validation still applies to recovery decisions', () => {
  const candidates = recoveryCandidates({ snapshot: onboardingPage, browser: shallow, site: sites.youtube });
  const actions = candidates.map(({ id, description }) => ({ id, description }));
  const keys = [...actions.map(action => action.id), 'stop'];
  const criteria = { ...Object.fromEntries(actions.map(action => [action.id, action.description])),
    stop: 'Stop and request attention.' };
  const answer = (choice, confidence) => ({ model: 'fixture',
    answers: { action: { type: 'choice', choice, confidence,
      probabilities: Object.fromEntries(keys.map(key =>
        [key, key === choice ? confidence : (1 - confidence) / (keys.length - 1)])) } },
    usage: { input_tokens: 5, output_tokens: 5 } });
  const metrics = () => ({ calls: 1, latencyMs: 1, inputTokens: 0, outputTokens: 0, usageComplete: true, model: null });

  const accepted = validateChoice({ data: answer('r0', 0.95), metrics: metrics(), criteria, actions });
  assert.equal(accepted.action.id, 'r0');
  assert.equal(accepted.action.description.startsWith('dismiss_onboarding:'), true);
  assert.throws(() => validateChoice({ data: answer('r0', 0.5), metrics: metrics(), criteria, actions }),
    /jev_uncertain_or_invalid/);
  assert.throws(() => validateChoice({ data: answer('stop', 0.95), metrics: metrics(), criteria, actions }),
    /jev_requested_attention/);
  assert.throws(() => validateChoice({ data: answer('r99', 0.95), metrics: metrics(), criteria, actions }),
    /jev_unknown_action/);
});


test('an onboarding interstitial is dismissed by recovery and the flow continues', async () => {
  const choose = picker(['dismiss_onboarding']);
  let humans = 0;
  // The yt-live-02 shape: the deterministic flow ends with no known action on a
  // harmless Google onboarding page, and recovery dismisses it safely.
  const onboardingFrame = { url: 'https://gds.google.com/web/pgc',
    controls: [{ id: 'skip', label: 'Skip' }], text: 'Add a profile picture Skip' };
  const page = fakePage([onboardingFrame, identityFrame]);
  const result = await runLogin({ page, account, choose, site: sites.youtube, readyWindowMs: 200,
    onStep: async () => {}, requestHumanCheckpoint: async () => { humans++; return null; } });

  assert.equal(result.verified, true, 'the expected identity was verified after the dismissal');
  assert.equal(humans, 0, 'no person was needed for a harmless interstitial');
  assert.deepEqual(result.recovery.reasons, ['dismiss_onboarding']);
  assert.equal(result.recovery.actions, 1);
  assert.equal(result.recovery.calls, 1);
});

