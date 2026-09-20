import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, renameSync, openSync, fsyncSync, closeSync } from 'node:fs';
import { join } from 'node:path';

const clone = value => structuredClone(value);
const plain = value => value && typeof value === 'object' && !Array.isArray(value);
const id = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)
  && !['__proto__', 'prototype', 'constructor'].includes(value);
const integer = value => Number.isSafeInteger(value) && value >= 0;
const fail = code => { throw Object.assign(new TypeError(code), { code }); };
const email = value => typeof value === 'string' && value.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
const phone = value => typeof value === 'string' && /^\+[1-9]\d{6,14}$/.test(value);
const otp = value => typeof value === 'string' && /^\d{3,10}$/.test(value);
const secretChecks = { activationEmail: email, activationPhone: phone, activationOtp: otp,
  notificationEmail: email, notificationPhone: phone };
const phases = new Set(['new', 'mailbox_ready', 'phone_ready', 'awaiting_otp', 'otp_ready', 'registered', 'existing_login', 'uncertain']);
const stoppingPhases = ['mailbox_ready', 'phone_ready', 'awaiting_otp', 'otp_ready', 'registered'];

function normalizedNotificationContact(kind, value) {
  if (!['email', 'phone'].includes(kind) || typeof value !== 'string') fail('invalid_private_contact');
  let normalized = value.trim().normalize('NFC');
  if (kind === 'email') {
    const separator = normalized.lastIndexOf('@');
    normalized = normalized.slice(0, separator + 1) + normalized.slice(separator + 1).toLowerCase();
  }
  if (!(kind === 'email' ? email : phone)(normalized)) fail('invalid_private_contact');
  return normalized;
}

/** Private verification helper: bind the exact normalized contact to its owner and purpose.
 * Email local-part case is retained; only domain case and surrounding whitespace normalize.
 */
export function notificationContactHash({ customerId, merchantAccountId, kind, value } = {}) {
  if (!id(customerId) || !id(merchantAccountId)) fail('invalid_contact_owner');
  const normalized = normalizedNotificationContact(kind, value);
  return createHash('sha256').update('delio-notification-contact:v1\0')
    .update(JSON.stringify({ customerId, merchantAccountId, kind, value: normalized })).digest('hex');
}
function boundContact(record, account, kind) {
  return Boolean(plain(record) && record.customerId === account.customerId && record.merchantAccountId === account.merchantAccountId
    && record.kind === kind && typeof record.contactHash === 'string' && /^[a-f0-9]{64}$/.test(record.contactHash)
    && id(record.evidenceId) && integer(record.observedAt));
}

/**
 * Local server coordinator, not a production account service or HTTP API.
 * accounts and all dependencies are operator-owned, never model/client input.
 * One host owner must hold the containing server's process lock; exclusiveOwner
 * attests that lock. Reopen this same private store after restart; never reset it.
 * vault.put(customerId, kind, secret) must durably retain the secret privately;
 * vault.withSecret(customerId, kind, callback) must never return/log it publicly.
 * Configure the existing SMS adapter's independent verified budget to <=$0.20,
 * maxPurchases:1. This coordinator additionally reserves its sole attempt before
 * buy, but cannot enforce an injected provider's behavior or prove its pricing.
 * Public FVI mailboxes require explicit hackathon mode/consent, one persistent
 * customer, and verified exact-origin capability. They never become real mode.
 * No provider URLs, credentials, email/SMS bodies or contacts enter this store.
 */
