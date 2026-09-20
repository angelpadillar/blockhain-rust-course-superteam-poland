import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCustomerOnboarding, notificationContactHash } from './customer-onboarding.mjs';
import { createFiveSimAdapter, createFiveSimStore } from './sms/fivesim.mjs';

const actor = { customerId: 'customer-one', merchantAccountId: 'merchant-one' };
const other = { customerId: 'customer-two', merchantAccountId: 'merchant-two' };
const now = 1_000_000;
const evidence = evidenceId => ({ evidenceId, observedAt: now });
const reject = (fn, code) => assert.rejects(fn, { code });

async function fixture(t, overrides = {}) {
  const storeDir = await mkdtemp(join(tmpdir(), 'delio-onboarding-'));
  t.after(() => rm(storeDir, { recursive: true, force: true }));
  const calls = { mailbox: 0, buy: 0, poll: 0, inspect: 0, start: 0, complete: 0 };
  const secrets = new Map(), hooks = {};
  const snapshot = async () => JSON.parse(await readFile(join(storeDir, 'customer-onboarding.json'), 'utf8'));
  const pending = async operation => {
    const saved = await snapshot();
    assert.equal(saved.entries[actor.customerId].pending.operation, operation);
    if (operation === 'buy_sms') assert.equal(saved.smsPurchaseAttempts, 1);
  };
  const mailbox = {
    capabilities: async () => ({ verified: true, privateMailbox: true, testOnly: false }),
    async create(args) {
      calls.mailbox++; await pending('create_mailbox');
      if (hooks.mailbox) return hooks.mailbox(args);
      await args.onEmail('activation-private@example.test');
    },
  };
  const sms = {
    publicStatus: async () => ({ paidEnabled: true, purchaseConfigurationValid: true, entries: [], needsReconciliation: false,
      usdAuthorization: { currency: 'USD', totalMinor: 20, maxPurchases: 1 } }),
    async buy(args) {
      calls.buy++; await pending('buy_sms'); assert.equal(args.operator, 'any');
      if (hooks.buy) return hooks.buy(args);
      await args.onPhone('+48123456789'); return { reservationId: 'owned-sms-reservation' };
    },
    async poll(args) {
      calls.poll++; await pending('poll_sms'); assert.equal(args.reservationId, 'owned-sms-reservation');
      if (hooks.poll) return hooks.poll(args);
      await args.onOtp('123456'); return { state: 'otp_delivered_to_private_consumer' };
    },
  };
  const merchant = {
    async inspectRegistration() {
      calls.inspect++; if (hooks.inspect) return hooks.inspect();
      return { verified: true, merchantAccountId: actor.merchantAccountId, ...evidence('registration-page') };
    },
    async startRegistration(args) {
      calls.start++; await pending('start_registration');
      assert.equal(args.email, 'activation-private@example.test'); assert.equal(args.phone, '+48123456789');
      if (hooks.start) return hooks.start(args);
      return { otpRequired: true };
    },
    async completeRegistration(args) {
      calls.complete++; await pending('complete_registration'); assert.equal(args.otp, '123456');
      if (hooks.complete) return hooks.complete(args);
      return { registered: true, merchantAccountId: actor.merchantAccountId, ...evidence('registered-account') };
    },
  };
  const vault = {
    async put(customerId, kind, value) { secrets.set(`${customerId}:${kind}`, value); },
    async withSecret(customerId, kind, callback) { await callback(secrets.get(`${customerId}:${kind}`)); },
  };
  const config = { accounts: [{ ...actor, newCustomer: true }], storeDir, exclusiveOwner: true,
    mailbox, sms, merchant, vault, clock: () => now, ...overrides };
  return { coordinator: createCustomerOnboarding(config), config, calls, secrets, hooks, snapshot };
}

