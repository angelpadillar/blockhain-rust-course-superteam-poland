import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, access } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runOnboardingOperator } from './onboarding-operator.mjs';

const TOKEN = 'fixture-provider-token-only';
const PHONE = '+48123123123';
const FOLLOWUP_PHONE = '+48234234234';
const OTP = '583921';
const EMAIL = 'fixture-only@fviainboxes.com';
const account = { customerId: 'fixture-customer', merchantAccountId: 'fixture-merchant', newCustomer: true };
async function fixture(t) {
  const privateDir = await mkdtemp(join(tmpdir(), 'delio-operator-'));
  t.after(() => rm(privateDir, { recursive: true, force: true }));
  const budget = { currency: 'USD', exponent: 6, totalMinor: 200000, perOrderMinor: 200000,
    currencyVerified: true, currencyEvidence: 'https://example.test/fixture-usd',
    authorization: { currency: 'USD', totalMinor: 20, maxPurchases: 1 },
    conversion: { usdMicrosPerUnit: 1000000, verified: true, includesFees: true,
      evidenceUrl: 'https://example.test/fixture-conversion', validUntil: Date.now() + 3600000 } };
  const config = { mode: 'hackathon', publicMailboxTestConsent: true, account, paidSmsEnabled: true, budget,
    service: { country: 'poland', product: 'zabkajush', verified: true, merchantCompatible: true,
      evidenceUrl: 'https://example.test/fixture-service', compatibilityEvidenceUrl: 'https://example.test/fixture-compatibility' } };
  await writeFile(join(privateDir, 'onboarding-config.json'), JSON.stringify(config), { mode: 0o600 });
  await writeFile(join(privateDir, 'fivesim-token.txt'), TOKEN, { mode: 0o600 });
  await writeFile(join(privateDir, 'mailbox-smoke.json'), JSON.stringify({ publicInboxConsent: true,
    purpose: 'single_authorized_hackathon_account', email: EMAIL }), { mode: 0o600 });
  const calls = [], merchantCalls = [], orders = [], hooks = {};
  const read = async (file, attempt = 'initial') => JSON.parse(await readFile(join(privateDir,
    attempt === 'initial' ? 'onboarding' : 'onboarding-virtual53', file), 'utf8'));
  const fetchImpl = async (url, options) => {
    const parsed = new URL(url); calls.push(parsed.pathname);
    assert.equal(parsed.origin, 'https://5sim.net');
    assert.equal(options.method, 'GET');
    if (parsed.pathname === '/v1/guest/prices') {
      assert.equal(options.headers.Authorization, undefined);
      assert.equal(parsed.searchParams.get('country'), 'poland'); assert.equal(parsed.searchParams.get('product'), 'zabkajush');
      return Response.json({ poland: { zabkajush: { virtual53: { count: 3, cost: '0.1538' } } } });
    }
    assert.equal(options.headers.Authorization, `Bearer ${TOKEN}`);
    if (parsed.pathname === '/v1/user/orders') return Response.json({ Data: orders, Total: orders.length });
    if (parsed.pathname.startsWith('/v1/user/buy/')) {
      const named = parsed.pathname.includes('/virtual53/'), attempt = named ? 'virtual53' : 'initial';
      const coordinator = await read('customer-onboarding.json', attempt), ledger = await read('sms-ledger.json', attempt);
      assert.equal(coordinator.entries[account.customerId].pending.operation, 'buy_sms');
      assert.equal(coordinator.smsPurchaseAttempts, 1); assert.equal(ledger.entries[0].phase, 'buy_pending');
      assert.equal(parsed.pathname, `/v1/user/buy/activation/poland/${named ? 'virtual53' : 'any'}/zabkajush`);
      assert.equal(parsed.searchParams.get('maxPrice'), named ? null : '0.200000');
      const order = { id: named ? 102 : 101, product: 'zabkajush', country: 'poland', operator: named ? 'virtual53' : 'fixture-any',
        phone: named ? FOLLOWUP_PHONE : PHONE, price: named ? '0.1538' : '0.1269', status: 'RECEIVED',
        created_at: new Date().toISOString(), expires: new Date(Date.now() + 600000).toISOString(), sms: [{ code: OTP }] };
      orders.push(order);
      if (hooks.buy) return hooks.buy(order);
      return Response.json(order);
    }
    if (/^\/v1\/user\/check\/(101|102)$/.test(parsed.pathname)) {
      const order = orders.find(row => String(row.id) === parsed.pathname.split('/').at(-1));
      if (hooks.check) return hooks.check(order);
      return Response.json(order);
    }
    if (['/v1/user/cancel/101', '/v1/user/finish/101'].includes(parsed.pathname)) {
      const operation = parsed.pathname.split('/')[3], ledger = await read('sms-ledger.json');
      assert.equal(ledger.entries[0].pendingMutation, operation);
      orders[0].status = operation === 'cancel' ? 'CANCELED' : 'FINISHED';
      if (hooks.cleanup) return hooks.cleanup(orders[0]);
      return Response.json(orders[0]);
    }
    throw new Error('unexpected_fixture_provider_path');
  };
  const invoke = async payload => {
    merchantCalls.push(structuredClone(payload));
    const evidence = { observedAt: Date.now(), evidenceRefs: [{ id: 'fixture-merchant-observation' }] };
    if (payload.operation === 'inspectRegistration') return { ok: true, result: {
      phoneFieldObserved: true, fields: [{ kind: 'phone' }], phoneSubmissionReady: hooks.phoneReady !== false, ...evidence } };
    if (payload.operation === 'startFollowupRegistration') {
      const followup = await read('customer-onboarding.json', 'virtual53');
      assert.equal(followup.entries[account.customerId].pending.operation, 'start_registration');
      assert.deepEqual(payload, { operation: 'startFollowupRegistration', accountId: account.merchantAccountId,
        phone: FOLLOWUP_PHONE, previousPhone: PHONE, previousActivationStatus: 'TIMEOUT', approvalId: 'virtual53-test' });
      if (hooks.followup) return hooks.followup(payload);
      return { ok: true, result: { otpRequired: true, ...evidence } };
    }
    const coordinator = await read('customer-onboarding.json');
    if (payload.operation === 'startRegistration') {
      assert.equal(coordinator.entries[account.customerId].pending.operation, 'start_registration');
      assert.equal(payload.phone, PHONE);
      if (hooks.start) return hooks.start(payload);
      return { ok: true, result: { otpRequired: true } };
    }
    if (payload.operation === 'completeRegistration') {
      assert.equal(coordinator.entries[account.customerId].pending.operation, 'complete_registration');
      assert.equal(payload.otp, OTP);
      return { ok: true, result: { registered: true, ...evidence } };
    }
    if (payload.operation === 'resumeRegistration') {
      assert.equal(coordinator.entries[account.customerId].pending.operation, 'start_registration');
      assert.deepEqual(payload, { operation: 'resumeRegistration', accountId: account.merchantAccountId, phone: PHONE });
      if (hooks.resume) return hooks.resume(payload);
      return { ok: true, result: { otpFieldObserved: true, ...evidence } };
    }
    if (payload.operation === 'inspectRegistrationState') {
      assert.deepEqual(payload, { operation: 'inspectRegistrationState' });
      if (hooks.registrationState) return hooks.registrationState(payload);
      return { ok: true, result: { otpFieldObserved: true, ...evidence } };
    }
    throw new Error('unexpected_fixture_merchant_operation');
  };
  return { privateDir, config, calls, merchantCalls, hooks, orders, read,
    run: options => runOnboardingOperator({ privateDir, fetchImpl, invoke, ...options }) };
}

