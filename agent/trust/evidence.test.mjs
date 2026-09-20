import test from 'node:test';
import assert from 'node:assert/strict';
import { canonicalize, hashArtifact, hashObservation, quoteHash, appendRecord, verifyEvidence, GENESIS_HASH } from './evidence.mjs';

const mandate = { type: 'mandate', at: 1000, mandateId: 'gift-1', currency: 'PLN', maxTotalMinor: 12000,
  expiresAt: 20000, allowedMerchantIds: ['merchant-1'] };
const quote = { type: 'quote', at: 1100, mandateId: 'gift-1', quoteId: 'quote-1', merchantId: 'merchant-1', currency: 'PLN',
  totalMinor: 10500, items: [{ itemId: 'item-1', title: 'Travel bottle', quantity: 2, unitPriceMinor: 5000 }], feesMinor: 500, expiresAt: 10000 };
const approval = () => ({ type: 'approval', at: 1200, mandateId: 'gift-1', quoteId: 'quote-1', quoteHash: quoteHash(quote), approvalId: 'approval-1', decision: 'approved' });
const execution = () => ({ type: 'execution', at: 1300, mandateId: 'gift-1', quoteId: 'quote-1', quoteHash: quoteHash(quote), approvalId: 'approval-1', executionId: 'execution-1', mode: 'simulated' });
const confirmation = () => ({ type: 'confirmation', at: 1400, mandateId: 'gift-1', quoteId: 'quote-1', quoteHash: quoteHash(quote), approvalId: 'approval-1',
  executionId: 'execution-1', confirmationId: 'confirmation-1', merchantId: 'merchant-1', orderId: 'demo-order-1', currency: 'PLN', totalMinor: 10500, mode: 'simulated' });
const build = records => records.reduce((chain, record) => appendRecord(chain, record), []);
const clone = value => JSON.parse(JSON.stringify(value));

test('canonical observation hashing is stable under key order but binds content and list order', () => {
  const a = { kind: 'cart', observedAt: 10, title: 'Cart', currency: 'PLN', totalMinor: 10500, headings: ['Cart', 'Total'] };
  const b = Object.fromEntries(Object.entries(a).reverse());
  assert.equal(hashObservation(a), hashObservation(b));
  assert.notEqual(hashObservation(a), hashObservation({ ...a, totalMinor: 10501 }));
  assert.notEqual(hashObservation(a), hashObservation({ ...a, headings: [...a.headings].reverse() }));
  assert.equal(canonicalize({ z: 2, a: [1, true] }), '{"a":[1,true],"z":2}');
  for (const value of [undefined, NaN, Infinity, 1n, new Date(), [, 1]]) assert.throws(() => canonicalize(value));
  const cycle = {}; cycle.self = cycle; assert.throws(() => canonicalize(cycle), /cyclic_value/);
});

test('unknown fields including credentials/payment data and raw observation URL/query are rejected', () => {
  for (const field of ['password', 'cookies', 'headers', 'paymentToken', 'cardNumber', 'secretKey', 'wallet']) {
    assert.throws(() => appendRecord([], { ...mandate, [field]: 'not-stored' }), /unsupported_record_fields/);
    assert.throws(() => hashObservation({ kind: 'cart', observedAt: 10, [field]: 'not-stored' }), /unsupported_record_fields/);
  }
  assert.throws(() => hashObservation({ kind: 'cart', observedAt: 10, url: 'https://shop.test/?secret=1' }), /unsupported_record_fields/);
  assert.throws(() => hashObservation({ kind: 'cart', observedAt: 10, pathname: '/cart?token=secret' }), /invalid_observation_path/);
  assert.throws(() => hashObservation({ kind: 'cart', observedAt: 10, origin: 'https://name:secret@shop.test' }), /invalid_observation_origin/);
});

test('immutable append-only chain correlates mandate, exact quote, approval, execution and merchant order', () => {
  const first = appendRecord([], mandate), full = build([mandate, quote, approval(), execution(), confirmation()]);
  assert.equal(first.length, 1); assert.equal(first[0].prevHash, GENESIS_HASH);
  assert.equal(full[1].prevHash, full[0].hash); assert.equal(full[4].index, 4);
  assert.throws(() => full[1].record.items[0].quantity = 99, TypeError);
  const result = verifyEvidence({ chain: full, expectedHead: full.at(-1).hash });
  assert.equal(result.valid, true); assert.equal(result.anchored, true); assert.equal(result.confirmedOrders, 1);
  assert.equal(result.approvalAuthenticated, false); assert.equal(result.merchantFactsVerified, false);
});