test('registration is durably staged, uses private callbacks and never repeats after completion/restart', async t => {
  const f = await fixture(t);
  const [first, second] = await Promise.all([f.coordinator.advance(actor), f.coordinator.advance(actor)]);
  assert.equal(first.phase, 'registered'); assert.equal(second.phase, 'registered');
  assert.equal(first.productionReady, false); assert.equal(first.activation.temporaryPhoneIsRecoveryContact, false);
  assert.deepEqual(f.calls, { mailbox: 1, buy: 1, poll: 1, inspect: 3, start: 1, complete: 1 });
  await createCustomerOnboarding(f.config).advance(actor);
  assert.equal(f.calls.mailbox, 1); assert.equal(f.calls.buy, 1); assert.equal(f.calls.start, 1);
  const serialized = JSON.stringify([await f.snapshot(), first]);
  for (const secret of ['activation-private@example.test', '+48123456789', '123456']) assert.equal(serialized.includes(secret), false);
  assert.equal((await stat(join(f.config.storeDir, 'customer-onboarding.json'))).mode & 0o777, 0o600);
});

test('stopAfter advances exactly one requested stage and resumed stops perform no provider actions', async t => {
  const f = await fixture(t);
  const stages = ['mailbox_ready', 'phone_ready', 'awaiting_otp', 'otp_ready', 'registered'];
  const expected = [
    { mailbox: 1, buy: 0, poll: 0, inspect: 1, start: 0, complete: 0 },
    { mailbox: 1, buy: 1, poll: 0, inspect: 2, start: 0, complete: 0 },
    { mailbox: 1, buy: 1, poll: 0, inspect: 3, start: 1, complete: 0 },
    { mailbox: 1, buy: 1, poll: 1, inspect: 3, start: 1, complete: 0 },
    { mailbox: 1, buy: 1, poll: 1, inspect: 3, start: 1, complete: 1 },
  ];
  for (const [index, stopAfter] of stages.entries()) {
    const result = await f.coordinator.advance(actor, { stopAfter });
    assert.equal(result.phase, stopAfter); assert.deepEqual(f.calls, expected[index]);
    const saved = await f.snapshot(); assert.equal(saved.entries[actor.customerId].phase, stopAfter);
    assert.equal(saved.entries[actor.customerId].pending, null);
    const capabilities = f.config.mailbox.capabilities;
    f.config.mailbox.capabilities = async () => { assert.fail('already reached stop must not query provider capabilities'); };
    const reopened = createCustomerOnboarding(f.config);
    for (const earlier of stages.slice(0, index + 1)) {
      const resumed = await reopened.advance(actor, { stopAfter: earlier });
      assert.equal(resumed.phase, stopAfter); assert.deepEqual(f.calls, expected[index]);
    }
    f.config.mailbox.capabilities = capabilities;
  }
});

test('invalid stopping phases fail before any mutation and valid stops retain ownership/uncertainty guards', async t => {
  const f = await fixture(t), before = await f.snapshot();
  for (const stopAfter of ['new', 'existing_login', 'uncertain', 'reconciliation_required', '', null, false, 1, {}]) {
    await reject(() => f.coordinator.advance(actor, { stopAfter }), 'invalid_onboarding_stop_after');
  }
  assert.deepEqual(await f.snapshot(), before);
  assert.deepEqual(f.calls, { mailbox: 0, buy: 0, poll: 0, inspect: 0, start: 0, complete: 0 });
  await reject(() => f.coordinator.advance(other, { stopAfter: 'mailbox_ready' }), 'onboarding_account_not_owned');
  await f.coordinator.advance(actor, { stopAfter: 'mailbox_ready' });
  f.hooks.buy = async () => { throw new Error('uncertain paid request'); };
  await reject(() => f.coordinator.advance(actor, { stopAfter: 'phone_ready' }), 'onboarding_reconciliation_required');
  await reject(() => f.coordinator.advance(actor, { stopAfter: 'mailbox_ready' }), 'onboarding_reconciliation_required');
  assert.equal(f.calls.buy, 1); assert.equal(f.calls.start, 0);
});

test('concurrent stage requests serialize progress without overrunning either stop', async t => {
  const f = await fixture(t);
  const [mailboxReady, phoneReady] = await Promise.all([
    f.coordinator.advance(actor, { stopAfter: 'mailbox_ready' }),
    f.coordinator.advance(actor, { stopAfter: 'phone_ready' }),
  ]);
  assert.equal(mailboxReady.phase, 'mailbox_ready'); assert.equal(phoneReady.phase, 'phone_ready');
  assert.deepEqual(f.calls, { mailbox: 1, buy: 1, poll: 0, inspect: 2, start: 0, complete: 0 });
});

