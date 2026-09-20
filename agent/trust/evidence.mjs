import { createHash } from 'node:crypto';

// Pure, local evidence construction. No filesystem, network, keys, signatures,
// payment execution, approval authentication or merchant attestation occurs.
export class EvidenceError extends Error {
  constructor(code) { super(code); this.name = 'EvidenceError'; this.code = code; }
}
const requireValue = (condition, code) => { if (!condition) throw new EvidenceError(code); };
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const digest = value => createHash('sha256').update(value).digest('hex');
const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const id = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/.test(value);
const number = value => Number.isSafeInteger(value) && value >= 0;
const currency = value => typeof value === 'string' && /^[A-Z]{3}$/.test(value);
const publicText = value => typeof value === 'string' && value.length > 0 && value.length <= 240 && !/[\x00-\x1f]/.test(value);
export const GENESIS_HASH = '0'.repeat(64);

/** Deterministic JSON for this library's JSON subset, not a claim of general
 * cross-language RFC 8785 compatibility. Keys sort; array order is preserved. */
export function canonicalize(value) {
  const seen = new Set();
  function encode(item, depth) {
    requireValue(depth <= 30, 'canonical_depth_limit');
    if (item === null || typeof item === 'boolean') return JSON.stringify(item);
    if (typeof item === 'string') { requireValue(item.length <= 100000, 'canonical_string_limit'); return JSON.stringify(item); }
    if (typeof item === 'number') { requireValue(Number.isFinite(item), 'non_json_number'); return JSON.stringify(item); }
    requireValue(Array.isArray(item) || plain(item), 'non_json_value');
    requireValue(!seen.has(item), 'cyclic_value'); seen.add(item);
    let result;
    if (Array.isArray(item)) {
      requireValue(item.length <= 1000, 'canonical_array_limit');
      result = '[' + Array.from({ length: item.length }, (_, index) => encode(item[index], depth + 1)).join(',') + ']';
    } else {
      requireValue(Object.getOwnPropertySymbols(item).length === 0, 'non_json_value');
      const keys = Object.keys(item).sort(); requireValue(keys.length <= 1000, 'canonical_object_limit');
      result = '{' + keys.map(key => JSON.stringify(key) + ':' + encode(item[key], depth + 1)).join(',') + '}';
    }
    seen.delete(item); return result;
  }
  const result = encode(value, 0);
  requireValue(Buffer.byteLength(result, 'utf8') <= 1000000, 'canonical_size_limit');
  return result;
}
function fields(value, required, optional = []) {
  requireValue(plain(value) && required.every(key => Object.hasOwn(value, key))
    && Object.keys(value).every(key => [...required, ...optional].includes(key)), 'unsupported_record_fields');
}
function items(value) {
  requireValue(Array.isArray(value) && value.length > 0 && value.length <= 100, 'invalid_items');
  const unique = new Set(); let sum = 0;
  for (const item of value) {
    fields(item, ['itemId', 'title', 'quantity', 'unitPriceMinor']);
    requireValue(id(item.itemId) && !unique.has(item.itemId) && publicText(item.title)
      && Number.isSafeInteger(item.quantity) && item.quantity > 0 && item.quantity <= 1000 && number(item.unitPriceMinor), 'invalid_item');
    unique.add(item.itemId); sum += item.quantity * item.unitPriceMinor;
    requireValue(Number.isSafeInteger(sum), 'amount_overflow');
  }
  return sum;
}
function evidence(value) {
  fields(value, [], ['screenshotSha256', 'observationSha256']);
  requireValue(Object.keys(value).length > 0 && Object.values(value).every(hash), 'invalid_evidence_hash');
}
export function hashArtifact(bytes) {
  requireValue(bytes instanceof Uint8Array && bytes.byteLength > 0 && bytes.byteLength <= 32 * 1024 * 1024, 'invalid_artifact_bytes');
  return digest(bytes);
}
export function hashObservation(observation) {
  fields(observation, ['kind', 'observedAt'], ['origin', 'pathname', 'title', 'headings', 'items', 'merchantId', 'currency', 'totalMinor', 'orderId', 'cartCount',
    'mandateId', 'quoteId', 'approvalId', 'confirmationId', 'eventHash', 'quoteHash']);
  requireValue(['quote', 'approval', 'cart', 'confirmation'].includes(observation.kind) && number(observation.observedAt), 'invalid_observation');
  if (observation.origin !== undefined) {
    let url; try { url = new URL(observation.origin); } catch { throw new EvidenceError('invalid_observation_origin'); }
    requireValue(['http:', 'https:'].includes(url.protocol) && url.origin === observation.origin, 'invalid_observation_origin');
  }
  if (observation.pathname !== undefined) requireValue(typeof observation.pathname === 'string' && observation.pathname.startsWith('/')
    && observation.pathname.length <= 500 && !/[?#\x00-\x1f]/.test(observation.pathname), 'invalid_observation_path');
  if (observation.title !== undefined) requireValue(publicText(observation.title), 'invalid_observation');
  if (observation.headings !== undefined) requireValue(Array.isArray(observation.headings) && observation.headings.length <= 20 && observation.headings.every(publicText), 'invalid_observation');
  if (observation.items !== undefined) items(observation.items);
  for (const key of ['merchantId', 'orderId', 'mandateId', 'quoteId', 'approvalId', 'confirmationId']) if (observation[key] !== undefined) requireValue(id(observation[key]), 'invalid_observation');
  for (const key of ['eventHash', 'quoteHash']) if (observation[key] !== undefined) requireValue(hash(observation[key]), 'invalid_observation');
  if (observation.currency !== undefined) requireValue(currency(observation.currency), 'invalid_currency');
  for (const key of ['totalMinor', 'cartCount']) if (observation[key] !== undefined) requireValue(number(observation[key]), 'invalid_observation');
  return digest('trust-observation-v1\n' + canonicalize(observation));
}

const schemas = {
  mandate: { required: ['mandateId', 'currency', 'maxTotalMinor', 'expiresAt'], optional: ['allowedMerchantIds'] },
  quote: { required: ['mandateId', 'quoteId', 'merchantId', 'currency', 'totalMinor', 'items', 'expiresAt'], optional: ['feesMinor', 'evidence'] },
  approval: { required: ['mandateId', 'quoteId', 'quoteHash', 'approvalId', 'decision'], optional: [] },
  execution: { required: ['mandateId', 'quoteId', 'quoteHash', 'approvalId', 'executionId', 'mode'], optional: [] },
  confirmation: { required: ['mandateId', 'quoteId', 'quoteHash', 'approvalId', 'executionId', 'confirmationId', 'merchantId', 'orderId', 'currency', 'totalMinor', 'mode'], optional: ['evidence'] },
  rejection: { required: ['mandateId', 'rejectionId', 'reason'], optional: ['quoteId', 'evidence'] },
  boundary_evidence: { required: ['mandateId', 'quoteId', 'stage', 'eventHash', 'evidence'], optional: ['approvalId', 'confirmationId'] },
};
function validateRecord(record) {
  requireValue(plain(record) && Object.hasOwn(schemas, record.type), 'unsupported_record_type');
  const schema = schemas[record.type]; fields(record, ['type', 'at', ...schema.required], schema.optional);
  requireValue(number(record.at), 'invalid_record_time');
  for (const key of ['mandateId', 'quoteId', 'approvalId', 'executionId', 'confirmationId', 'merchantId', 'orderId', 'rejectionId']) {
    if (record[key] !== undefined) requireValue(id(record[key]), 'invalid_identifier');
  }
  if (record.quoteHash !== undefined) requireValue(hash(record.quoteHash), 'invalid_quote_hash');
  if (record.currency !== undefined) requireValue(currency(record.currency), 'invalid_currency');
  for (const key of ['maxTotalMinor', 'totalMinor', 'feesMinor']) if (record[key] !== undefined) requireValue(number(record[key]), 'invalid_amount');
  if (record.expiresAt !== undefined) requireValue(number(record.expiresAt) && record.expiresAt > record.at, 'invalid_expiry');
  if (record.evidence !== undefined) evidence(record.evidence);
  if (record.type === 'mandate' && record.allowedMerchantIds !== undefined) {
    requireValue(Array.isArray(record.allowedMerchantIds) && record.allowedMerchantIds.length > 0 && record.allowedMerchantIds.length <= 100
      && record.allowedMerchantIds.every(id) && new Set(record.allowedMerchantIds).size === record.allowedMerchantIds.length, 'invalid_allowed_merchants');
  }
  if (record.type === 'quote') {
    const total = items(record.items) + (record.feesMinor || 0);
    requireValue(Number.isSafeInteger(total) && total === record.totalMinor, 'quote_total_mismatch');
  }
  if (record.type === 'approval') requireValue(['approved', 'rejected'].includes(record.decision), 'invalid_approval_decision');
  if (record.mode !== undefined) requireValue(['simulated', 'observed'].includes(record.mode), 'invalid_execution_mode');
  if (record.type === 'rejection') requireValue(typeof record.reason === 'string' && /^[a-z][a-z0-9_]{0,79}$/.test(record.reason), 'invalid_rejection_reason');
  if (record.type === 'boundary_evidence') {
    requireValue(['quote', 'approval', 'confirmation'].includes(record.stage) && hash(record.eventHash), 'invalid_boundary_reference');
    requireValue(hash(record.evidence.screenshotSha256) && hash(record.evidence.observationSha256), 'boundary_requires_both_artifacts');
    requireValue(record.stage === 'quote' ? record.approvalId === undefined && record.confirmationId === undefined
      : record.stage === 'approval' ? id(record.approvalId) && record.confirmationId === undefined
        : id(record.approvalId) && id(record.confirmationId), 'boundary_identifier_mismatch');
  }
  canonicalize(record);
  return record;
}
export function quoteHash(quote) {
  validateRecord(quote); requireValue(quote.type === 'quote', 'quote_required');
  return digest('trust-quote-v1\n' + canonicalize(quote));
}
function envelopeHash(envelope) {
  return digest('trust-chain-v1\n' + canonicalize({ version: envelope.version, index: envelope.index, prevHash: envelope.prevHash, record: envelope.record }));
}
function freshState() {
  return { mandates: new Map(), quotes: new Map(), approvals: new Map(), executions: new Map(), confirmations: new Set(), rejections: new Set(),
    orders: new Set(), envelopes: new Map(), boundaries: new Map(), lastAt: -1 };
}
function applyRecord(state, record) {
  validateRecord(record);
  requireValue(record.at >= state.lastAt, 'record_time_reversed'); state.lastAt = record.at;
  if (record.type === 'mandate') {
    requireValue(!state.mandates.has(record.mandateId), 'duplicate_mandate');
    state.mandates.set(record.mandateId, { record, quoteId: null, approvalId: null, executionId: null }); return;
  }
  const mandate = state.mandates.get(record.mandateId);
  requireValue(mandate, 'missing_mandate');
  if (record.type === 'boundary_evidence') {
    const target = state.envelopes.get(record.eventHash);
    requireValue(target && target.type === record.stage && target.mandateId === record.mandateId && target.quoteId === record.quoteId
      && target.approvalId === record.approvalId && target.confirmationId === record.confirmationId, 'boundary_reference_mismatch');
    requireValue(!state.boundaries.has(record.eventHash), 'duplicate_boundary_evidence');
    state.boundaries.set(record.eventHash, record); return;
  }
  if (record.type === 'rejection') {
    requireValue(!state.rejections.has(record.rejectionId), 'duplicate_rejection');
    if (record.quoteId !== undefined) requireValue(state.quotes.get(record.quoteId)?.mandateId === record.mandateId, 'quote_mandate_mismatch');
    state.rejections.add(record.rejectionId); return; // Rejected attempts do not alter approval state.
  }
  if (record.type === 'quote') {
    requireValue(!state.quotes.has(record.quoteId), 'duplicate_quote');
    requireValue(!mandate.executionId, 'mandate_already_executed');
    requireValue(record.at < mandate.record.expiresAt && record.expiresAt <= mandate.record.expiresAt, 'mandate_expired');
    requireValue(record.currency === mandate.record.currency, 'currency_mismatch');
    requireValue(record.totalMinor <= mandate.record.maxTotalMinor, 'budget_exceeded');
    requireValue(!mandate.record.allowedMerchantIds || mandate.record.allowedMerchantIds.includes(record.merchantId), 'merchant_not_allowed');
    state.quotes.set(record.quoteId, record); mandate.quoteId = record.quoteId; mandate.approvalId = null; return;
  }
  const quote = state.quotes.get(record.quoteId);
  requireValue(quote?.mandateId === record.mandateId, 'quote_mandate_mismatch');
  requireValue(record.quoteHash === quoteHash(quote), 'quote_hash_mismatch');
  requireValue(record.quoteId === mandate.quoteId, 'quote_superseded');
  if (record.type === 'approval') {
    requireValue(!state.approvals.has(record.approvalId), 'duplicate_approval');
    requireValue(!mandate.executionId, 'mandate_already_executed');
    requireValue(record.at < quote.expiresAt && record.at < mandate.record.expiresAt, 'quote_expired');
    state.approvals.set(record.approvalId, record); mandate.approvalId = record.approvalId; return;
  }
  const approval = state.approvals.get(record.approvalId);
  requireValue(approval?.decision === 'approved' && approval.mandateId === record.mandateId && approval.quoteId === record.quoteId
    && approval.quoteHash === record.quoteHash && mandate.approvalId === record.approvalId, 'approval_mismatch');
  if (record.type === 'execution') {
    requireValue(!state.executions.has(record.executionId) && !mandate.executionId, 'already_executed');
    requireValue(record.at < quote.expiresAt && record.at < mandate.record.expiresAt, 'quote_expired');
    state.executions.set(record.executionId, { record, confirmed: false }); mandate.executionId = record.executionId; return;
  }
  const execution = state.executions.get(record.executionId);
  requireValue(execution && execution.record.mandateId === record.mandateId && execution.record.quoteId === record.quoteId
    && execution.record.quoteHash === record.quoteHash && execution.record.approvalId === record.approvalId
    && execution.record.mode === record.mode, 'execution_mismatch');
  requireValue(!execution.confirmed && !state.confirmations.has(record.confirmationId), 'duplicate_confirmation');
  requireValue(record.merchantId === quote.merchantId && record.currency === quote.currency && record.totalMinor === quote.totalMinor, 'confirmation_quote_mismatch');
  const orderKey = canonicalize([record.merchantId, record.orderId]);
  requireValue(!state.orders.has(orderKey), 'duplicate_merchant_order');
  execution.confirmed = true; state.confirmations.add(record.confirmationId); state.orders.add(orderKey);
}
function inspectChain(chain) {
  requireValue(Array.isArray(chain) && chain.length <= 10000, 'invalid_chain');
  const state = freshState(); let previous = GENESIS_HASH;
  for (const [index, envelope] of chain.entries()) {
    try {
      fields(envelope, ['version', 'index', 'prevHash', 'record', 'hash']);
      requireValue(envelope.version === 1 && envelope.index === index, 'sequence_mismatch');
      requireValue(envelope.prevHash === previous && hash(envelope.hash), 'chain_link_mismatch');
      requireValue(envelope.hash === envelopeHash(envelope), 'record_hash_mismatch');
      applyRecord(state, envelope.record); state.envelopes.set(envelope.hash, envelope.record); previous = envelope.hash;
    } catch (error) { error.index = index; throw error; }
  }
  return { state, headHash: previous };
}
function freeze(value) {
  if (value && typeof value === 'object') { for (const child of Object.values(value)) freeze(child); Object.freeze(value); }
  return value;
}
export function appendRecord(chain, record) {
  const { state, headHash } = inspectChain(chain);
  requireValue(chain.length < 10000, 'chain_length_limit');
  const copied = JSON.parse(canonicalize(record)); applyRecord(state, copied);
  const envelope = { version: 1, index: chain.length, prevHash: headHash, record: copied };
  envelope.hash = envelopeHash(envelope);
  return freeze([...chain.map(item => JSON.parse(canonicalize(item))), envelope]);
}

/** Artifacts: Map/object keyed by SHA256, values {kind:'screenshot',bytes} or
 * {kind:'observation',observation}. Bytes/observations stay outside the chain.
 * A separately trusted expectedHead is needed to detect tail truncation or a
 * completely rewritten, internally consistent chain. */
export function verifyEvidence({ chain, artifacts = {}, expectedHead, requireBoundaryEvidence = false } = {}) {
  const issues = [], artifactIssues = []; let checked;
  if (!(artifacts instanceof Map) && !plain(artifacts)) { artifactIssues.push({ index: null, code: 'invalid_artifact_store' }); artifacts = {}; }
  try { checked = inspectChain(chain); }
  catch (error) { issues.push({ index: Number.isInteger(error.index) ? error.index : null, code: error instanceof EvidenceError ? error.code : 'invalid_evidence' }); }
  if (expectedHead !== undefined) {
    if (!hash(expectedHead)) issues.push({ index: null, code: 'invalid_expected_head' });
    else if (checked && checked.headHash !== expectedHead) issues.push({ index: null, code: 'head_mismatch' });
  }
  const integrityValid = Boolean(checked) && issues.length === 0;
  const artifactResults = new Map();
  if (checked) for (const [index, envelope] of chain.entries()) {
    for (const [field, reference] of Object.entries(envelope.record.evidence || {})) {
      const artifact = artifacts instanceof Map ? artifacts.get(reference) : Object.hasOwn(artifacts, reference) ? artifacts[reference] : undefined;
      const artifactKey = field + ':' + reference;
      if (!artifact) { artifactIssues.push({ index, code: 'missing_artifact', hash: reference }); artifactResults.set(artifactKey, false); continue; }
      try {
        const kind = field === 'screenshotSha256' ? 'screenshot' : 'observation';
        requireValue(artifact.kind === kind, 'artifact_kind_mismatch');
        const actual = kind === 'screenshot' ? hashArtifact(artifact.bytes) : hashObservation(artifact.observation);
        requireValue(actual === reference, 'artifact_hash_mismatch');
        artifactResults.set(artifactKey, true);
      } catch (error) { artifactIssues.push({ index, code: error instanceof EvidenceError ? error.code : 'invalid_artifact', hash: reference }); artifactResults.set(artifactKey, false); }
    }
  }
  const boundaries = checked ? chain.filter(envelope => ['quote', 'approval', 'confirmation'].includes(envelope.record.type)).map(envelope => {
    const reference = checked.state.boundaries.get(envelope.hash)?.evidence || envelope.record.evidence || {};
    const hasScreenshot = hash(reference.screenshotSha256), hasObservation = hash(reference.observationSha256);
    const stored = artifacts instanceof Map ? artifacts.get(reference.observationSha256)
      : Object.hasOwn(artifacts, reference.observationSha256) ? artifacts[reference.observationSha256] : undefined;
    const observation = stored?.kind === 'observation' && artifactResults.get('observationSha256:' + reference.observationSha256) === true
      ? stored.observation : null;
    const quoted = checked.state.quotes.get(envelope.record.quoteId);
    const expected = { mandateId: envelope.record.mandateId, quoteId: envelope.record.quoteId, approvalId: envelope.record.approvalId,
      confirmationId: envelope.record.confirmationId, eventHash: envelope.hash, quoteHash: quoteHash(quoted),
      merchantId: quoted.merchantId, currency: quoted.currency, totalMinor: quoted.totalMinor, orderId: envelope.record.orderId };
    const observationMatchesRecord = observation ? observation.kind === envelope.record.type
      && Object.entries(expected).every(([key, value]) => observation[key] === undefined || observation[key] === value)
      && (observation.items === undefined || canonicalize(observation.items) === canonicalize(quoted.items)) : null;
    return { index: envelope.index, stage: envelope.record.type, eventHash: envelope.hash,
      mandateId: envelope.record.mandateId, quoteId: envelope.record.quoteId, hasScreenshot, hasObservation,
      observationMatchesRecord,
      complete: hasScreenshot && hasObservation && artifactResults.get('screenshotSha256:' + reference.screenshotSha256) === true
        && artifactResults.get('observationSha256:' + reference.observationSha256) === true && observationMatchesRecord === true };
  }) : [];
  const boundaryComplete = Boolean(checked) && boundaries.every(boundary => boundary.complete);
  if (requireBoundaryEvidence) for (const boundary of boundaries) if (!boundary.complete) {
    issues.push({ index: boundary.index, code: !boundary.hasScreenshot || !boundary.hasObservation ? 'missing_boundary_evidence'
      : boundary.observationMatchesRecord === false ? 'boundary_observation_mismatch' : 'boundary_artifact_unavailable', stage: boundary.stage });
  }
  issues.push(...artifactIssues);
  return { valid: integrityValid && artifactIssues.length === 0 && (!requireBoundaryEvidence || boundaryComplete),
    integrityValid, artifactsValid: artifactIssues.length === 0, boundaryComplete, requireBoundaryEvidence: Boolean(requireBoundaryEvidence), boundaries,
    issues, headHash: checked?.headHash || null, anchored: expectedHead !== undefined && hash(expectedHead),
    recordCount: Array.isArray(chain) ? chain.length : 0,
    confirmedOrders: checked ? [...checked.state.executions.values()].filter(item => item.confirmed).length : 0,
    approvalAuthenticated: false, merchantFactsVerified: false,
    meaning: 'Integrity and recorded mandate/quote/approval/execution correlations only. Hashes do not authenticate an approver or prove merchant facts. An external trusted head is required to detect rewritten history or a removed tail.' };
}