export function createCustomerOnboarding({ accounts, storeDir, exclusiveOwner, mailbox, sms, merchant, vault,
  mode = 'real', publicMailboxTestConsent = false, clock = Date.now,
  smsAuthorization = { currency: 'USD', totalMinor: 20, maxPurchases: 1 } } = {}) {
  if (!Array.isArray(accounts) || !accounts.length || typeof storeDir !== 'string' || !storeDir
      || exclusiveOwner !== true || !['real', 'fixture', 'hackathon'].includes(mode) || typeof clock !== 'function'
      || typeof vault?.put !== 'function' || typeof vault?.withSecret !== 'function'
      || smsAuthorization?.currency !== 'USD' || !integer(smsAuthorization.totalMinor)
      || smsAuthorization.totalMinor < 1 || smsAuthorization.totalMinor > 20 || smsAuthorization.maxPurchases !== 1) fail('invalid_onboarding_config');
  if (mode === 'hackathon' && (publicMailboxTestConsent !== true || accounts.length !== 1)) fail('hackathon_single_account_consent_required');
  smsAuthorization = { currency: smsAuthorization.currency, totalMinor: smsAuthorization.totalMinor,
    maxPurchases: smsAuthorization.maxPurchases };
  const registry = new Map(), merchantAccounts = new Set();
  for (const account of accounts) {
    if (!plain(account) || !id(account.customerId) || !id(account.merchantAccountId) || typeof account.newCustomer !== 'boolean'
        || registry.has(account.customerId) || merchantAccounts.has(account.merchantAccountId)) fail('one_account_per_customer_required');
    registry.set(account.customerId, clone(account)); merchantAccounts.add(account.merchantAccountId);
  }
  const file = join(storeDir, 'customer-onboarding.json');
  mkdirSync(storeDir, { recursive: true, mode: 0o700 });
  let state;
  try { state = JSON.parse(readFileSync(file, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') fail('onboarding_store_invalid'); }
  state ??= { schema: 1, mode, publicMailboxTestConsent: mode === 'hackathon',
    smsAuthorization: clone(smsAuthorization), smsPurchaseAttempts: 0, entries: {} };
  if (state.schema !== 1 || state.mode !== mode || JSON.stringify(state.smsAuthorization) !== JSON.stringify(smsAuthorization)
      || (state.publicMailboxTestConsent ?? false) !== (mode === 'hackathon')
      || !plain(state.entries) || !integer(state.smsPurchaseAttempts) || state.smsPurchaseAttempts > 1) fail('onboarding_store_invalid');
  if (mode === 'hackathon' && Object.keys(state.entries).some(customerId => customerId !== accounts[0].customerId)) fail('hackathon_single_account_required');
  for (const [customerId, entry] of Object.entries(state.entries)) {
    if (!id(customerId) || !plain(entry) || !id(entry.merchantAccountId) || typeof entry.newCustomer !== 'boolean'
        || !phases.has(entry.phase) || !plain(entry.contacts)
        || (entry.reconciliations !== undefined && (!Array.isArray(entry.reconciliations) || entry.reconciliations.length > 64))) fail('onboarding_store_invalid');
  }
  for (const account of registry.values()) {
    const old = state.entries[account.customerId];
    if (old && (old.merchantAccountId !== account.merchantAccountId || old.newCustomer !== account.newCustomer)) fail('onboarding_account_binding_changed');
    if (Object.entries(state.entries).some(([customerId, entry]) => customerId !== account.customerId && entry.merchantAccountId === account.merchantAccountId)) fail('onboarding_account_binding_changed');
    state.entries[account.customerId] ??= { merchantAccountId: account.merchantAccountId, newCustomer: account.newCustomer,
      phase: account.newCustomer ? 'new' : 'existing_login', pending: null, mailboxReady: false,
      phoneReady: false, otpReady: false, smsReservationId: null, contacts: {}, reconciliations: [] };
  }
  let poisoned = false, tail = Promise.resolve();
  const persist = () => {
    if (poisoned) fail('onboarding_store_failed');
    try {
      writeFileSync(`${file}.next`, JSON.stringify(state), { mode: 0o600, flush: true });
      renameSync(`${file}.next`, file);
      const directory = openSync(storeDir, 'r');
      try { fsyncSync(directory); } finally { closeSync(directory); }
    } catch { poisoned = true; fail('onboarding_store_failed'); }
  };
  const serial = fn => {
    const next = tail.then(() => { if (poisoned) fail('onboarding_store_failed'); return fn(); });
    tail = next.catch(() => {}); return next;
  };
  function owned(actor) {
    const account = plain(actor) && registry.get(actor.customerId);
    if (!account || actor.merchantAccountId !== account.merchantAccountId) fail('onboarding_account_not_owned');
    return { account, entry: state.entries[account.customerId] };
  }
  function evidence(value) {
    if (!plain(value) || !id(value.evidenceId) || !integer(value.observedAt) || value.observedAt > clock()) fail('onboarding_evidence_required');
  }
  const summary = (entry, account) => ({ mode, productionReady: false,
    publicMailboxTestConsent: mode === 'hackathon',
    phase: poisoned || entry.pending ? 'reconciliation_required' : entry.phase,
    nextAction: poisoned || entry.pending ? 'operator_reconcile' : entry.phase === 'existing_login' ? 'sign_in_existing_account'
      : entry.phase === 'registered' ? 'none' : 'continue_onboarding',
    pending: entry.pending ? { operationId: entry.pending.operationId, operation: entry.pending.operation } : null,
    activation: { mailboxReady: entry.mailboxReady, phoneReady: entry.phoneReady, otpReady: entry.otpReady,
      temporaryPhoneIsRecoveryContact: false },
    notificationContacts: { emailVerified: boundContact(entry.contacts.email, account, 'email'), phoneVerified: boundContact(entry.contacts.phone, account, 'phone') },
    sms: { ...clone(smsAuthorization), purchaseAttempts: state.smsPurchaseAttempts, reservationId: entry.smsReservationId },
    capabilities: { sendsNotifications: false, forwardsAuthenticationMail: false, automaticUncertainRetry: false,
      realAccountRequiresPrivateMailbox: true, hackathonPublicMailboxOnlyForSingleTestAccount: mode === 'hackathon' } });
  async function useSecret(customerId, kind, consume) {
    let called = false, result;
    try {
      await vault.withSecret(customerId, kind, async value => {
        if (called || !secretChecks[kind](value)) fail('private_contact_unavailable');
        called = true; result = await consume(value);
      });
    } catch { fail('private_contact_unavailable'); }
    if (!called) fail('private_contact_unavailable');
    return result;
  }
  async function saveSecret(customerId, kind, value) {
    if (!secretChecks[kind](value)) fail('invalid_private_contact');
    await vault.put(customerId, kind, value);
  }
  async function mutate(entry, operation, invoke, commit) {
    if (entry.pending) fail('onboarding_reconciliation_required');
    entry.pending = { operation, operationId: randomUUID(), startedAt: clock() };
    persist(); // Durable intent before every provider/merchant mutation.
    try { const result = await invoke(); commit(result); entry.pending = null; persist(); return result; }
    catch { entry.phase = 'uncertain'; persist(); fail('onboarding_reconciliation_required'); }
  }
  async function privateMailbox() {
    let capabilities;
    try { capabilities = await mailbox?.capabilities(); } catch { fail('mailbox_capabilities_unavailable'); }
    const privateReady = capabilities?.verified === true && capabilities.privateMailbox === true && capabilities.testOnly !== true;
    if (mode === 'real' && !privateReady) fail('private_mailbox_required');
    if (mode === 'hackathon' && !privateReady && !(capabilities?.verified === true
        && capabilities.privateMailbox === false && capabilities.publicMailbox === true && capabilities.testOnly === true
        && capabilities.origin === 'https://fviainboxes.com')) fail('hackathon_mailbox_scope_mismatch');
    if (typeof mailbox?.create !== 'function') fail('mailbox_unavailable');
  }
  async function registrationPage(account) {
    let page;
    try { page = await merchant?.inspectRegistration({ accountId: account.merchantAccountId }); }
    catch { fail('merchant_registration_page_unverified'); }
    if (page?.verified !== true || page.merchantAccountId !== account.merchantAccountId) fail('merchant_registration_page_unverified');
    evidence(page);
    if (clock() - page.observedAt > 30_000) fail('merchant_registration_page_unverified');
    if (page.existingAccount === true) fail('existing_account_login_required');
  }
  persist();
  return Object.freeze({
    status(actor) { const {entry, account} = owned(actor); return summary(entry, account); },
    advance(actor, { stopAfter = 'registered' } = {}) {
      return serial(async () => {
        const stopIndex = stoppingPhases.indexOf(stopAfter);
        if (stopIndex < 0) fail('invalid_onboarding_stop_after');
        const { account, entry } = owned(actor);
        if (entry.pending) fail('onboarding_reconciliation_required');
        const reachedStop = () => stoppingPhases.indexOf(entry.phase) >= stopIndex;
        // A resumed earlier stop is a read of existing progress, never a replay.
        if (!account.newCustomer || reachedStop()) return summary(entry, account);
        await privateMailbox();
        if (entry.phase === 'new') {
          await registrationPage(account);
          await mutate(entry, 'create_mailbox', async () => {
            let supplied = false;
            await mailbox.create({ customerId: account.customerId, onEmail: async value => {
              if (supplied) fail('mailbox_already_supplied'); supplied = true;
              await saveSecret(account.customerId, 'activationEmail', value);
            } });
            if (!supplied) fail('private_contact_unavailable');
          }, () => { entry.mailboxReady = true; entry.phase = 'mailbox_ready'; });
        }
        if (reachedStop()) return summary(entry, account);
        if (entry.phase === 'mailbox_ready') {
          // Recheck the merchant gate after mailbox creation and BEFORE paid SMS.
          await registrationPage(account);
          await useSecret(account.customerId, 'activationEmail', () => {});
          if (state.smsPurchaseAttempts >= 1) fail('onboarding_sms_limit');
          let status;
          try { status = await sms.publicStatus(); } catch { fail('sms_unavailable'); }
          if (status?.paidEnabled !== true || status.needsReconciliation === true || !Array.isArray(status.entries) || status.entries.length) fail('sms_not_ready');
          if (status.purchaseConfigurationValid !== true || !plain(status.usdAuthorization)
              || status.usdAuthorization.currency !== 'USD' || !integer(status.usdAuthorization.totalMinor)
              || status.usdAuthorization.totalMinor < 1 || status.usdAuthorization.totalMinor > smsAuthorization.totalMinor
              || status.usdAuthorization.maxPurchases !== 1) fail('sms_budget_mismatch');
          state.smsPurchaseAttempts++; // This reservation is never reset on failure/restart.
          await mutate(entry, 'buy_sms', async () => {
            let supplied = false;
            const result = await sms.buy({ operator: 'any', onPhone: async value => {
              if (supplied) fail('phone_already_supplied'); supplied = true;
              await saveSecret(account.customerId, 'activationPhone', value);
            } });
            if (!supplied || !id(result?.reservationId)) fail('sms_result_unverified');
            return result;
          }, result => { entry.smsReservationId = result.reservationId; entry.phoneReady = true; entry.phase = 'phone_ready'; });
        }
        if (reachedStop()) return summary(entry, account);
        if (entry.phase === 'phone_ready') {
          // A retained activation may outlive the worker page/session. Re-observe
          // the phone form before recording intent or submitting registration.
          await registrationPage(account);
          await mutate(entry, 'start_registration', () => useSecret(account.customerId, 'activationEmail', emailValue =>
            useSecret(account.customerId, 'activationPhone', phoneValue => merchant.startRegistration({
              accountId: account.merchantAccountId, email: emailValue, phone: phoneValue,
            }))), result => {
            if (result?.otpRequired !== true) fail('registration_result_unverified');
            entry.phase = 'awaiting_otp';
          });
        }
        if (reachedStop()) return summary(entry, account);
        if (entry.phase === 'awaiting_otp') {
          await mutate(entry, 'poll_sms', async () => {
            let supplied = false;
            const result = await sms.poll({ reservationId: entry.smsReservationId, onOtp: async value => {
              if (supplied) fail('otp_already_supplied'); supplied = true;
              await saveSecret(account.customerId, 'activationOtp', value);
            } });
            if (result?.state === 'otp_delivered_to_private_consumer' && supplied) return true;
            if (!supplied && ['poll_timeout', 'poll_limit'].includes(result?.state)) return false;
            fail('sms_result_unverified');
          }, ready => { entry.otpReady = ready; entry.phase = ready ? 'otp_ready' : 'awaiting_otp'; });
          if (!entry.otpReady) return summary(entry, account);
        }
        if (reachedStop()) return summary(entry, account);
        if (entry.phase === 'otp_ready') {
          await mutate(entry, 'complete_registration', () => useSecret(account.customerId, 'activationOtp', code =>
            merchant.completeRegistration({ accountId: account.merchantAccountId, otp: code })), result => {
            if (result?.registered !== true || result.merchantAccountId !== account.merchantAccountId) fail('registration_result_unverified');
            evidence(result); entry.phase = 'registered'; entry.registrationEvidence = {
              customerId: account.customerId, merchantAccountId: account.merchantAccountId,
              operationId: entry.pending.operationId, source: 'merchant_observation',
              evidenceId: result.evidenceId, observedAt: result.observedAt };
          });
        }
        return summary(entry, account);
      });
    },
    // Operator-only adoption of an evidenced outcome. An unused SMS reservation
    // may be released only when the trusted durable adapter proves no paid intent
    // exists. This never resets a bought/unknown activation or creates an account.
    // The HTTP host must never expose this as an untrusted route.
    operatorReconcile(actor, resolution) {
      return serial(async () => {
        const { account, entry } = owned(actor); evidence(resolution);
        if (!entry.pending || resolution.operationId !== entry.pending.operationId) fail('onboarding_reconciliation_mismatch');
        entry.reconciliations ??= [];
        if (entry.reconciliations.length >= 64) fail('onboarding_reconciliation_limit');
        if (resolution.outcome === 'sms_not_dispatched') {
          if (entry.pending.operation !== 'buy_sms' || state.smsPurchaseAttempts !== 1
              || entry.smsReservationId !== null || entry.phoneReady !== false || entry.otpReady !== false
              || entry.mailboxReady !== true) fail('onboarding_reconciliation_mismatch');
          let status;
          try { status = await sms.publicStatus(); } catch { fail('sms_not_dispatched_not_proven'); }
          if (status?.paidEnabled !== true || status.purchaseConfigurationValid !== true || status.purchaseBlocker !== null
              || !plain(status.usdAuthorization) || status.usdAuthorization.currency !== 'USD'
              || !integer(status.usdAuthorization.totalMinor) || status.usdAuthorization.totalMinor < 1
              || status.usdAuthorization.totalMinor > smsAuthorization.totalMinor || status.usdAuthorization.maxPurchases !== 1
              || !Array.isArray(status.entries) || status.entries.length !== 0 || status.needsReconciliation !== false
              || status.costComplete !== true || status.knownCostMinor !== 0 || status.reservedMinor !== 0) fail('sms_not_dispatched_not_proven');
          entry.reconciliations.push({ customerId: account.customerId, merchantAccountId: account.merchantAccountId,
            operationId: entry.pending.operationId, operation: 'buy_sms', outcome: 'sms_not_dispatched',
            evidenceId: resolution.evidenceId, observedAt: resolution.observedAt, resolvedAt: clock(),
            releasedUnusedReservation: true, smsLedger: { entries: 0, knownCostMinor: 0, reservedMinor: 0, costComplete: true } });
          state.smsPurchaseAttempts = 0;
          entry.phase = 'mailbox_ready'; entry.pending = null; persist(); return summary(entry, account);
        }
        const outcomes = { create_mailbox: ['mailbox_ready', 'activationEmail'], buy_sms: ['phone_ready', 'activationPhone'],
          start_registration: ['awaiting_otp'], poll_sms: ['otp_ready', 'activationOtp'], complete_registration: ['registered'] };
        const outcome = outcomes[entry.pending.operation];
        if (!outcome || resolution.outcome !== outcome[0]) fail('onboarding_reconciliation_mismatch');
        if (outcome[1]) await useSecret(account.customerId, outcome[1], () => {});
        if (entry.pending.operation === 'buy_sms') {
          if (!id(resolution.reservationId)) fail('onboarding_reconciliation_mismatch');
          entry.smsReservationId = resolution.reservationId; entry.phoneReady = true;
        }
        if (outcome[0] === 'mailbox_ready') entry.mailboxReady = true;
        if (outcome[0] === 'otp_ready') entry.otpReady = true;
        const record = { customerId: account.customerId, merchantAccountId: account.merchantAccountId,
          operationId: entry.pending.operationId, operation: entry.pending.operation, outcome: outcome[0],
          evidenceId: resolution.evidenceId, observedAt: resolution.observedAt, resolvedAt: clock() };
        entry.reconciliations.push(record);
        if (outcome[0] === 'registered') entry.registrationEvidence = { ...record, source: 'operator_reconciliation' };
        entry.phase = outcome[0]; entry.pending = null; persist(); return summary(entry, account);
      });
    },
    // Verification must come from a separate, authenticated real-contact flow.
    // Provider activation numbers and mailbox delivery do not establish this.
    setNotificationContact(actor, { kind, value, verification } = {}) {
      return serial(async () => {
        const { account, entry } = owned(actor);
        if (!['email', 'phone'].includes(kind) || verification?.verified !== true
            || verification?.purpose !== 'notifications' || verification?.source !== 'verified_real_contact') fail('notification_contact_verification_required');
        evidence(verification);
        const normalized = normalizedNotificationContact(kind, value);
        const contactHash = notificationContactHash({ ...account, kind, value: normalized });
        if (verification.customerId !== account.customerId || verification.merchantAccountId !== account.merchantAccountId
            || verification.kind !== kind || verification.contactHash !== contactHash) fail('notification_contact_binding_mismatch');
        try { await saveSecret(account.customerId, kind === 'email' ? 'notificationEmail' : 'notificationPhone', normalized); }
        catch { fail('private_contact_storage_failed'); }
        entry.contacts[kind] = { customerId: account.customerId, merchantAccountId: account.merchantAccountId, kind, contactHash,
          evidenceId: verification.evidenceId, observedAt: verification.observedAt };
        persist(); return summary(entry, account);
      });
    },
    prepareOrderNotification(actor, event, onPayload) {
      return serial(async () => {
        const { account, entry } = owned(actor); evidence(event);
        const allowed = ['type', 'orderId', 'customerId', 'merchantAccountId', 'verified', 'evidenceId', 'observedAt'];
        if (!plain(event) || Object.keys(event).some(key => !allowed.includes(key)) || event.verified !== true
            || event.customerId !== account.customerId || event.merchantAccountId !== account.merchantAccountId
            || !id(event.orderId) || !['order_confirmed', 'order_dispatched', 'order_delivered', 'order_cancelled'].includes(event.type)) fail('verified_order_event_required');
        const channels = Object.keys(entry.contacts).filter(kind => ['email', 'phone'].includes(kind) && boundContact(entry.contacts[kind], account, kind));
        if (!channels.length) fail('verified_notification_contact_required');
        if (typeof onPayload !== 'function') fail('private_notification_consumer_required');
        const payload = { kind: 'order_status', event: clone(event), to: {} };
        try {
          for (const kind of channels) await useSecret(account.customerId, kind === 'email' ? 'notificationEmail' : 'notificationPhone', value => {
            if (notificationContactHash({ ...account, kind, value }) !== entry.contacts[kind].contactHash) fail('notification_contact_binding_mismatch');
            payload.to[kind] = value;
          });
          await onPayload(payload); // Preparation only: this module has no send API.
        } catch { fail('private_notification_consumer_failed'); }
        return { prepared: true, channels, orderId: event.orderId, eventType: event.type, evidenceId: event.evidenceId };
      });
    },
  });
}