test('resuming phone_ready rechecks the current form before intent and retains the activation on a blocker', async t => {
  const f = await fixture(t);
  await f.coordinator.advance(actor, { stopAfter: 'phone_ready' });
  const before = await f.snapshot();
  f.hooks.inspect = () => ({ verified: false });
  const reopened = createCustomerOnboarding(f.config);
  await reject(() => reopened.advance(actor, { stopAfter: 'awaiting_otp' }), 'merchant_registration_page_unverified');
  assert.deepEqual(await f.snapshot(), before, 'form blocker must not record submission intent or change the purchased activation');
  assert.equal(reopened.status(actor).phase, 'phone_ready'); assert.equal(reopened.status(actor).pending, null);
  assert.deepEqual(f.calls, { mailbox: 1, buy: 1, poll: 0, inspect: 3, start: 0, complete: 0 });
  delete f.hooks.inspect;
  assert.equal((await reopened.advance(actor, { stopAfter: 'awaiting_otp' })).phase, 'awaiting_otp');
  assert.deepEqual(f.calls, { mailbox: 1, buy: 1, poll: 0, inspect: 4, start: 1, complete: 0 });
});

test('public/test-only mailbox capability blocks real signup and SMS before spending', async t => {
  for (const capability of [{ verified: true, privateMailbox: false, testOnly: true },
    { verified: false, privateMailbox: true }, { verified: true, privateMailbox: true, testOnly: true }]) {
    const f = await fixture(t); f.config.mailbox.capabilities = async () => capability;
    await reject(() => f.coordinator.advance(actor), 'private_mailbox_required');
    assert.equal(f.calls.mailbox, 0); assert.equal(f.calls.buy, 0); assert.equal(f.calls.start, 0);
  }
});

test('merchant page and private email are ready before SMS, with a second page check after mailbox creation', async t => {
  const f = await fixture(t);
  f.hooks.inspect = () => ({ verified: false });
  await reject(() => f.coordinator.advance(actor), 'merchant_registration_page_unverified');
  assert.equal(f.calls.mailbox, 0); assert.equal(f.calls.buy, 0);
  delete f.hooks.inspect;
  f.hooks.mailbox = async ({ onEmail }) => {
    await onEmail('activation-private@example.test');
    f.hooks.inspect = () => ({ verified: false });
  };
  await reject(() => f.coordinator.advance(actor), 'merchant_registration_page_unverified');
  assert.equal(f.calls.mailbox, 1); assert.equal(f.calls.buy, 0);
  assert.equal(f.coordinator.status(actor).phase, 'mailbox_ready');
  delete f.hooks.inspect; await f.coordinator.advance(actor);
  assert.equal(f.calls.mailbox, 1); assert.equal(f.calls.buy, 1);
});

test('existing customers are routed to existing login without mailbox creation or a fresh number', async t => {
  const f = await fixture(t, { accounts: [{ ...actor, newCustomer: false }] });
  const result = await f.coordinator.advance({ ...actor, newCustomer: true });
  assert.equal(result.nextAction, 'sign_in_existing_account');
  assert.deepEqual(f.calls, { mailbox: 0, buy: 0, poll: 0, inspect: 0, start: 0, complete: 0 });
});

test('registry ownership and persistent identity cannot be replaced to create another account', async t => {
  const f = await fixture(t);
  assert.throws(() => f.coordinator.status(other), { code: 'onboarding_account_not_owned' });
  await reject(() => f.coordinator.advance({ ...actor, merchantAccountId: other.merchantAccountId }), 'onboarding_account_not_owned');
  assert.throws(() => createCustomerOnboarding({ ...f.config, accounts: [{ ...actor, newCustomer: true },
    { ...actor, merchantAccountId: 'another', newCustomer: true }] }), { code: 'one_account_per_customer_required' });
  assert.throws(() => createCustomerOnboarding({ ...f.config, accounts: [{ ...actor, merchantAccountId: 'another', newCustomer: true }] }), { code: 'onboarding_account_binding_changed' });
  assert.throws(() => createCustomerOnboarding({ ...f.config, accounts: [{ ...actor, newCustomer: false }] }), { code: 'onboarding_account_binding_changed' });
});