test('quote binding includes quantities, item identity, merchant, fees, expiry and evidence hashes', () => {
  const original = quoteHash(quote);
  const changes = [{ merchantId: 'merchant-2' }, { expiresAt: 9999 }, { feesMinor: 600, totalMinor: 10600 },
    { items: [{ ...quote.items[0], itemId: 'item-other' }] }, { evidence: { screenshotSha256: 'a'.repeat(64) } }];
  for (const change of changes) assert.notEqual(quoteHash({ ...quote, ...change }), original);
  assert.throws(() => quoteHash({ ...quote, totalMinor: 1 }), /quote_total_mismatch/);
  assert.throws(() => appendRecord([ ...build([mandate]) ], { ...quote, totalMinor: 12500, feesMinor: 2500 }), /budget_exceeded/);
  assert.throws(() => appendRecord(build([mandate]), { ...quote, merchantId: 'merchant-2' }), /merchant_not_allowed/);
  assert.throws(() => appendRecord(build([mandate]), { ...quote, currency: 'USD' }), /currency_mismatch/);
});

test('approval mismatch, expired and superseded quotes are denied before execution', () => {
  const quoted = build([mandate, quote]);
  assert.throws(() => appendRecord(quoted, { ...approval(), quoteHash: 'f'.repeat(64) }), /quote_hash_mismatch/);
  assert.throws(() => appendRecord(quoted, { ...approval(), at: quote.expiresAt }), /quote_expired/);
  const revised = appendRecord(quoted, { ...quote, at: 1150, quoteId: 'quote-2', feesMinor: 600, totalMinor: 10600 });
  assert.throws(() => appendRecord(revised, approval()), /quote_superseded/);
  assert.throws(() => appendRecord(quoted, execution()), /approval_mismatch/);
  const rejected = appendRecord(quoted, { ...approval(), decision: 'rejected' });
  assert.throws(() => appendRecord(rejected, execution()), /approval_mismatch/);
  assert.throws(() => appendRecord(build([mandate, quote, approval()]), { ...execution(), approvalId: 'different' }), /approval_mismatch/);
});

test('one-shot execution and correlated confirmation forbid retries, wrong orders and changed price', () => {
  const executed = build([mandate, quote, approval(), execution()]);
  assert.throws(() => appendRecord(executed, { ...execution(), executionId: 'execution-2', at: 1350 }), /already_executed/);
  assert.throws(() => appendRecord(executed, { ...confirmation(), totalMinor: 10501 }), /confirmation_quote_mismatch/);
  assert.throws(() => appendRecord(executed, { ...confirmation(), merchantId: 'merchant-2' }), /confirmation_quote_mismatch/);
  assert.throws(() => appendRecord(executed, { ...confirmation(), executionId: 'other' }), /execution_mismatch/);
  assert.throws(() => appendRecord(executed, { ...confirmation(), mode: 'observed' }), /execution_mismatch/);
  const completed = appendRecord(executed, confirmation());
  assert.throws(() => appendRecord(completed, { ...confirmation(), at: 1500, confirmationId: 'confirmation-2' }), /duplicate_confirmation/);
  // A timely execution can receive its correlated confirmation after quote expiry.
  assert.equal(verifyEvidence({ chain: appendRecord(executed, { ...confirmation(), at: 21000 }) }).valid, true);
});

test('rejections are auditable without altering the last approved quote or faking an out-of-policy quote', () => {
  const approved = build([mandate, quote, approval()]);
  const rejected = appendRecord(approved, { type: 'rejection', at: 1250, mandateId: 'gift-1', quoteId: 'quote-1', rejectionId: 'rejection-1', reason: 'fresh_price_mismatch' });
  assert.equal(verifyEvidence({ chain: rejected }).valid, true);
  assert.equal(verifyEvidence({ chain: appendRecord(rejected, execution()) }).valid, true);
  const expired = appendRecord(approved, { type: 'rejection', at: 21000, mandateId: 'gift-1', rejectionId: 'rejection-expired', reason: 'quote_expired' });
  assert.equal(verifyEvidence({ chain: expired }).valid, true);
  assert.throws(() => appendRecord(expired, { ...execution(), at: 21001 }), /quote_expired/);
});

