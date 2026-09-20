import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startIntegrated } from './server.mjs';
import { verifyOrder, MerchantFixture } from './fixture.mjs';
import { hashArtifact } from '../evidence.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const directory = join(here, 'validation-runs', new Date().toISOString().replace(/[:.]/g, '-'));
await mkdir(directory, { recursive: true });
const app = await startIntegrated({ port: 0, directory });
const reports = [];
after(async () => { await app.close(); await writeFile(join(directory, 'validation.json'), JSON.stringify({ environment: 'Actual Playwright browser and compiled Solana SBF in local LiteSVM; simulated merchant', reports }, null, 2)); });

async function client() {
  const initial = await fetch(app.url + '/api/state'), cookie = initial.headers.get('set-cookie').split(';')[0];
  return async (action, payload = {}) => {
    const response = await fetch(app.url + '/api/' + action, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify(payload) });
    return { status: response.status, ...await response.json() };
  };
}
async function prepare(post, scenario = 'happy') { const r = await post('prepare', { scenario }); assert.equal(r.status, 200, JSON.stringify(r)); return r.state; }
async function approve(post, state) { const r = await post('approve', { termsHash: state.quote.termsHash }); assert.equal(r.status, 200, JSON.stringify(r)); assert.equal(r.state.chain.accountState.mandate.status, 'Active'); return r.state; }
function record(name, state) { reports.push({ name, runId: state.runId, phase: state.phase, campaign: state.chain.accountState.campaign?.status, mandate: state.chain.accountState.mandate?.status,
  merchantDispatches: state.execution.dispatchCount, evidenceValid: state.evidence.validation.valid, boundaries: state.evidence.validation.boundaries.map(b => b.stage), verified: state.verification.ok,
  transactions: state.chain.transactions.map(tx => ({ label: tx.label, signature: tx.signature, accepted: tx.success })), metrics: state.metrics }); }

test('three consecutive fresh integrated rehearsals complete with exact encoding and all boundary artifacts', async () => {
  const post = await client(); const campaigns = new Set();
  for (let i = 0; i < 3; i++) {
    const quoted = await prepare(post); campaigns.add(quoted.authorization.campaignAddress);
    assert.equal(quoted.evidence.encodingMatched, true); assert.equal(quoted.evidence.canonicalByteLength, 602);
    assert.equal(quoted.authorization.confirmed, false);
    await approve(post, quoted);
    const result = await post('execute'); assert.equal(result.status, 200, JSON.stringify(result)); const s = result.state;
    assert.equal(s.phase, 'completed'); assert.equal(s.verification.ok, true); assert.equal(s.execution.dispatchCount, 1);
    assert.equal(s.chain.accountState.campaign.status, 'Purchased'); assert.equal(s.chain.accountState.mandate.status, 'Consumed');
    assert.equal(s.evidence.validation.valid, true); assert.deepEqual(s.evidence.validation.boundaries.map(b => b.stage), ['quote', 'approval', 'confirmation']);
    for (const artifact of s.evidence.artifacts) {
      const file = join(directory, s.runId, artifact.url.split('/').at(-1));
      assert.equal(hashArtifact(await readFile(file)), artifact.screenshotSha256);
    }
    record(`fresh_rehearsal_${i + 1}`, s);
    if (i === 2) {
      const replay = await post('execute'); assert.equal(replay.status, 409); assert.equal(replay.code, 'replay_rejected_by_program');
      assert.equal(replay.state.execution.dispatchCount, 1); assert.equal(replay.state.chain.transactions.at(-1).success, false);
      assert.match(replay.state.chain.transactions.at(-1).logs.join('\n'), /InvalidCampaignState|InactiveMandate/);
      assert.notEqual(replay.state.chain.transactions.at(-1).signature, s.chain.transactions.find(tx => tx.label.includes('attempt'))?.signature);
      record('fresh_transaction_replay_rejected', replay.state);
    }
  }
  assert.equal(campaigns.size, 3);
});

test('PLN 129 approval cannot execute PLN 149 checkout and never consumes or dispatches', async () => {
  const post = await client(), q = await prepare(post, 'price_change'); const a = await approve(post, q);
  assert.equal(a.quote.totalMinor, 12900); assert.equal(a.observedQuote.totalMinor, 14900);
  const result = await post('execute'); assert.equal(result.status, 409); assert.equal(result.code, 'checkout_changed');
  assert.equal(result.state.execution.dispatchCount, 0); assert.equal(result.state.chain.accountState.mandate.status, 'Active');
  assert.equal(result.state.chain.accountState.campaign.status, 'Approved'); assert.equal(result.state.verification.ok, false);
  assert.deepEqual(result.state.evidence.validation.boundaries.map(b => b.stage), ['quote', 'approval']);
  record('changed_price_stopped_before_dispatch', result.state);
});

test('uncertain response pauses and reconciliation verifies existing order without another dispatch', async () => {
  const post = await client(), q = await prepare(post, 'uncertain'); await approve(post, q);
  const uncertain = await post('execute'); assert.equal(uncertain.status, 409); assert.equal(uncertain.code, 'needs_reconciliation');
  assert.equal(uncertain.state.phase, 'needs_reconciliation'); assert.equal(uncertain.state.execution.dispatchCount, 1);
  assert.equal(uncertain.state.chain.accountState.campaign.status, 'PaymentAttempted');
  record('uncertain_response_stopped', uncertain.state);
  const replacement = await post('prepare', { scenario: 'happy' }); assert.equal(replacement.status, 409); assert.equal(replacement.code, 'reconcile_existing_run_first');
  assert.equal(replacement.state.runId, q.runId);
  const reconciled = await post('reconcile'); assert.equal(reconciled.status, 200, JSON.stringify(reconciled));
  assert.equal(reconciled.state.phase, 'completed'); assert.equal(reconciled.state.execution.dispatchCount, 1); assert.equal(reconciled.state.verification.ok, true);
  record('existing_order_reconciled', reconciled.state);
});