test('uncertain mailbox creation blocks automatic repeats on restart; evidenced operator adoption reuses the mailbox', async t => {
  const f = await fixture(t);
  f.hooks.mailbox = async ({ onEmail }) => { await onEmail('activation-private@example.test'); throw new Error('private provider response'); };
  await reject(() => f.coordinator.advance(actor), 'onboarding_reconciliation_required');
  const reopened = createCustomerOnboarding(f.config);
  await reject(() => reopened.advance(actor), 'onboarding_reconciliation_required');
  assert.equal(f.calls.mailbox, 1); assert.equal(f.calls.buy, 0);
  const operationId = reopened.status(actor).pending.operationId;
  await reject(() => reopened.operatorReconcile(actor, { operationId, outcome: 'new', ...evidence('operator-review') }), 'onboarding_reconciliation_mismatch');
  await reopened.operatorReconcile(actor, { operationId, outcome: 'mailbox_ready', ...evidence('operator-review') });
  const reconciliations = (await f.snapshot()).entries[actor.customerId].reconciliations;
  assert.deepEqual(reconciliations, [{ ...actor, operationId, operation: 'create_mailbox', outcome: 'mailbox_ready',
    ...evidence('operator-review'), resolvedAt: now }]);
  await reopened.advance(actor);
  assert.equal(f.calls.mailbox, 1); assert.equal(f.calls.buy, 1);
});

test('uncertain paid SMS and merchant submission never trigger a second purchase or signup', async t => {
  for (const stage of ['buy', 'start', 'complete']) {
    const f = await fixture(t);
    f.hooks[stage] = async () => { throw new Error('unknown after dispatch'); };
    await reject(() => f.coordinator.advance(actor), 'onboarding_reconciliation_required');
    const reopened = createCustomerOnboarding(f.config);
    await reject(() => reopened.advance(actor), 'onboarding_reconciliation_required');
    assert.equal(f.calls.buy, 1); assert.equal(f.calls.mailbox, 1);
    assert.ok(f.calls.start <= 1); assert.ok(f.calls.complete <= 1);
    assert.equal(reopened.status(actor).sms.purchaseAttempts, 1);
  }
});

test('operator can release only a proven unused SMS reservation, preserving mailbox and reconciliation evidence', async t => {
  const f = await fixture(t);
  f.hooks.buy = async () => { throw Object.assign(new Error('provider_pre_purchase_check_failed'), { dispatched: false }); };
  await reject(() => f.coordinator.advance(actor, { stopAfter: 'phone_ready' }), 'onboarding_reconciliation_required');
  const operationId = f.coordinator.status(actor).pending.operationId;
  await reject(() => f.coordinator.advance(actor, { stopAfter: 'phone_ready' }), 'onboarding_reconciliation_required');
  f.config.sms.publicStatus = async () => ({ paidEnabled: true, purchaseConfigurationValid: true, purchaseBlocker: null,
    usdAuthorization: { currency: 'USD', totalMinor: 20, maxPurchases: 1 }, entries: [], needsReconciliation: false,
    knownCostMinor: 0, reservedMinor: 0, costComplete: true });
  const reopened = createCustomerOnboarding(f.config);
  const released = await reopened.operatorReconcile(actor, { operationId, outcome: 'sms_not_dispatched', ...evidence('pre-purchase-ledger-review') });
  assert.equal(released.phase, 'mailbox_ready'); assert.equal(released.pending, null); assert.equal(released.sms.purchaseAttempts, 0);
  const saved = await f.snapshot(), record = saved.entries[actor.customerId].reconciliations[0];
  assert.deepEqual(record, { ...actor, operationId, operation: 'buy_sms', outcome: 'sms_not_dispatched',
    ...evidence('pre-purchase-ledger-review'), resolvedAt: now, releasedUnusedReservation: true,
    smsLedger: { entries: 0, knownCostMinor: 0, reservedMinor: 0, costComplete: true } });
  await reject(() => reopened.operatorReconcile(actor, { operationId, outcome: 'sms_not_dispatched', ...evidence('replay') }), 'onboarding_reconciliation_mismatch');
  delete f.hooks.buy;
  const ready = await createCustomerOnboarding(f.config).advance(actor, { stopAfter: 'phone_ready' });
  assert.equal(ready.phase, 'phone_ready'); assert.equal(ready.sms.purchaseAttempts, 1);
  assert.equal(f.calls.mailbox, 1); assert.equal(f.calls.buy, 2); assert.equal(f.calls.start, 0);
});