test('missing, changed, removed and reordered chain records are detected; trusted head catches removed tail', () => {
  const full = build([mandate, quote, approval(), execution(), confirmation()]);
  const tampered = clone(full); tampered[1].record.items[0].title = 'Changed item';
  assert.equal(verifyEvidence({ chain: tampered }).issues[0].code, 'record_hash_mismatch');
  assert.equal(verifyEvidence({ chain: full.filter((_, i) => i !== 2) }).valid, false);
  const swapped = clone(full); [swapped[1], swapped[2]] = [swapped[2], swapped[1]];
  assert.equal(verifyEvidence({ chain: swapped }).valid, false);
  const truncated = full.slice(0, -1);
  assert.equal(verifyEvidence({ chain: truncated }).valid, true); // No unauthenticated claim to know the missing tail.
  assert.equal(verifyEvidence({ chain: truncated }).anchored, false);
  assert.equal(verifyEvidence({ chain: truncated, expectedHead: full.at(-1).hash }).issues[0].code, 'head_mismatch');
  assert.throws(() => appendRecord(tampered, confirmation()), /record_hash_mismatch/);
});

test('referenced screenshot and canonical observation hashes detect missing or altered artifacts', () => {
  const bytes = new Uint8Array([137, 80, 78, 71, 1, 2, 3]); // Synthetic bytes, not a claim of a decoded screenshot.
  const observation = { kind: 'quote', observedAt: 1100, origin: 'https://shop.test', pathname: '/cart',
    title: 'Quote', items: quote.items, merchantId: 'merchant-1', currency: 'PLN', totalMinor: 10500 };
  const screenshotSha256 = hashArtifact(bytes), observationSha256 = hashObservation(observation);
  const quoted = { ...quote, evidence: { screenshotSha256, observationSha256 } };
  const chain = build([mandate, quoted]);
  const artifacts = new Map([[screenshotSha256, { kind: 'screenshot', bytes }], [observationSha256, { kind: 'observation', observation }]]);
  assert.equal(verifyEvidence({ chain, artifacts }).valid, true);
  assert.equal(verifyEvidence({ chain }).issues.filter(issue => issue.code === 'missing_artifact').length, 2);
  artifacts.set(screenshotSha256, { kind: 'screenshot', bytes: new Uint8Array([0]) });
  assert.equal(verifyEvidence({ chain, artifacts }).issues[0].code, 'artifact_hash_mismatch');
  assert.equal(verifyEvidence({ chain, artifacts: null }).valid, false);
});

test('newly rehashed malicious history remains detectable only against a separately trusted head', () => {
  const original = build([mandate, quote]);
  const rewritten = build([mandate, { ...quote, items: [{ ...quote.items[0], title: 'Rewritten public claim' }] }]);
  assert.equal(verifyEvidence({ chain: rewritten }).valid, true);
  assert.equal(verifyEvidence({ chain: rewritten, expectedHead: original.at(-1).hash }).valid, false);
  assert.equal(verifyEvidence({ chain: rewritten }).merchantFactsVerified, false);
});

test('strict boundary verification separates valid history from missing quote/approval/confirmation captures', () => {
  const chain = build([mandate, quote, approval(), execution(), confirmation()]);
  const ordinary = verifyEvidence({ chain });
  assert.equal(ordinary.valid, true); assert.equal(ordinary.integrityValid, true); assert.equal(ordinary.boundaryComplete, false);
  const strict = verifyEvidence({ chain, requireBoundaryEvidence: true });
  assert.equal(strict.valid, false); assert.equal(strict.integrityValid, true); assert.equal(strict.artifactsValid, true);
  assert.deepEqual(strict.issues.map(issue => [issue.code, issue.stage]), [
    ['missing_boundary_evidence', 'quote'], ['missing_boundary_evidence', 'approval'], ['missing_boundary_evidence', 'confirmation']]);
});