test('a forged UI approval flag cannot substitute for a signed confirmed mandate', async () => {
  const post = await client(), q = await prepare(post); app.runs.get(q.runId).state.authorization.confirmed = true;
  const result = await post('execute'); assert.equal(result.status, 409); assert.equal(result.code, 'confirmed_mandate_required');
  assert.equal(result.state.execution.dispatchCount, 0); assert.equal(result.state.chain.accountState.mandate, null);
  record('ui_flag_without_chain_rejected', result.state);
});

test('concurrent execute requests create one fixture order and the other is rejected on chain', async () => {
  const post = await client(), q = await prepare(post); await approve(post, q);
  const results = await Promise.all([post('execute'), post('execute')]); assert.deepEqual(results.map(r => r.status).sort(), [200, 409]);
  const last = results.find(r => r.status === 409); assert.equal(last.code, 'replay_rejected_by_program'); assert.equal(last.state.execution.dispatchCount, 1);
  record('concurrent_execution_one_order', last.state);
});

test('merchant direct submission has no permit before local chain consumption', async () => {
  const post = await client(), q = await prepare(post);
  const response = await fetch(`${app.url}/merchant/${q.runId}/order`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'attemptId=forged' });
  assert.equal(response.status, 403); assert.equal(app.runs.get(q.runId).fixture.dispatchCount, 0);
});

test('missing approval evidence prevents an otherwise authorized execution', async () => {
  const post = await client(), q = await prepare(post), run = app.runs.get(q.runId);
  const capture = run.browser.capture;
  run.browser.capture = async (...args) => { if (args[0] === 'approval') throw new Error('injected_approval_evidence_failure'); return capture(...args); };
  const approved = await post('approve', { termsHash: q.quote.termsHash }); assert.equal(approved.status, 500);
  assert.equal(approved.state.chain.accountState.mandate.status, 'Active');
  const execution = await post('execute'); assert.equal(execution.status, 409); assert.equal(execution.code, 'approval_evidence_incomplete');
  assert.equal(run.fixture.dispatchCount, 0); record('missing_approval_evidence_blocks_execution', execution.state);
});

test('reconciliation recovers evidence after chain confirmation without another chain write or merchant order', async () => {
  const post = await client(), q = await prepare(post), run = app.runs.get(q.runId); await approve(post, q);
  const capture = run.browser.capture; let fail = true;
  run.browser.capture = async (...args) => { if (args[0] === 'confirmation' && fail) { fail = false; throw new Error('injected_confirmation_evidence_failure'); } return capture(...args); };
  const executed = await post('execute'); assert.equal(executed.status, 500); assert.equal(executed.state.phase, 'needs_reconciliation');
  assert.equal(executed.state.chain.accountState.campaign.status, 'Purchased'); const count = executed.state.chain.transactions.length;
  const recovered = await post('reconcile'); assert.equal(recovered.status, 200, JSON.stringify(recovered));
  assert.equal(recovered.state.execution.dispatchCount, 1); assert.equal(recovered.state.chain.transactions.length, count);
  assert.equal(recovered.state.evidence.validation.valid, true); assert.equal(recovered.state.evidence.validation.confirmedOrders, 1);
  record('confirmation_evidence_recovered_without_reexecution', recovered.state);
});

test('lost chain attempt response retains identity and stops before merchant dispatch or another attempt', async () => {
  const post = await client(), q = await prepare(post), run = app.runs.get(q.runId); await approve(post, q);
  const request = run.chain.request.bind(run.chain); let injected = false;
  run.chain.request = async payload => { const result = await request(payload); if (payload.op === 'attempt' && !injected) { injected = true; throw new Error('injected_response_loss_after_consumption'); } return result; };
  const uncertain = await post('execute'); assert.equal(uncertain.status, 409); assert.equal(uncertain.state.phase, 'needs_reconciliation');
  assert.ok(uncertain.state.execution.attemptId); assert.equal(uncertain.state.authorization.status, 'Unknown — reconcile');
  const durable = JSON.parse(await readFile(join(directory, q.runId, 'receipt.json'))); assert.equal(durable.execution.attemptId, uncertain.state.execution.attemptId);
  const repeat = await post('execute'); assert.equal(repeat.code, 'chain_outcome_requires_reconciliation'); assert.equal(run.fixture.dispatchCount, 0);
  const reconciled = await post('reconcile'); assert.equal(reconciled.code, 'no_matching_order'); assert.equal(reconciled.state.authorization.status, 'Consumed');
  assert.equal(reconciled.state.chain.accountState.campaign.status, 'PaymentAttempted'); record('chain_response_loss_stops_for_operator', reconciled.state);
});

test('independent verifier rejects changed identity, currency, amount and missing ledger order', () => {
  const fixture = new MerchantFixture('test', 'happy'), expected = fixture.quote(); fixture.permitAttempt('attempt', expected); const { order } = fixture.submit('attempt');
  assert.equal(verifyOrder({ expected, attemptId: 'attempt', observed: order, ledgerOrder: order }).ok, true);
  for (const field of ['merchantId', 'itemId', 'variant', 'quantity', 'recipientId', 'totalMinor', 'currency', 'orderId', 'attemptId', 'status']) {
    assert.equal(verifyOrder({ expected, attemptId: 'attempt', observed: { ...order, [field]: 'wrong' }, ledgerOrder: order }).ok, false, field);
  }
  assert.equal(verifyOrder({ expected, attemptId: 'attempt', observed: order, ledgerOrder: null }).ok, false);
});