test('operator status and mailbox preparation make no paid/provider requests', async t => {
  const f = await fixture(t);
  const initial = await f.run({ action: 'status' }); assert.equal(initial.onboarding.phase, 'new');
  const prepared = await f.run({ action: 'advance', stopAfter: 'mailbox_ready' });
  assert.equal(prepared.phase, 'mailbox_ready'); assert.deepEqual(f.calls, []);
  assert.deepEqual(f.merchantCalls.map(call => call.operation), ['inspectRegistration']);
  await assert.rejects(access(join(f.privateDir, 'onboarding', 'owner.lock')), { code: 'ENOENT' });
});

test('operator stages buy once, start only on request, poll privately and complete without replay across fresh invocations', async t => {
  const f = await fixture(t);
  assert.equal((await f.run({ action: 'advance', stopAfter: 'phone_ready' })).phase, 'phone_ready');
  assert.equal(f.calls.filter(path => path.includes('/buy/')).length, 1);
  assert.equal(f.merchantCalls.filter(call => call.operation === 'startRegistration').length, 0);
  await f.run({ action: 'advance', stopAfter: 'phone_ready' });
  assert.equal(f.calls.length, 2); // bounded provider history + one purchase only
  assert.equal((await f.run({ action: 'advance', stopAfter: 'awaiting_otp' })).phase, 'awaiting_otp');
  assert.equal(f.calls.length, 2); // no poll until the operator requests it
  assert.equal((await f.run({ action: 'advance', stopAfter: 'otp_ready' })).phase, 'otp_ready');
  assert.equal(f.merchantCalls.filter(call => call.operation === 'completeRegistration').length, 0);
  assert.equal((await f.run({ action: 'advance', stopAfter: 'registered' })).phase, 'registered');
  const final = await f.run({ action: 'advance' }); assert.equal(final.phase, 'registered');
  assert.equal(f.calls.filter(path => path.includes('/buy/')).length, 1);
  assert.equal(f.merchantCalls.filter(call => call.operation === 'startRegistration').length, 1);
  assert.equal(f.merchantCalls.filter(call => call.operation === 'completeRegistration').length, 1);
  const status = await f.run({ action: 'status' });
  const safe = JSON.stringify([status, await f.read('customer-onboarding.json'), await f.read('sms-ledger.json')])
    + await readFile(join(f.privateDir, 'onboarding', 'operator-attempts.jsonl'), 'utf8');
  for (const secret of [TOKEN, PHONE, OTP, EMAIL]) assert.equal(safe.includes(secret), false);
});

