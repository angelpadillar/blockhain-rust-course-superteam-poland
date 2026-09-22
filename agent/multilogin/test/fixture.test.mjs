import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LoginBrowser, sites } from '../src/login.mjs';
import { BrowserExecutionKernel } from '../src/execution.mjs';
import { createReceiptStore } from '../src/receipts.mjs';
import { observationFromSnapshot } from '../src/observation.mjs';
import { reconcileOnRestart, retryAuthorized } from '../src/reconcile.mjs';
import { createJevAdvisor, createFrontierVisionAdvisor, createAdvisorChain } from '../src/advisor.mjs';
import { mayRetry } from '../src/contract.mjs';
import { PilotError } from '../src/core.mjs';

const account = { platform: 'youtube', username: 'fixture@example.com', password: 'private-password',
  totp: 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ', id: 'fixture' };
const site = { origins: ['https://accounts.google.com'], credentialOrigins: ['https://accounts.google.com'],
  homeUrl: 'https://www.youtube.com/',
  loginUrl: 'https://accounts.google.com/signin/v2/identifier' };

// A small stateful page: the DOM the flow observes and the handle it executes.
function stubPage(controls) {
  const state = { url: site.loginUrl, values: {}, clicks: 0, filled: [], controls };
  const asElement = control => ({ tagName: control.tag.toUpperCase(), id: '', innerText: control.label || '',
    labels: [], disabled: control.enabled === false, readOnly: false, required: false, form: null, href: '',
    getAttribute: name => (name === 'aria-label' ? control.label : name === 'type' ? control.type
      : name === 'name' ? control.name : null),
    querySelector: () => null });
  return { state,
    url: () => state.url,
    goto: async url => { state.url = url; return { status: () => 200 }; },
    $$: async () => state.controls.map(control => ({
      isVisible: async () => true,
      isEnabled: async () => control.enabled !== false,
      evaluate: async fn => fn(asElement(control)),
      dispose: async () => {},
      fill: async value => { state.filled.push({ name: control.name || control.label, value }); },
      click: async () => { state.clicks++; state.url = 'https://accounts.google.com/signin/v2/challenge'; },
    })),
    locator: () => ({ count: async () => 0, first() { return this; },
      innerText: async () => 'Try another way' }),
    on: () => {}, off: () => {} };
}

async function store(t) {
  const directory = await mkdtemp(join(tmpdir(), 'fixture-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return createReceiptStore({ directory });
}

function kernelFor({ browser, receipts, journal = [] }) {
  return new BrowserExecutionKernel({ browser, account, site, workflow: 'login', runId: 'login-fixture',
    receipts, scope: { jobId: 'fixture-job', profileId: 'profile-1' },
    observe: () => browser.observe(), identityVerified: () => false,
    journal: async entry => { journal.push(entry); } });
}

function noModelChain() {
  return createAdvisorChain({
    jev: createJevAdvisor({ choose: async () => { throw new PilotError('model_not_needed'); } }),
    frontier: createFrontierVisionAdvisor(), classifySecurityCheckpoint: () => null });
}

// The end-to-end path A-F require: observe epoch N -> decision -> BrowserAction ->
// workflow authorization -> receipt persisted BEFORE dispatch -> freshness check
// -> trusted valueRef resolution -> existing browser executor -> postcondition ->
// receipt verified -> observe epoch N+1.
test('the whole path: observe N, decide, authorize, receipt, execute, verify, observe N+1', async t => {
  const receipts = await store(t);
  const journal = [];
  const page = stubPage([
    { tag: 'input', type: 'email', label: 'Username', name: 'username' },
    { tag: 'input', type: 'password', label: 'Password', name: 'password' },
    { tag: 'button', label: 'Log in', name: 'submit' },
  ]);
  const browser = new LoginBrowser(page, account, { site });
  const kernel = kernelFor({ browser, receipts, journal });

  // 1. observe epoch N: the live path emits the contract and epoch-scoped ids.
  const snapshot = await browser.observe();
  const observation = kernel.observe(snapshot).observation;
  assert.equal(snapshot.epoch, observation.epoch);
  assert.deepEqual(snapshot.controls.map(control => control.id), ['e0', 'e1', 'e2']);

  // 2. a decision: exactly one permitted action, so L1 decides with no model call.
  const candidates = browser.candidates(snapshot);
  assert.deepEqual(candidates.map(action => action.kind), ['fill_username']);
  const decision = await noModelChain()({ page: browser.publicPage(snapshot), observation, snapshot,
    actions: candidates.map(({ id, description }) => ({ id, description })) });
  assert.equal(decision.method, 'exact-single-match');
  const candidate = candidates.find(item => item.id === decision.action.id);
  assert.equal(candidate.valueRef, 'account_username', 'the decision names a reference, never a value');

  // 3-5. BrowserAction -> workflow authorization -> receipt BEFORE dispatch.
  const statesAtDispatch = [];
  const outcome = await kernel.execute({ candidate, snapshot, observation,
    source: 'deterministic', expectedPostcondition: null,
    dispatch: async ({ action, control, snapshot: live }) => {
      // 6-8. freshness already re-resolved the control; the executor resolves the
      // reference in trusted code and fills the field.
      assert.equal(control.id, action.controlId, 'the live control is the one that was decided on');
      assert.equal(action.observationEpoch, observation.epoch);
      assert.equal(action.valueRef, 'account_username');
      statesAtDispatch.push((await receipts.entries()).map(entry => entry.state));
      await browser.execute({ ...candidate, control, valueRef: action.valueRef,
        observationEpoch: action.observationEpoch, controlId: action.controlId,
        expectedControlSignature: action.expectedControlSignature }, live || snapshot,
      { decisionObservation: observation });
      return null;
    } });

  assert.deepEqual(statesAtDispatch, [['created', 'dispatched']],
    'the receipt was durable before the executor ran');
  assert.equal(outcome.action.risk, 'form_preparation');
  assert.equal(outcome.receipt.state, 'verified');
  assert.equal(page.state.filled.length, 1);
  assert.equal(page.state.filled[0].value, 'fixture@example.com', 'trusted code resolved the value');

  // No secret reached the receipt, the journal or the disk.
  const disk = await readFile(receipts.path, 'utf8');
  for (const payload of [JSON.stringify(outcome.receipt), JSON.stringify(journal), disk]) {
    assert.equal(payload.includes('fixture@example.com'), false, 'no account value is recorded');
    assert.equal(payload.includes('account_username'), true, 'only the reference is');
  }

  // 9. observe epoch N+1: a new reading is a new epoch, and the earlier decision
  // cannot be replayed against it.
  const later = await browser.observe();
  assert.notEqual(later.epoch, snapshot.epoch);
  // The earlier control is not observable in the new epoch at all, and if it were
  // the epoch check would refuse it: either way nothing is dispatched.
  await assert.rejects(kernel.execute({ candidate, snapshot: later, observation: later,
    decisionObservation: observation, dispatch: async () => { throw new Error('must not dispatch'); } }),
  /control_not_observed|stale_observation/);
  await assert.rejects(kernel.execute({ candidate: { ...candidate, control: later.controls[0] },
    snapshot: later, observation: later, decisionObservation: observation,
    dispatch: async () => { throw new Error('must not dispatch'); } }), /stale_observation/);
});

test('the same flow refuses a stale epoch, a changed control and an unauthorized action', async t => {
  const receipts = await store(t);
  const page = stubPage([{ tag: 'button', label: 'Log in', name: 'submit' }]);
  const browser = new LoginBrowser(page, account, { site });
  const kernel = kernelFor({ browser, receipts });
  const snapshot = await browser.observe();
  const observation = kernel.observe(snapshot).observation;
  const candidate = browser.candidates(snapshot)[0];
  assert.equal(candidate.kind, 'submit_login');
  let dispatched = 0;
  const attempt = extra => kernel.execute({ candidate: { ...candidate, control: snapshot.controls[0] },
    snapshot, observation, expectedPostcondition: null, dispatch: async () => { dispatched++; }, ...extra });

  // A decision taken on another epoch is refused before the browser is touched.
  const earlier = observationFromSnapshot({ snapshot: { url: snapshot.url, text: 'a different page',
    controls: snapshot.controls.map(control => ({ ...control })) } });
  assert.notEqual(earlier.epoch, observation.epoch);
  await assert.rejects(attempt({ decisionObservation: earlier }), /stale_observation/);

  // The page re-renders while the decision is in flight: the retained signature of
  // the control has moved on, so the decision is refused.
  page.state.controls[0].label = 'Log in (re-rendered)';
  await assert.rejects(attempt({}), /changed_control/);
  page.state.controls[0].label = 'Log in';

  // A model's own risk claim changes nothing: the operation defines the class, so
  // a claim can neither widen nor narrow authority, and nothing here is
  // consequential at all.
  assert.equal(kernel.authorizedRoles().includes('consequential'), false);
  const claimed = await attempt({ candidate: { ...candidate, control: snapshot.controls[0],
    claimedRisk: 'consequential_external_action' } });
  assert.equal(claimed.action.risk, 'authentication', 'the claimed class was dropped');
  assert.equal(claimed.receipt.state, 'verified');

  // A workflow whose roles do not cover the operation refuses it outright.
  const readOnly = new BrowserExecutionKernel({ browser, account, site, workflow: 'login',
    allowedRoles: ['read'], runId: 'read-only-run', receipts, observe: () => browser.observe() });
  await assert.rejects(readOnly.execute({ candidate: { ...candidate, control: snapshot.controls[0] },
    snapshot, observation, expectedPostcondition: null, dispatch: async () => { dispatched++; } }),
  /risk_not_authorized/);
  assert.equal(dispatched, 1, 'only the authorized action reached the browser');
});

test('an uncertain action cannot replay, and a crash is reconciled read-only', async t => {
  const receipts = await store(t);
  const page = stubPage([{ tag: 'button', label: 'Log in', name: 'submit' }]);
  const browser = new LoginBrowser(page, account, { site });
  const kernel = kernelFor({ browser, receipts });
  const snapshot = await browser.observe();
  const observation = kernel.observe(snapshot).observation;
  const candidate = browser.candidates(snapshot)[0];

  // The dispatch fails after it may have reached the platform.
  const error = await kernel.execute({ candidate, snapshot, observation,
    dispatch: async () => { throw new PilotError('stale_control'); } }).then(() => null, thrown => thrown);
  assert.equal(error.receipt.state, 'failed');
  assert.equal(mayRetry(error.receipt), false, 'the key alone never authorizes a replay');
  assert.equal(retryAuthorized(error.receipt), false);

  // A restart reads the durable trail: it is uncertain, so it stays uncertain.
  const restarted = createReceiptStore({ directory: join(receipts.path, '..') });
  const reconciled = await reconcileOnRestart({ store: restarted,
    probe: { url: async () => site.loginUrl, text: async () => 'Try another way',
      fingerprint: async () => 'fp-x', control: async () => ({ enabled: true }) },
    now: () => Date.now() });
  assert.deepEqual(reconciled.outcomes, [], 'nothing was left in flight by a failed dispatch');
  assert.equal((await restarted.find({ id: error.receipt.id })).state, 'failed');
  assert.equal(retryAuthorized(await restarted.find({ id: error.receipt.id })), false);
});