test('unused SMS release rejects any ledger entry, unknown costs, invalid policy, mismatched operation and incomplete evidence', async t => {
  const f = await fixture(t);
  f.hooks.buy = async () => { throw new Error('purchase outcome unknown'); };
  await reject(() => f.coordinator.advance(actor, { stopAfter: 'phone_ready' }), 'onboarding_reconciliation_required');
  const operationId = f.coordinator.status(actor).pending.operationId;
  const resolution = { operationId, outcome: 'sms_not_dispatched', ...evidence('operator-review') };
  const valid = { paidEnabled: true, purchaseConfigurationValid: true, purchaseBlocker: null,
    usdAuthorization: { currency: 'USD', totalMinor: 20, maxPurchases: 1 }, entries: [], needsReconciliation: false,
    knownCostMinor: 0, reservedMinor: 0, costComplete: true };
  for (const change of [
    { entries: [{ state: 'buy_pending' }] }, { entries: [{ state: 'owned', costMinor: 1 }] },
    { entries: [{ state: 'buy_uncertain' }] }, { entries: undefined }, { needsReconciliation: true },
    { needsReconciliation: undefined }, { knownCostMinor: 1 }, { knownCostMinor: undefined },
    { reservedMinor: 1 }, { reservedMinor: undefined }, { costComplete: false }, { costComplete: undefined },
    { paidEnabled: false }, { purchaseConfigurationValid: false }, { purchaseBlocker: 'store_policy_mismatch' },
    { purchaseBlocker: undefined }, { usdAuthorization: null },
    { usdAuthorization: { currency: 'USD', totalMinor: 21, maxPurchases: 1 } },
    { usdAuthorization: { currency: 'USD', totalMinor: 20, maxPurchases: 2 } },
  ]) {
    f.config.sms.publicStatus = async () => ({ ...valid, ...change });
    await reject(() => f.coordinator.operatorReconcile(actor, resolution), 'sms_not_dispatched_not_proven');
    assert.equal(f.coordinator.status(actor).sms.purchaseAttempts, 1);
    assert.equal(f.coordinator.status(actor).pending.operationId, operationId);
  }
  f.config.sms.publicStatus = async () => { throw new Error('status unavailable'); };
  await reject(() => f.coordinator.operatorReconcile(actor, resolution), 'sms_not_dispatched_not_proven');
  f.config.sms.publicStatus = async () => valid;
  await reject(() => f.coordinator.operatorReconcile(actor, { ...resolution, operationId: 'another-operation' }), 'onboarding_reconciliation_mismatch');
  await reject(() => f.coordinator.operatorReconcile(other, resolution), 'onboarding_account_not_owned');
  assert.equal((await f.snapshot()).entries[actor.customerId].reconciliations.length, 0);

  const mailboxFailure = await fixture(t);
  mailboxFailure.hooks.mailbox = async () => { throw new Error('mailbox uncertain'); };
  await reject(() => mailboxFailure.coordinator.advance(actor), 'onboarding_reconciliation_required');
  const mailboxOperation = mailboxFailure.coordinator.status(actor).pending.operationId;
  await reject(() => mailboxFailure.coordinator.operatorReconcile(actor, { ...resolution, operationId: mailboxOperation }), 'onboarding_reconciliation_mismatch');
});

test('a recorded pending intent blocks restart even before a provider returns', async t => {
  const f = await fixture(t); let release;
  f.hooks.mailbox = async ({ onEmail }) => { await new Promise(resolve => { release = resolve; }); await onEmail('activation-private@example.test'); };
  const work = f.coordinator.advance(actor);
  while (!release) await new Promise(resolve => setImmediate(resolve));
  const reopened = createCustomerOnboarding(f.config);
  await reject(() => reopened.advance(actor), 'onboarding_reconciliation_required');
  assert.equal(f.calls.mailbox, 1); release(); await work;
});