test('unverified phone-submit state and missing consent block before a paid request', async t => {
  const f = await fixture(t); f.hooks.phoneReady = false;
  await assert.rejects(f.run({ action: 'advance', stopAfter: 'phone_ready' }), /merchant_registration_page_unverified/);
  assert.deepEqual(f.calls, []);
  f.config.publicMailboxTestConsent = false;
  await writeFile(join(f.privateDir, 'onboarding-config.json'), JSON.stringify(f.config));
  await assert.rejects(f.run({ action: 'advance', stopAfter: 'phone_ready' }), /single_test_consent_required/);
  assert.deepEqual(f.calls, []);
});

test('lost purchase response records uncertainty and never buys again after restarting the operator', async t => {
  const f = await fixture(t);
  f.hooks.buy = () => { throw new Error(`fixture transport lost ${TOKEN}`); };
  await assert.rejects(f.run({ action: 'advance', stopAfter: 'phone_ready' }), /^Error: onboarding_reconciliation_required$/);
  await assert.rejects(f.run({ action: 'advance', stopAfter: 'phone_ready' }), /^Error: onboarding_reconciliation_required$/);
  const status = await f.run({ action: 'status' });
  assert.equal(status.sms.needsReconciliation, true); assert.equal(status.sms.reservedMinor, 200000);
  assert.equal(f.calls.filter(path => path.includes('/buy/')).length, 1);
  assert.equal(f.merchantCalls.some(call => call.operation === 'startRegistration'), false);
});

test('provider expiry while awaiting OTP preserves the owned attempt without implicit cancellation/rebuy', async t => {
  const f = await fixture(t);
  await f.run({ action: 'advance', stopAfter: 'awaiting_otp' });
  f.hooks.check = order => Response.json({ ...order, status: 'TIMEOUT', sms: [] });
  await assert.rejects(f.run({ action: 'advance', stopAfter: 'otp_ready' }), /onboarding_reconciliation_required/);
  const status = await f.run({ action: 'status' });
  assert.equal(status.sms.entries[0].status, 'TIMEOUT'); assert.equal(status.onboarding.phase, 'reconciliation_required');
  assert.equal(f.calls.some(path => path.includes('/cancel/') || path.includes('/finish/')), false);
  assert.equal(f.calls.filter(path => path.includes('/buy/')).length, 1);
});

