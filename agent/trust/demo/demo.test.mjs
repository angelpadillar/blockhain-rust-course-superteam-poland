import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDemo, transition, publicState } from './model.mjs';
import { startDemo } from './server.mjs';
const now = 1_000_000;
const ready = scenario => createDemo({ scenario, now, id: scenario });
const approve = state => transition(state, 'approve', { quoteHash: state.quoteHash }, now + 100);

test('happy path binds exact quote and records only a simulated confirmation', () => {
  const initial = ready('happy'), approved = approve(initial);
  assert.equal(initial.approval, null);
  assert.equal(approved.ok, true);
  assert.equal(approved.state.approval.quoteHash, initial.quoteHash);
  const result = transition(approved.state, 'execute', {}, now + 200);
  assert.equal(result.ok, true);
  assert.equal(result.state.confirmation.mode, 'simulated');
  assert.equal(result.state.confirmation.totalMinor, 2990);
  assert.equal(result.state.chain.filter(entry => entry.record.type === 'execution').length, 1);
  assert.equal(publicState(result.state, now + 200).verification.integrityValid, true);
});

for (const [scenario, code] of [['price_increase', 'price_or_quote_changed'], ['merchant_mismatch', 'merchant_or_item_mismatch']]) {
  test(`${scenario} rejects fresh details before any execution`, () => {
    const result = transition(approve(ready(scenario)).state, 'execute', {}, now + 200);
    assert.equal(result.ok, false); assert.equal(result.code, code);
    assert.equal(result.state.execution, null); assert.equal(result.state.confirmation, null);
    assert.equal(publicState(result.state, now + 200).verification.integrityValid, true);
  });
}
test('expired quote rejects approval with no approval or execution record', () => {
  const result = approve(ready('expired'));
  assert.equal(result.code, 'quote_expired'); assert.equal(result.state.approval, null);
  assert.equal(result.state.execution, null);
  assert.equal(publicState(result.state, now + 200).verification.integrityValid, true);
});
test('expiry after approval also stops execution', () => {
  const result = transition(approve(ready('happy')).state, 'execute', {}, now + 600_000);
  assert.equal(result.code, 'quote_expired'); assert.equal(result.state.execution, null);
});
test('a repeated attempt cannot reuse the approval or create a second confirmation', () => {
  const first = transition(approve(ready('replay')).state, 'execute', {}, now + 200);
  const second = transition(first.state, 'execute', {}, now + 300);
  assert.equal(second.code, 'approval_already_consumed');
  assert.equal(second.state.chain.filter(entry => entry.record.type === 'execution').length, 1);
  assert.equal(second.state.chain.filter(entry => entry.record.type === 'confirmation').length, 1);
});
test('wrong hash and execution without approval fail closed', () => {
  assert.equal(transition(ready('happy'), 'approve', { quoteHash: 'f'.repeat(64) }, now + 100).code, 'quote_hash_mismatch');
  assert.equal(transition(ready('happy'), 'execute', {}, now + 100).code, 'approval_required');
});
test('unattached screenshot evidence is explicitly incomplete despite intact records', () => {
  const verification = publicState(ready('happy'), now).verification;
  assert.equal(verification.integrityValid, true);
  assert.equal(verification.boundaryComplete, false);
  assert.equal(verification.valid, false);
  assert.equal(verification.approvalAuthenticated, false);
});
test('rejected attempt requires fresh review', () => {
  const rejected = transition(ready('happy'), 'execute', {}, now + 100);
  const next = transition(rejected.state, 'approve', { quoteHash: rejected.state.quoteHash }, now + 200);
  assert.equal(next.code, 'review_required_after_rejection');
  assert.equal(next.state.approval, null);
});

test('server serializes concurrent executions, persists receipt, and rejects cross-origin mutations', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'buena-trust-demo-'));
  const app = await startDemo({ port: 0, receiptDirectory: directory });
  try {
    const response = await fetch(`${app.url}/api/state`), state = await response.json();
    const cookie = response.headers.get('set-cookie').split(';')[0];
    const post = (path, payload, extra = {}) => fetch(`${app.url}/api/${path}`, { method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json', ...extra }, body: JSON.stringify(payload) });
    assert.equal((await post('approve', { quoteHash: state.quoteHash }, { Origin: 'https://unrelated.invalid' })).status, 403);
    assert.equal((await post('approve', { quoteHash: state.quoteHash })).status, 200);
    const results = await Promise.all([post('execute', {}), post('execute', {})]);
    assert.deepEqual(results.map(result => result.status).sort(), [200, 409]);
    const saved = JSON.parse(await readFile(join(directory, `${state.sessionId}.json`), 'utf8'));
    assert.equal(saved.chain.filter(entry => entry.record.type === 'execution').length, 1);
    assert.equal(saved.chain.at(-1).record.reason, 'approval_already_consumed');
    assert.equal(saved.verification.integrityValid, true);
  } finally { await app.close(); await rm(directory, { recursive: true, force: true }); }
});