test('known polling timeout retries only the existing activation and mailbox', async t => {
  const f = await fixture(t);
  f.hooks.poll = async () => ({ state: 'poll_timeout' });
  const waiting = await f.coordinator.advance(actor);
  assert.equal(waiting.phase, 'awaiting_otp'); assert.equal(waiting.pending, null);
  delete f.hooks.poll; const done = await createCustomerOnboarding(f.config).advance(actor);
  assert.equal(done.phase, 'registered');
  assert.equal(f.calls.poll, 2); assert.equal(f.calls.buy, 1); assert.equal(f.calls.start, 1); assert.equal(f.calls.mailbox, 1);
});

test('SMS authorization cannot exceed twenty cents/one purchase and existing provider reservations block buying', async t => {
  const f = await fixture(t);
  for (const smsAuthorization of [{ currency: 'USD', totalMinor: 21, maxPurchases: 1 },
    { currency: 'USD', totalMinor: 20, maxPurchases: 2 }]) {
    assert.throws(() => createCustomerOnboarding({ ...f.config, smsAuthorization }), { code: 'invalid_onboarding_config' });
  }
  f.config.sms.publicStatus = async () => ({ paidEnabled: true, entries: [{}] });
  await reject(() => f.coordinator.advance(actor), 'sms_not_ready'); assert.equal(f.calls.buy, 0);
  f.config.sms.publicStatus = async () => ({ paidEnabled: true, purchaseConfigurationValid: true, entries: [], usdAuthorization: { currency: 'USD', totalMinor: 50, maxPurchases: 1 } });
  await reject(() => f.coordinator.advance(actor), 'sms_budget_mismatch'); assert.equal(f.calls.buy, 0);
});

test('missing private mailbox data stops before paid SMS and vault errors never expose private text', async t => {
  const f = await fixture(t);
  f.hooks.mailbox = async ({ onEmail }) => {
    await onEmail('activation-private@example.test');
    f.config.vault.withSecret = async () => { throw new Error('private-mailbox-secret'); };
  };
  await reject(() => f.coordinator.advance(actor), 'private_contact_unavailable');
  assert.equal(f.calls.buy, 0); assert.equal(f.calls.mailbox, 1);
  assert.equal(f.coordinator.status(actor).phase, 'mailbox_ready');
  assert.equal(JSON.stringify(await f.snapshot()).includes('private-mailbox-secret'), false);
});

test('notifications require separately verified real contacts and evidenced order events; no authentication content is forwarded', async t => {
  const f = await fixture(t); await f.coordinator.advance(actor);
  const event = { ...actor, type: 'order_confirmed', orderId: 'observed-order', verified: true, ...evidence('order-evidence') };
  await reject(() => f.coordinator.prepareOrderNotification(actor, event, () => {}), 'verified_notification_contact_required');
  await reject(() => f.coordinator.setNotificationContact(actor, { kind: 'phone', value: '+48123456789',
    verification: { verified: true, purpose: 'notifications', source: 'sms_activation', ...evidence('sms') } }), 'notification_contact_verification_required');
  await f.coordinator.setNotificationContact(actor, { kind: 'email', value: 'real-notification@example.test',
    verification: { ...actor, kind: 'email', contactHash: notificationContactHash({...actor,kind:'email',value:'real-notification@example.test'}),
      verified: true, purpose: 'notifications', source: 'verified_real_contact', ...evidence('real-contact') } });
  let prepared;
  const result = await f.coordinator.prepareOrderNotification(actor, event, payload => { prepared = payload; });
  assert.deepEqual(prepared.to, { email: 'real-notification@example.test' }); assert.equal(prepared.kind, 'order_status');
  assert.equal(result.prepared, true); assert.deepEqual(result.channels, ['email']);
  assert.equal(JSON.stringify([result, await f.snapshot(), f.coordinator.status(actor)]).includes('real-notification@example.test'), false);
  for (const invalid of [{ ...event, type: 'login_otp' }, { ...event, verified: false },
    { ...event, merchantAccountId: 'another' }, { ...event, body: 'authentication mail' }]) {
    await reject(() => f.coordinator.prepareOrderNotification(actor, invalid, () => {}), 'verified_order_event_required');
  }
});

