import { randomUUID, createHash } from 'node:crypto';
import { mkdir, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { LocalChain } from './chain-client.mjs';
import { canonicalTermsHash, canonicalTermsBytes, hashCommitment } from './encoding.mjs';
import { MerchantFixture, RECIPIENT, ITEM, MERCHANT, verifyOrder, sameQuote } from './fixture.mjs';
import { openFixtureBrowser } from './browser.mjs';
import { appendRecord, quoteHash, hashArtifact, hashObservation, verifyEvidence } from '../evidence.mjs';

export const SCENARIOS = ['happy', 'price_change', 'uncertain'];
const sha = text => createHash('sha256').update(text).digest('hex');
const eq = sameQuote;

export class GiftingRun {
  constructor({ origin, directory, scenario = 'happy', chainFactory = () => new LocalChain(), browserFactory = openFixtureBrowser }) {
    if (!SCENARIOS.includes(scenario)) throw new Error('invalid_scenario');
    this.origin = origin; this.directory = directory; this.chainFactory = chainFactory; this.browserFactory = browserFactory;
    this.id = randomUUID(); this.fixture = new MerchantFixture(this.id, scenario); this.ledger = []; this.artifacts = {}; this.closed = false;
    this.state = { runId: this.id, scenario, phase: 'preparing', environment: { chain: 'Local Solana execution — LiteSVM', merchant: 'Simulated merchant fulfillment', signer: 'Ephemeral demo sender and oracle keys; no wallet connection',
      browser: 'Isolated Playwright fixture browser; existing production adapters unchanged', decisionMode: 'Fixed evidence-backed fixture recommendation; no live model call', settlement: 'Fictional token: 1 PLN = 1 demo token, zero protocol fee; no real FX or funds' },
      recipient: RECIPIENT, recommendation: { name: ITEM.title, reason: 'A coffee tasting set matches Marta’s stated interest in pour-over coffee and discovering roasters. It contains no alcohol.',
        evidence: [{ label: 'Recipient preference', text: 'Enjoys pour-over coffee and independent roasters.', source: 'Explicitly fictional demo recipient brief' },
          { label: 'Product fit', text: ITEM.variant, source: 'Simulated merchant catalogue — not live research' }] },
      authorization: { confirmed: false }, chain: { transactions: [], accountState: {} }, execution: { status: 'not_started', dispatchCount: 0 }, verification: { ok: false, checks: [] }, events: [], evidence: { artifacts: [] } };
  }
  event(type, message) { this.state.events.push({ at: new Date().toISOString(), type, message }); }
  async persist() {
    await mkdir(join(this.directory, this.id), { recursive: true, mode: 0o700 });
    const path = join(this.directory, this.id, 'receipt.json');
    await writeFile(path + '.tmp', JSON.stringify(this.public(), null, 2) + '\n', { mode: 0o600, flush: true });
    await rename(path + '.tmp', path);
  }
  public() {
    return structuredClone({ ...this.state, evidence: { ...this.state.evidence, ledger: this.ledger,
      validation: verifyEvidence({ chain: this.ledger, artifacts: this.artifacts, requireBoundaryEvidence: true }),
      persistence: 'Private local artifacts; no external trusted head or public explorer', canonicalInputs: this.canonical?.inputs } });
  }
  async chainCall(op, args = {}) {
    const result = await this.chain.request({ op, ...args });
    this.state.chain.transactions.push(...(result.transactions || []).map(tx => ({ ...tx, label: tx.label || op, success: tx.accepted })));
    this.state.chain.accountState = result.state || result.accountState || {};
    this.state.chain.publicKeys = result.publicKeys;
    this.state.chain.binarySha256 = result.binarySha256;
    this.state.chain.backend = result.backend;
    if (result.canonical) {
      const bytes = canonicalTermsBytes(result.canonical.inputs);
      if (canonicalTermsHash(result.canonical.inputs) !== result.canonical.termsHash || bytes.toString('hex') !== result.canonical.bytesHex) throw new Error('rust_js_encoding_mismatch');
    }
    return result;
  }
  append(record) { this.ledger = appendRecord(this.ledger, { at: Date.now(), ...record }); return this.ledger.at(-1); }
  async captureBoundary(stage, envelope) {
    const capture = await this.browser.capture(stage, this.id), screenshotSha256 = hashArtifact(capture.bytes);
    const record = envelope.record;
    const observation = { kind: stage, observedAt: Date.now(), origin: new URL(capture.url).origin, pathname: new URL(capture.url).pathname,
      title: capture.title, mandateId: this.mandateId, quoteId: this.id, eventHash: envelope.hash, quoteHash: this.evidenceQuoteHash,
      merchantId: MERCHANT.id, currency: 'PLN', totalMinor: this.state.quote.totalMinor,
      ...(record.approvalId ? { approvalId: record.approvalId } : {}), ...(record.confirmationId ? { confirmationId: record.confirmationId, orderId: record.orderId } : {}) };
    const observationSha256 = hashObservation(observation), prefix = `${stage}-${screenshotSha256.slice(0, 12)}`;
    await writeFile(join(this.directory, this.id, `${prefix}.png`), capture.bytes, { mode: 0o600, flush: true });
    await writeFile(join(this.directory, this.id, `${prefix}.json`), JSON.stringify(observation, null, 2) + '\n', { mode: 0o600, flush: true });
    this.artifacts[screenshotSha256] = { kind: 'screenshot', bytes: capture.bytes };
    this.artifacts[observationSha256] = { kind: 'observation', observation };
    this.state.evidence.artifacts.push({ stage, screenshotSha256, observationSha256, url: `/artifacts/${this.id}/${prefix}.png`, observationUrl: `/artifacts/${this.id}/${prefix}.json` });
    this.append({ type: 'boundary_evidence', mandateId: this.mandateId, quoteId: this.id, stage, eventHash: envelope.hash,
      ...(record.approvalId ? { approvalId: record.approvalId } : {}), ...(record.confirmationId ? { confirmationId: record.confirmationId } : {}), evidence: { screenshotSha256, observationSha256 } });
  }
  async prepare() {
    this.started = performance.now(); await this.persist();
    this.browser = await this.browserFactory(this.origin);
    this.expected = await this.browser.checkout(this.id);
    if (!eq(this.expected, this.fixture.quote())) throw new Error('browser_quote_mismatch');
    const expiresAt = Math.floor(Date.now() / 1000) + 900;
    this.state.quote = { ...this.expected, expiresAt, termsHash: null };
    this.state.observedQuote = { ...this.expected };
    this.commitments = { merchantHash: hashCommitment({ kind: 'merchant', ...MERCHANT }),
      specHash: hashCommitment({ kind: 'item', id: ITEM.id, title: ITEM.title, variant: ITEM.variant, quantity: 1 }),
      recipientHash: hashCommitment({ kind: 'recipient', id: RECIPIENT.commitmentId, name: RECIPIENT.name }),
      quoteHash: hashCommitment({ kind: 'quote', ...this.expected, expiresAt }) };
    this.chain = this.chainFactory();
    const prepared = await this.chainCall('prepare', { quote: { ...this.commitments, currency: 'PLN', currencyExponent: 2, totalMinor: this.expected.totalMinor, expiresAt } });
    if (!prepared.accepted || !prepared.canonical) throw new Error('local_quote_transaction_failed');
    const bound = prepared.canonical.inputs;
    if (bound.campaign.quoteHash !== this.commitments.quoteHash || bound.campaign.specHash !== this.commitments.specHash
      || bound.campaign.merchantHash !== this.commitments.merchantHash || bound.mandate.recipientHash !== this.commitments.recipientHash
      || bound.campaign.currency !== 'PLN' || bound.campaign.chargeCurrency !== 'PLN' || bound.campaign.currencyExponent !== 2
      || bound.campaign.chargeCurrencyExponent !== 2 || bound.campaign.landedTotalMinor !== String(this.expected.totalMinor)
      || bound.campaign.quotedChargeAmountMinor !== String(this.expected.totalMinor) || bound.mandate.maxChargeAmountMinor !== String(this.expected.totalMinor)
      || bound.campaign.quoteExpiresAt !== String(expiresAt) || bound.mandate.expiresAt !== String(expiresAt)) throw new Error('browser_to_chain_quote_mismatch');
    this.canonical = prepared.canonical; this.state.quote.termsHash = canonicalTermsHash(this.canonical.inputs);
    this.mandateId = prepared.publicKeys.mandate;
    this.state.authorization = { confirmed: false, termsHash: this.state.quote.termsHash, campaignAddress: prepared.publicKeys.campaign, mandateAddress: this.mandateId, status: 'Not authorized' };
    this.append({ type: 'mandate', mandateId: this.mandateId, currency: 'PLN', maxTotalMinor: 12900, expiresAt: expiresAt * 1000, allowedMerchantIds: [MERCHANT.id] });
    const quote = { type: 'quote', at: Date.now(), mandateId: this.mandateId, quoteId: this.id, merchantId: MERCHANT.id, currency: 'PLN', totalMinor: 12900,
      items: [{ itemId: ITEM.id, title: ITEM.title, quantity: 1, unitPriceMinor: 12900 }], expiresAt: expiresAt * 1000 };
    this.evidenceQuoteHash = quoteHash(quote); this.ledger = appendRecord(this.ledger, quote);
    await this.captureBoundary('quote', this.ledger.at(-1));
    this.state.phase = 'quoted'; this.state.evidence.encodingMatched = true; this.state.evidence.canonicalByteLength = canonicalTermsBytes(this.canonical.inputs).length;
    this.event('quote', 'Browser quote recorded; JavaScript and Rust agree on the exact authorization bytes. No sender authorization yet.');
    await this.persist(); return { ok: true };
  }
  async reject(code, message, phase = 'blocked') {
    this.state.phase = phase; this.state.error = code; this.event('rejected', message);
    if (this.mandateId) this.append({ type: 'rejection', mandateId: this.mandateId, quoteId: this.id, rejectionId: randomUUID(), reason: code });
    await this.persist(); return { ok: false, code };
  }
  async approve(termsHash) {
    if (this.state.phase !== 'quoted' || termsHash !== this.state.quote.termsHash) return this.reject('approval_terms_mismatch', 'Approval does not match the current reviewed quote.');
    if (Date.now() >= this.state.quote.expiresAt * 1000) return this.reject('approval_expired', 'Quote expired; prepare a fresh gift.');
    this.event('authorization_pending', 'Requesting sender-signed local mandate and executor quote approval.'); await this.persist();
    const authorized = await this.chainCall('authorize', { termsHash });
    if (!authorized.accepted || authorized.state?.campaign?.status !== 'Approved' || authorized.state?.mandate?.status !== 'Active'
      || authorized.state?.mandate?.approvedTermsHash !== termsHash) return this.reject('chain_authorization_failed', 'Local Solana did not confirm a usable mandate.');
    this.state.authorization.confirmed = true; this.state.authorization.status = 'Active'; this.state.phase = 'approved';
    const approval = this.append({ type: 'approval', mandateId: this.mandateId, quoteId: this.id, quoteHash: this.evidenceQuoteHash, approvalId: this.id, decision: 'approved' });
    await this.captureBoundary('approval', approval);
    this.event('authorized', 'Local Solana transactions confirmed. The one-use mandate permits the exact PLN 129 quote.');
    if (this.state.scenario === 'price_change') { this.fixture.totalMinor = 14900; this.state.observedQuote = await this.browser.checkout(this.id); this.event('merchant_change', 'The simulated merchant changed checkout from PLN 129 to PLN 149 after approval.'); }
    await this.persist(); return { ok: true };
  }
  async execute() {
    if (this.state.execution.attemptId) {
      if (this.state.authorization.status !== 'Consumed') return this.reject('chain_outcome_requires_reconciliation', 'An attempt was recorded but its chain outcome needs reconciliation. Do not submit another attempt.', 'needs_reconciliation');
      const replay = await this.chainCall('attempt', { termsHash: this.state.quote.termsHash, attemptHash: sha('replay:' + randomUUID()) });
      if (replay.accepted) throw new Error('replay_unexpectedly_accepted');
      return this.reject('replay_rejected_by_program', 'A fresh replay transaction was rejected by the program. No second merchant request was sent.', this.state.phase);
    }
    const fresh = await this.chainCall('state');
    if (!fresh.accepted || fresh.state?.campaign?.status !== 'Approved' || fresh.state?.mandate?.status !== 'Active'
      || !this.state.authorization.confirmed || fresh.canonical?.termsHash !== this.state.quote.termsHash
      || fresh.state?.mandate?.approvedTermsHash !== this.state.quote.termsHash) return this.reject('confirmed_mandate_required', 'Execution requires confirmed local Solana account state; an approval flag alone is insufficient.');
    const evidence = verifyEvidence({ chain: this.ledger, artifacts: this.artifacts, requireBoundaryEvidence: true });
    if (!evidence.valid || !evidence.boundaries.some(boundary => boundary.stage === 'approval' && boundary.complete)) return this.reject('approval_evidence_incomplete', 'Required quote and approval evidence is incomplete; execution stopped.');
    this.state.observedQuote = await this.browser.checkout(this.id);
    if (!eq(this.state.observedQuote, this.expected)) return this.reject('checkout_changed', 'Checkout no longer matches the approved purchase. New approval is required; no merchant request was sent.');
    if (Date.now() >= this.state.quote.expiresAt * 1000) return this.reject('approval_expired', 'Authorization expired before execution.');
    const attemptId = randomUUID(), attemptHash = sha('gifting-attempt-v1:' + attemptId);
    this.state.execution = { status: 'chain_attempt_pending', attemptId, attemptHash, dispatchCount: 0 };
    this.state.authorization.status = 'Consumption pending';
    this.event('attempt_pending', 'Recording a one-use attempt on local Solana before browser execution.'); await this.persist();
    let attempt;
    try { attempt = await this.chainCall('attempt', { termsHash: this.state.quote.termsHash, attemptHash }); }
    catch {
      this.state.execution.status = 'chain_outcome_uncertain'; this.state.authorization.status = 'Unknown — reconcile';
      return this.reject('chain_outcome_requires_reconciliation', 'The attempt response was lost. Retained attempt identity must be reconciled; no merchant action was dispatched.', 'needs_reconciliation');
    }
    if (!attempt.accepted || attempt.state?.mandate?.status !== 'Consumed' || attempt.state?.campaign?.status !== 'PaymentAttempted') {
      this.state.execution.status = 'authorization_rejected'; this.state.authorization.status = attempt.state?.mandate?.status || 'Unknown — reconcile';
      return this.reject('chain_attempt_rejected', 'Solana did not confirm mandate consumption; execution stopped.', 'needs_reconciliation');
    }
    this.state.authorization.status = 'Consumed'; this.state.execution = { status: 'dispatch_pending', attemptId, attemptHash, dispatchCount: 0 };
    this.append({ type: 'execution', mandateId: this.mandateId, quoteId: this.id, quoteHash: this.evidenceQuoteHash, approvalId: this.id, executionId: attemptId, mode: 'simulated' });
    await this.persist();
    this.fixture.permitAttempt(attemptId, this.expected);
    let result;
    try { result = await this.browser.dispatch(this.id, attemptId); }
    catch { result = { uncertain: true }; }
    this.state.execution.dispatchCount = this.fixture.dispatchCount;
    if (result.uncertain) {
      this.state.phase = 'needs_reconciliation'; this.state.execution.status = 'response_uncertain';
      this.event('uncertain', 'The merchant response was lost. Authorization remains consumed; inspect the existing order before any further action.');
      await this.persist(); return { ok: false, code: 'needs_reconciliation' };
    }
    return this.complete(result.observed);
  }
  async complete(observed) {
    const order = this.fixture.byAttempt(this.state.execution.attemptId);
    this.state.verification = verifyOrder({ expected: this.expected, attemptId: this.state.execution.attemptId, observed, ledgerOrder: order });
    if (!this.state.verification.ok) return this.reject('merchant_verification_failed', 'Observed confirmation does not agree with the approved purchase and independent fixture ledger.', 'needs_reconciliation');
    this.event('merchant_verified', 'Independent DOM and fixture-ledger checks match the exact approved gift, recipient, amount and attempt.'); await this.persist();
    const orderHash = sha('gifting-order-v1:' + order.orderId), receiptHash = sha('gifting-receipt-v1:' + JSON.stringify(order));
    let confirmation = await this.chainCall('state');
    if (confirmation.state?.campaign?.status === 'Purchased') {
      if (confirmation.state.campaign.orderIdHash !== orderHash || confirmation.state.campaign.purchaseHash !== receiptHash
        || confirmation.state.campaign.paymentAttemptHash !== this.state.execution.attemptHash) return this.reject('chain_receipt_mismatch', 'Existing chain receipt does not match this verified order.', 'needs_reconciliation');
      this.event('confirmation_recovered', 'The matching purchase was already recorded on Solana; finishing evidence without another transaction.');
    } else confirmation = await this.chainCall('confirm', { orderHash, receiptHash });
    if (!confirmation.accepted || confirmation.state?.campaign?.status !== 'Purchased') return this.reject('chain_confirmation_pending', 'Merchant result exists; local Solana confirmation needs reconciliation. No new purchase is permitted.', 'needs_reconciliation');
    const envelope = this.ledger.find(envelope => envelope.record.type === 'confirmation' && envelope.record.confirmationId === order.orderId) || this.append({ type: 'confirmation', mandateId: this.mandateId, quoteId: this.id, quoteHash: this.evidenceQuoteHash, approvalId: this.id,
      executionId: this.state.execution.attemptId, confirmationId: order.orderId, merchantId: MERCHANT.id, orderId: order.orderId, currency: 'PLN', totalMinor: 12900, mode: 'simulated' });
    if (!this.ledger.some(item => item.record.type === 'boundary_evidence' && item.record.eventHash === envelope.hash)) await this.captureBoundary('confirmation', envelope);
    if (!verifyEvidence({ chain: this.ledger, artifacts: this.artifacts, requireBoundaryEvidence: true }).valid) throw new Error('completion_evidence_incomplete');
    this.state.execution = { ...this.state.execution, status: 'verified_simulated_fulfillment', merchantOrderId: order.orderId, dispatchCount: this.fixture.dispatchCount };
    this.state.phase = 'completed'; delete this.state.error;
    this.state.metrics = { elapsedMs: performance.now() - this.started, merchantDispatches: this.fixture.dispatchCount, modelCalls: 0, modelCostUsd: 0,
      infrastructureCostUsd: null, timingNote: 'Full interactive run including human waiting; not a model benchmark' };
    this.event('completed', 'Permitted sandbox fulfillment verified and recorded on local Solana. No real payment or delivery occurred.');
    await this.persist(); return { ok: true };
  }
  async reconcile() {
    if (this.state.phase !== 'needs_reconciliation' || !this.state.execution.attemptId) return { ok: false, code: 'nothing_to_reconcile' };
    const chain = await this.chainCall('state');
    if (!chain.accepted) return { ok: false, code: 'chain_unavailable_for_reconciliation' };
    this.state.authorization.status = chain.state?.mandate?.status || 'Unknown — reconcile';
    const order = this.fixture.byAttempt(this.state.execution.attemptId);
    if (!order) return this.reject('no_matching_order', 'No matching order exists. Leave the consumed authorization stopped for operator review.', 'needs_reconciliation');
    const observed = await this.browser.order(this.id, order.orderId);
    this.event('reconciliation', 'Read the existing merchant order; no second checkout request was submitted.');
    return this.complete(observed);
  }
  async close() { if (this.closed) return; this.closed = true; this.chain?.close(); await this.browser?.close(); }
}