test('invalid stage arguments are rejected before being retained in private operator journals', async t => {
  const f = await fixture(t), invalid = 'private-text-that-must-not-be-journaled@example.test';
  await assert.rejects(f.run({ action: 'advance', stopAfter: invalid }));
  let journal = '';
  try { journal = await readFile(join(f.privateDir, 'onboarding', 'operator-attempts.jsonl'), 'utf8'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  assert.equal(journal.includes(invalid), false); assert.deepEqual(f.calls, []); assert.deepEqual(f.merchantCalls, []);
});

test('exclusive operator lock prevents another invocation from calling a provider', async t => {
  const f = await fixture(t), dir = join(f.privateDir, 'onboarding');
  await mkdir(dir, { recursive: true }); await writeFile(join(dir, 'owner.lock'), 'fixture-owner');
  await assert.rejects(f.run({ action: 'advance', stopAfter: 'phone_ready' }), /onboarding_owner_busy_review_lock/);
  assert.deepEqual(f.calls, []); assert.deepEqual(f.merchantCalls, []);
  assert.equal(await readFile(join(dir, 'owner.lock'), 'utf8'), 'fixture-owner');
});

test('explicit cleanup is limited to the owned activation and correct registration stage', async t => {
  const f = await fixture(t);
  await assert.rejects(f.run({ action: 'cancel' }), /cleanup_requires_owned_reconciled_activation/);
  await f.run({ action: 'advance', stopAfter: 'phone_ready' });
  await assert.rejects(f.run({ action: 'finish' }), /cleanup_stage_mismatch/);
  assert.equal(f.calls.some(path => path.includes('/finish/')), false);
  const canceled = await f.run({ action: 'cancel' }); assert.equal(canceled.status, 'CANCELED');
  const merchantCount = f.merchantCalls.length;
  await assert.rejects(f.run({ action: 'advance', stopAfter: 'awaiting_otp' }));
  assert.equal(f.merchantCalls.length, merchantCount, 'canceled activation must not be submitted to merchant');
  assert.equal(f.calls.filter(path => path.includes('/buy/')).length, 1);
  assert.equal(f.calls.filter(path => path.includes('/cancel/')).length, 1);

  const completed = await fixture(t);
  await completed.run({ action: 'advance' });
  await assert.rejects(completed.run({ action: 'cancel' }), /cleanup_stage_mismatch/);
  const finished = await completed.run({ action: 'finish' }); assert.equal(finished.status, 'FINISHED');
  assert.equal((await completed.run({ action: 'advance' })).phase, 'registered');
  assert.equal(completed.calls.filter(path => path.includes('/finish/')).length, 1);
  assert.equal(completed.calls.some(path => path.includes('/cancel/')), false);
});

test('uncertain cleanup is retained and a later operator invocation cannot repeat the mutation', async t => {
  const f = await fixture(t); await f.run({ action: 'advance', stopAfter: 'phone_ready' });
  f.hooks.cleanup = () => { throw new Error('fixture cleanup response lost'); };
  await assert.rejects(f.run({ action: 'cancel' }), /mutation_uncertain_reconcile_required/);
  await assert.rejects(f.run({ action: 'cancel' }), /cleanup_requires_owned_reconciled_activation/);
  const status = await f.run({ action: 'status' });
  assert.equal(status.sms.entries[0].pendingMutation, 'cancel'); assert.equal(status.sms.needsReconciliation, true);
  assert.equal(f.calls.filter(path => path.includes('/cancel/')).length, 1);
});

async function pendingPhoneSubmit(f) {
  f.hooks.start = () => ({ ok: false, code: 'phone_submit_uncertain', result: {
    status: 'phone_submit_uncertain', observedAt: Date.now(), evidenceRefs: [{ id: 'first-uncertain-submit' }],
  } });
  await assert.rejects(f.run({ action: 'advance', stopAfter: 'awaiting_otp' }), /onboarding_reconciliation_required/);
  f.orders[0].sms = []; // Provider fixture reports no message for the uncertain submission.
  return (await f.read('customer-onboarding.json')).entries[account.customerId].pending.operationId;
}

test('explicit phone retry uses the same private number without another buy and records OTP adoption while retaining first uncertainty', async t => {
  const f = await fixture(t), operationId = await pendingPhoneSubmit(f), providerCalls = f.calls.length;
  const result = await f.run({ action: 'retry-phone-submit' });
  assert.equal(result.phase, 'awaiting_otp'); assert.equal(result.pending, null);
  assert.deepEqual(f.calls.slice(providerCalls), ['/v1/user/check/101']);
  assert.equal(f.calls.filter(path => path.includes('/buy/')).length, 1);
  assert.equal(f.merchantCalls.filter(call => call.operation === 'resumeRegistration').length, 1);
  const saved = await f.read('customer-onboarding.json'), entry = saved.entries[account.customerId];
  assert.equal(entry.reconciliations.length, 1); assert.equal(entry.reconciliations[0].operationId, operationId);
  assert.equal(entry.reconciliations[0].outcome, 'awaiting_otp'); assert.equal(saved.smsPurchaseAttempts, 1);
  const merchantJournal = await readFile(join(f.privateDir, 'onboarding', 'merchant-attempts.jsonl'), 'utf8');
  const operatorJournal = await readFile(join(f.privateDir, 'onboarding', 'operator-attempts.jsonl'), 'utf8');
  assert.ok(merchantJournal.includes('first-uncertain-submit')); assert.ok(merchantJournal.includes('resumeRegistration'));
  for (const secret of [PHONE, EMAIL, TOKEN, OTP]) assert.equal((merchantJournal + operatorJournal + JSON.stringify(saved)).includes(secret), false);
  await assert.rejects(f.run({ action: 'retry-phone-submit' }), /registration_retry_not_owned/);
  assert.equal(f.merchantCalls.filter(call => call.operation === 'resumeRegistration').length, 1);
});

test('fresh retry guard rejects observed messages, unknown counts, terminal status or expiry before merchant dispatch', async t => {
  for (const response of [
    order => ({ ...order, sms: [{ code: OTP, text: 'private message fixture' }] }),
    order => ({ ...order, sms: null }),
    order => { const result = { ...order }; delete result.sms; return result; },
    order => ({ ...order, sms: 'private malformed message fixture' }),
    order => ({ ...order, sms: [], status: 'TIMEOUT' }),
    order => ({ ...order, sms: [], expires: new Date(Date.now() - 1).toISOString() }),
  ]) {
    const f = await fixture(t), operationId = await pendingPhoneSubmit(f);
    const local = await f.run({ action: 'status' });
    assert.equal(local.sms.entries[0].status, 'RECEIVED'); // Previously observed state is still active.
    const merchantCalls = f.merchantCalls.length, providerCalls = f.calls.length;
    f.hooks.check = order => Response.json(response(order));
    await assert.rejects(f.run({ action: 'retry-phone-submit' }), /registration_retry_sms_not_ready/);
    assert.deepEqual(f.calls.slice(providerCalls), ['/v1/user/check/101']);
    assert.equal(f.merchantCalls.length, merchantCalls);
    assert.equal(f.calls.filter(path => path.includes('/buy/')).length, 1);
    const entry = (await f.read('customer-onboarding.json')).entries[account.customerId];
    assert.equal(entry.pending.operationId, operationId); assert.equal(entry.reconciliations.length, 0);
    const journal = await readFile(join(f.privateDir, 'onboarding', 'operator-attempts.jsonl'), 'utf8')
      + await readFile(join(f.privateDir, 'onboarding', 'merchant-attempts.jsonl'), 'utf8');
    assert.equal(journal.includes(OTP), false); assert.equal(journal.includes('private message fixture'), false);
    assert.equal(journal.includes('private malformed message fixture'), false);
  }
});

test('retry must observe OTP before reconciliation; uncertain or worker-limited retry preserves original pending operation', async t => {
  const f = await fixture(t), operationId = await pendingPhoneSubmit(f);
  f.hooks.resume = () => ({ ok: true, result: { otpFieldObserved: false, observedAt: Date.now(), evidenceRefs: [{ id: 'still-phone' }] } });
  await assert.rejects(f.run({ action: 'retry-phone-submit' }), /otp_stage_unverified/);
  let entry = (await f.read('customer-onboarding.json')).entries[account.customerId];
  assert.equal(entry.pending.operationId, operationId); assert.equal(entry.reconciliations.length, 0);
  f.hooks.resume = () => ({ ok: false, code: 'registration_submit_limit' });
  await assert.rejects(f.run({ action: 'retry-phone-submit' }), /registration_submit_limit/);
  entry = (await f.read('customer-onboarding.json')).entries[account.customerId];
  assert.equal(entry.pending.operationId, operationId); assert.equal(entry.reconciliations.length, 0);
  assert.equal(f.calls.filter(path => path.includes('/buy/')).length, 1);
});

test('adopt OTP stage performs only a state inspection, never phone submission or provider polling', async t => {
  const f = await fixture(t), operationId = await pendingPhoneSubmit(f);
  const providerCalls = f.calls.length, merchantCalls = f.merchantCalls.length;
  const result = await f.run({ action: 'adopt-otp-stage' });
  assert.equal(result.phase, 'awaiting_otp'); assert.equal(f.calls.length, providerCalls);
  assert.deepEqual(f.merchantCalls.slice(merchantCalls), [{ operation: 'inspectRegistrationState' }]);
  const entry = (await f.read('customer-onboarding.json')).entries[account.customerId];
  assert.equal(entry.reconciliations[0].operationId, operationId);
  assert.equal(f.merchantCalls.some(call => call.operation === 'resumeRegistration'), false);
});

test('OTP adoption with an unverified page preserves pending and never dispatches phone or buys again', async t => {
  const f = await fixture(t), operationId = await pendingPhoneSubmit(f);
  f.hooks.registrationState = () => ({ ok: true, result: { otpFieldObserved: false } });
  await assert.rejects(f.run({ action: 'adopt-otp-stage' }), /otp_stage_unverified/);
  const entry = (await f.read('customer-onboarding.json')).entries[account.customerId];
  assert.equal(entry.pending.operationId, operationId); assert.equal(entry.reconciliations.length, 0);
  assert.equal(f.calls.filter(path => path.includes('/buy/')).length, 1);
  assert.equal(f.merchantCalls.some(call => call.operation === 'resumeRegistration'), false);
});

test('retry/adoption require pending registration and exactly its owned active unexpired activation', async t => {
  const f = await fixture(t);
  for (const action of ['retry-phone-submit', 'adopt-otp-stage']) {
    await assert.rejects(f.run({ action }), /registration_retry_not_owned/);
  }
  assert.deepEqual(f.calls, []); assert.deepEqual(f.merchantCalls, []);
  const operationId = await pendingPhoneSubmit(f), original = await f.read('sms-ledger.json');
  const providerCalls = f.calls.length, merchantCalls = f.merchantCalls.length;
  for (const mutate of [
    ledger => { ledger.entries = []; },
    ledger => { ledger.entries.push({ ...ledger.entries[0], reservationId: 'second-activation' }); },
    ledger => { ledger.entries[0].phase = 'buy_uncertain'; },
    ledger => { ledger.entries[0].pendingMutation = 'cancel'; },
    ledger => { ledger.entries[0].status = 'CANCELED'; },
    ledger => { ledger.entries[0].expiresAt = Date.now() - 1; },
    ledger => { ledger.entries[0].reservationId = 'different-reservation'; },
    ledger => { delete ledger.entries[0].expiresAt; },
    ledger => { delete ledger.entries[0].status; },
  ]) {
    const changed = structuredClone(original); mutate(changed);
    await writeFile(join(f.privateDir, 'onboarding', 'sms-ledger.json'), JSON.stringify(changed), { mode: 0o600 });
    for (const action of ['retry-phone-submit', 'adopt-otp-stage']) {
      await assert.rejects(f.run({ action }), /registration_retry_not_owned/);
    }
    assert.equal(f.calls.length, providerCalls); assert.equal(f.merchantCalls.length, merchantCalls);
    assert.equal((await f.read('customer-onboarding.json')).entries[account.customerId].pending.operationId, operationId);
  }
});

async function followupFixture(t) {
  const f = await fixture(t);
  await f.run({ action: 'advance', stopAfter: 'phone_ready' });
  f.orders[0].status = 'TIMEOUT'; f.orders[0].sms = [];
  await f.run({ action: 'refresh-sms' });
  const followupConfig = { ...structuredClone(f.config), additionalTestAuthorized: true,
    approvedNamedOperator: { operator: 'virtual53', expectedPriceMinor: 153800, approvalId: 'virtual53-test', priceCapNotEnforcedAcknowledged: true } };
  followupConfig.budget.totalMinor = 153800; followupConfig.budget.perOrderMinor = 153800;
  await writeFile(join(f.privateDir, 'onboarding-config-virtual53.json'), JSON.stringify(followupConfig), { mode: 0o600 });
  return { ...f, followupConfig };
}

test('authorized Virtual53 follow-up preserves original records, buys once separately and privately supplies old/new numbers after fresh TIMEOUT check', async t => {
  const f = await followupFixture(t);
  const original = await f.read('sms-ledger.json'), oldCoordinator = await f.read('customer-onboarding.json');
  const ready = await f.run({ action: 'advance', stopAfter: 'phone_ready', attempt: 'virtual53' });
  assert.equal(ready.phase, 'phone_ready'); assert.equal(ready.sms.purchaseAttempts, 1);
  assert.equal(f.calls.filter(path => path.includes('/buy/activation/poland/virtual53/')).length, 1);
  assert.equal(f.calls.filter(path => path.includes('/buy/activation/poland/any/')).length, 1);
  assert.deepEqual(await f.read('sms-ledger.json'), original); assert.deepEqual(await f.read('customer-onboarding.json'), oldCoordinator);
  const nextLedger = await f.read('sms-ledger.json', 'virtual53');
  assert.equal(nextLedger.entries.length, 1); assert.equal(nextLedger.entries[0].costMinor, 153800);
  assert.equal(original.entries[0].costMinor, 126900);
  assert.equal(original.entries[0].costMinor + nextLedger.entries[0].costMinor, 280700); // Fixture USD millionths; no refund assumed.
  assert.equal(nextLedger.entries[0].operator, 'virtual53');
  assert.equal(nextLedger.entries[0].capMechanism, 'fresh_quote_only_not_provider_enforced');
  assert.notEqual(nextLedger.entries[0].reservationId, original.entries[0].reservationId);
  const beforeStart = f.calls.length;
  const waiting = await f.run({ action: 'advance', stopAfter: 'awaiting_otp', attempt: 'virtual53' });
  assert.equal(waiting.phase, 'awaiting_otp'); assert.deepEqual(f.calls.slice(beforeStart), ['/v1/user/check/101']);
  assert.equal(f.merchantCalls.filter(call => call.operation === 'startFollowupRegistration').length, 1);
  assert.equal(f.merchantCalls.filter(call => call.operation === 'startRegistration').length, 0);
  await f.run({ action: 'advance', stopAfter: 'awaiting_otp', attempt: 'virtual53' });
  assert.equal(f.calls.filter(path => path.includes('/buy/activation/poland/virtual53/')).length, 1);
  assert.deepEqual(await f.read('sms-ledger.json'), original); assert.deepEqual(await f.read('customer-onboarding.json'), oldCoordinator);
  const oldVault = await f.read('contacts.json'), newVault = await f.read('contacts.json', 'virtual53');
  assert.equal(newVault.secrets.activationEmail, oldVault.secrets.activationEmail);
  assert.equal(newVault.secrets.activationEmail, EMAIL);
  const safe = JSON.stringify([waiting, nextLedger, await f.read('customer-onboarding.json', 'virtual53')])
    + await readFile(join(f.privateDir, 'onboarding-virtual53', 'merchant-attempts.jsonl'), 'utf8')
    + await readFile(join(f.privateDir, 'onboarding-virtual53', 'operator-attempts.jsonl'), 'utf8');
  for (const secret of [PHONE, FOLLOWUP_PHONE, EMAIL, TOKEN, OTP]) assert.equal(safe.includes(secret), false);
});

test('follow-up authorization cannot change customer identity or reuse nonterminal/unowned/registered initial state', async t => {
  const f = await followupFixture(t);
  const originalCoordinator = await f.read('customer-onboarding.json'), originalLedger = await f.read('sms-ledger.json');
  const providerCalls = f.calls.length, merchantCalls = f.merchantCalls.length;
  for (const mutate of [
    ({ config }) => { config.additionalTestAuthorized = false; },
    ({ config }) => { config.approvedNamedOperator.approvalId = 'unapproved'; },
    ({ config }) => { config.account.customerId = 'another-customer'; },
    ({ config }) => { config.account.merchantAccountId = 'another-account'; },
    ({ coordinator }) => { coordinator.entries[account.customerId].phase = 'registered'; },
    ({ coordinator }) => { coordinator.entries[account.customerId].phoneReady = false; },
    ({ coordinator }) => { coordinator.entries[account.customerId].smsReservationId = 'different-reservation'; },
    ({ ledger }) => { ledger.entries[0].status = 'RECEIVED'; },
    ({ ledger }) => { ledger.entries[0].status = 'CANCELED'; },
    ({ ledger }) => { ledger.entries[0].phase = 'buy_uncertain'; },
    ({ ledger }) => { ledger.entries = []; },
  ]) {
    const state = { config: structuredClone(f.followupConfig), coordinator: structuredClone(originalCoordinator), ledger: structuredClone(originalLedger) };
    mutate(state);
    await writeFile(join(f.privateDir, 'onboarding-config-virtual53.json'), JSON.stringify(state.config), { mode: 0o600 });
    await writeFile(join(f.privateDir, 'onboarding/customer-onboarding.json'), JSON.stringify(state.coordinator), { mode: 0o600 });
    await writeFile(join(f.privateDir, 'onboarding/sms-ledger.json'), JSON.stringify(state.ledger), { mode: 0o600 });
    await assert.rejects(f.run({ action: 'advance', stopAfter: 'phone_ready', attempt: 'virtual53' }), /additional_test_not_authorized_or_previous_not_terminal/);
    assert.equal(f.calls.length, providerCalls); assert.equal(f.merchantCalls.length, merchantCalls);
  }
});

test('one global provider lock blocks both initial and Virtual53 attempts across their separate directories', async t => {
  const f = await followupFixture(t), lock = join(f.privateDir, 'onboarding-provider.lock');
  await writeFile(lock, 'fixture-provider-owner', { mode: 0o600 });
  const providerCalls = f.calls.length, merchantCalls = f.merchantCalls.length;
  for (const attempt of ['initial', 'virtual53']) {
    await assert.rejects(f.run({ action: 'status', attempt }), /onboarding_provider_busy/);
    await assert.rejects(access(join(f.privateDir, attempt === 'initial' ? 'onboarding' : 'onboarding-virtual53', 'owner.lock')), { code: 'ENOENT' });
  }
  assert.equal(await readFile(lock, 'utf8'), 'fixture-provider-owner');
  assert.equal(f.calls.length, providerCalls); assert.equal(f.merchantCalls.length, merchantCalls);
});

test('follow-up rechecks original activation on the provider before sending the previous phone to the merchant', async t => {
  const f = await followupFixture(t);
  await f.run({ action: 'advance', stopAfter: 'phone_ready', attempt: 'virtual53' });
  f.hooks.check = order => Response.json({ ...order, status: 'RECEIVED' });
  await assert.rejects(f.run({ action: 'advance', stopAfter: 'awaiting_otp', attempt: 'virtual53' }), /onboarding_reconciliation_required/);
  assert.equal(f.merchantCalls.some(call => call.operation === 'startFollowupRegistration'), false);
  const current = await f.read('customer-onboarding.json', 'virtual53');
  assert.equal(current.entries[account.customerId].pending.operation, 'start_registration');
  assert.equal(f.calls.filter(path => path.includes('/buy/activation/poland/virtual53/')).length, 1);
});