test('hackathon public-mailbox exception requires explicit consent, exact FVI capability and one persistent customer', async t => {
  const base = await fixture(t);
  for (const extra of [{mode:'hackathon'}, {mode:'hackathon',publicMailboxTestConsent:true,
    accounts:[{...actor,newCustomer:true},{...other,newCustomer:true}]}]) {
    assert.throws(() => createCustomerOnboarding({...base.config,...extra}), {code:'hackathon_single_account_consent_required'});
  }
  const f = await fixture(t, {mode:'hackathon',publicMailboxTestConsent:true});
  f.config.mailbox.capabilities = async () => ({verified:true,privateMailbox:false,publicMailbox:true,testOnly:true,origin:'https://fviainboxes.com'});
  const result = await f.coordinator.advance(actor);
  assert.equal(result.mode, 'hackathon');
  assert.equal(result.publicMailboxTestConsent, true);
  assert.equal(result.productionReady, false);
  assert.equal(result.phase, 'registered');
  assert.equal(result.sms.purchaseAttempts, 1);
  assert.equal((await f.snapshot()).mode, 'hackathon');
  await createCustomerOnboarding(f.config).advance(actor);
  assert.equal(f.calls.buy, 1);
  assert.throws(() => createCustomerOnboarding({...f.config,accounts:[{...other,newCustomer:true}]}), {code:'hackathon_single_account_required'});
  assert.throws(() => createCustomerOnboarding({...f.config,mode:'fixture'}), {code:'onboarding_store_invalid'});
});

test('hackathon consent cannot open real mode or allow a different/unverified public mailbox service', async t => {
  const publicCapability = {verified:true,privateMailbox:false,publicMailbox:true,testOnly:true,origin:'https://fviainboxes.com'};
  const real = await fixture(t, {publicMailboxTestConsent:true});
  real.config.mailbox.capabilities = async () => publicCapability;
  await reject(() => real.coordinator.advance(actor), 'private_mailbox_required');
  for (const extra of [{origin:'https://other.example'}, {verified:false}, {testOnly:false}, {publicMailbox:false}]) {
    const f = await fixture(t, {mode:'hackathon',publicMailboxTestConsent:true});
    f.config.mailbox.capabilities = async () => ({...publicCapability,...extra});
    await reject(() => f.coordinator.advance(actor), 'hackathon_mailbox_scope_mismatch');
    assert.equal(f.calls.mailbox, 0); assert.equal(f.calls.buy, 0);
  }
});

test('missing, incomplete or invalid effective SMS cap blocks before any reservation or paid request', async t => {
  const f = await fixture(t);
  for (const usdAuthorization of [undefined, null, {}, {currency:'USD',maxPurchases:1},
    {currency:'USD',totalMinor:'20',maxPurchases:1}, {currency:'USD',totalMinor:0,maxPurchases:1},
    {currency:'USD',totalMinor:20,maxPurchases:2}]) {
    f.config.sms.publicStatus = async () => ({paidEnabled:true,purchaseConfigurationValid:true,entries:[],usdAuthorization});
    await reject(() => f.coordinator.advance(actor), 'sms_budget_mismatch');
    assert.equal(f.calls.buy, 0); assert.equal(f.coordinator.status(actor).sms.purchaseAttempts, 0);
  }
  f.config.sms.publicStatus = async () => ({paidEnabled:true,purchaseConfigurationValid:false,entries:[],
    usdAuthorization:{currency:'USD',totalMinor:20,maxPurchases:1}});
  await reject(() => f.coordinator.advance(actor), 'sms_budget_mismatch');
});