test('append-only boundary attachments bind exact prior event hashes without changing the approved quote', () => {
  let chain = build([mandate, quote, approval(), execution(), confirmation()]);
  const originalQuoteEnvelope = chain[1], originalQuoteHash = quoteHash(quote), artifacts = new Map();
  const reached = chain.filter(envelope => ['quote', 'approval', 'confirmation'].includes(envelope.record.type));
  for (const [index, envelope] of reached.entries()) {
    const stage = envelope.record.type, at = 1500 + index * 100;
    const bytes = new Uint8Array(Buffer.from('synthetic-capture-' + stage));
    const observation = { kind: stage, observedAt: at, mandateId: 'gift-1', quoteId: 'quote-1', eventHash: envelope.hash,
      ...(stage !== 'quote' ? { approvalId: 'approval-1' } : {}), ...(stage === 'confirmation' ? { confirmationId: 'confirmation-1' } : {}) };
    const screenshotSha256 = hashArtifact(bytes), observationSha256 = hashObservation(observation);
    artifacts.set(screenshotSha256, { kind: 'screenshot', bytes });
    artifacts.set(observationSha256, { kind: 'observation', observation });
    chain = appendRecord(chain, { type: 'boundary_evidence', at, stage, eventHash: envelope.hash, mandateId: 'gift-1', quoteId: 'quote-1',
      ...(stage !== 'quote' ? { approvalId: 'approval-1' } : {}), ...(stage === 'confirmation' ? { confirmationId: 'confirmation-1' } : {}),
      evidence: { screenshotSha256, observationSha256 } });
  }
  assert.equal(chain[1].hash, originalQuoteEnvelope.hash); assert.equal(quoteHash(chain[1].record), originalQuoteHash);
  const verified = verifyEvidence({ chain, artifacts, expectedHead: chain.at(-1).hash, requireBoundaryEvidence: true });
  assert.equal(verified.valid, true); assert.equal(verified.integrityValid, true); assert.equal(verified.boundaryComplete, true);
  assert.equal(verified.approvalAuthenticated, false); assert.equal(verified.merchantFactsVerified, false);
  const attachment = chain.at(-1).record;
  assert.throws(() => appendRecord(chain, { ...attachment, at: 1800 }), /duplicate_boundary_evidence/);
  artifacts.delete(chain[6].record.evidence.screenshotSha256);
  const missing = verifyEvidence({ chain, artifacts, requireBoundaryEvidence: true });
  assert.equal(missing.integrityValid, true); assert.equal(missing.artifactsValid, false); assert.equal(missing.boundaryComplete, false);
  assert(missing.issues.some(issue => issue.stage === 'approval' && issue.code === 'boundary_artifact_unavailable'));
});

test('boundary attachments reject incorrect stage, event or approval correlation', () => {
  const chain = build([mandate, quote, approval()]);
  const attachment = { type: 'boundary_evidence', at: 1250, stage: 'approval', eventHash: chain[2].hash,
    mandateId: 'gift-1', quoteId: 'quote-1', approvalId: 'approval-1',
    evidence: { screenshotSha256: 'a'.repeat(64), observationSha256: 'b'.repeat(64) } };
  assert.throws(() => appendRecord(chain, { ...attachment, eventHash: chain[1].hash }), /boundary_reference_mismatch/);
  assert.throws(() => appendRecord(chain, { ...attachment, approvalId: 'other-approval' }), /boundary_reference_mismatch/);
  assert.throws(() => appendRecord(chain, { ...attachment, quoteId: 'other-quote' }), /boundary_reference_mismatch/);
  assert.throws(() => appendRecord(chain, { ...attachment, evidence: { screenshotSha256: 'a'.repeat(64) } }), /boundary_requires_both_artifacts/);
  assert.throws(() => appendRecord(chain, { ...attachment, stage: 'quote' }), /boundary_identifier_mismatch/);
});

test('strict boundary checks reject an intact artifact that states a different quote or order', () => {
  const bytes = new Uint8Array([1, 2, 3]);
  const screenshotSha256 = hashArtifact(bytes);
  const base = build([mandate, quote]);
  const observation = { kind: 'quote', observedAt: 1150, mandateId: 'gift-1', quoteId: 'different-quote', eventHash: base[1].hash };
  const observationSha256 = hashObservation(observation);
  const chain = appendRecord(base, { type: 'boundary_evidence', at: 1150, stage: 'quote', eventHash: base[1].hash,
    mandateId: 'gift-1', quoteId: 'quote-1', evidence: { screenshotSha256, observationSha256 } });
  const artifacts = { [screenshotSha256]: { kind: 'screenshot', bytes }, [observationSha256]: { kind: 'observation', observation } };
  const result = verifyEvidence({ chain, artifacts, requireBoundaryEvidence: true });
  assert.equal(result.integrityValid, true); assert.equal(result.artifactsValid, true); assert.equal(result.boundaryComplete, false);
  assert.equal(result.valid, false); assert.equal(result.issues[0].code, 'boundary_observation_mismatch');
});