test('fresh real SMS adapter exposes its configured cap so a larger first-buy authorization cannot bypass onboarding', async t => {
  const f = await fixture(t);
  let fetchCalls = 0, writes = 0;
  const store = createFiveSimStore({durableWrite:async()=>{writes++;}});
  const sms = createFiveSimAdapter({paidEnabled:true,token:'fictional-test-token',store,exclusiveProviderAccount:true,
    now:()=>now,fetchImpl:async()=>{fetchCalls++;throw new Error('must not call');},
    service:{country:'poland',product:'fictionalservice',verified:true,merchantCompatible:true,
      evidenceUrl:'https://example.test/service',compatibilityEvidenceUrl:'https://example.test/compatibility'},
    budget:{currency:'TEST_COIN',exponent:2,totalMinor:50,perOrderMinor:30,currencyVerified:true,
      currencyEvidence:'https://example.test/currency',authorization:{currency:'USD',totalMinor:50,maxPurchases:1},
      conversion:{verified:true,includesFees:true,usdMicrosPerUnit:1_000_000,evidenceUrl:'https://example.test/fx',validUntil:now+60_000}}});
  const status = await sms.publicStatus();
  assert.equal(status.purchaseConfigurationValid, true);
  assert.equal(status.usdAuthorization.totalMinor, 50);
  const coordinator = createCustomerOnboarding({...f.config,sms});
  await reject(() => coordinator.advance(actor), 'sms_budget_mismatch');
  assert.equal(fetchCalls, 0); assert.equal(writes, 0);
  assert.equal(coordinator.status(actor).sms.purchaseAttempts, 0);
});

test('reconciled registration retains owner, operation and exact evidence across restart without another submission', async t => {
  const f = await fixture(t);
  f.hooks.complete = async () => {throw new Error('unknown registration response');};
  await reject(() => f.coordinator.advance(actor), 'onboarding_reconciliation_required');
  const operationId = f.coordinator.status(actor).pending.operationId;
  await f.coordinator.operatorReconcile(actor, {operationId,outcome:'registered',...evidence('confirmed-registration'),secret:'must-not-persist'});
  const entry = (await f.snapshot()).entries[actor.customerId];
  assert.equal(entry.registrationEvidence.source, 'operator_reconciliation');
  assert.equal(entry.registrationEvidence.evidenceId, 'confirmed-registration');
  assert.equal(entry.registrationEvidence.operationId, operationId);
  assert.equal(entry.registrationEvidence.customerId, actor.customerId);
  assert.equal(entry.reconciliations.length, 1);
  assert.equal(JSON.stringify(entry).includes('must-not-persist'), false);
  assert.equal((await createCustomerOnboarding(f.config).advance(actor)).phase, 'registered');
  assert.equal(f.calls.complete, 1); assert.equal(f.calls.buy, 1);
});

test('notification verification cannot transfer across owners, channel kinds or contact values; vault drift is rejected', async t => {
  const f = await fixture(t,{accounts:[{...actor,newCustomer:false},{...other,newCustomer:false}]});
  const value='Owner@EXAMPLE.test';
  const verification={...actor,kind:'email',contactHash:notificationContactHash({...actor,kind:'email',value}),
    verified:true,purpose:'notifications',source:'verified_real_contact',...evidence('contact-proof')};
  for (const [owner,kind,contact] of [[other,'email',value],[actor,'email','different@example.test'],[actor,'phone','+48123456789']]) {
    await reject(()=>f.coordinator.setNotificationContact(owner,{kind,value:contact,verification}),'notification_contact_binding_mismatch');
  }
  assert.equal(f.secrets.size,0);
  await f.coordinator.setNotificationContact(actor,{kind:'email',value:' Owner@EXAMPLE.test ',verification});
  assert.equal(f.secrets.get(`${actor.customerId}:notificationEmail`),'Owner@example.test');
  assert.equal(f.coordinator.status(actor).notificationContacts.emailVerified,true);
  assert.equal(f.coordinator.status(other).notificationContacts.emailVerified,false);
  f.secrets.set(`${actor.customerId}:notificationEmail`,'different@example.test');
  let prepared=false;
  const event={...actor,type:'order_confirmed',orderId:'owned-order',verified:true,...evidence('order-proof')};
  await reject(()=>f.coordinator.prepareOrderNotification(actor,event,()=>{prepared=true;}),'private_notification_consumer_failed');
  assert.equal(prepared,false);
  assert.notEqual(notificationContactHash({...actor,kind:'email',value:'Owner@example.test'}),notificationContactHash({...actor,kind:'email',value:'owner@example.test'}));
});
