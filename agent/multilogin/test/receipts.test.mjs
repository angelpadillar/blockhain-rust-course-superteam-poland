import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createReceiptStore, receiptJournalName, isInFlight } from '../src/receipts.mjs';
import { buildAction, createReceipt, transitionReceipt } from '../src/contract.mjs';

const action = buildAction({ kind: 'submit', operation: 'submit_login', controlId: 'e2',
  observationEpoch: 'epoch-1', idempotencyKey: 'job-1-step-1-submit_login', decisionSource: 'jev',
  risk: 'authentication' });

async function directory(t) {
  const path = await mkdtemp(join(tmpdir(), 'receipts-'));
  t.after(() => rm(path, { recursive: true, force: true }));
  return path;
}

function receipt(state, { id = 'r1', now = 1000 } = {}) {
  let value = createReceipt({ id, idempotencyKey: action.idempotencyKey, action, now,
    observationFingerprint: 'fp-before', observationUrl: 'https://accounts.google.com/signin',
    scope: { jobId: 'job-1', profileId: 'profile-1' } });
  if (state !== 'created') value = transitionReceipt(value, state);
  return value;
}

test('a receipt survives a restart: the store re-reads the last durable state', async t => {
  const path = await directory(t);
  const store = createReceiptStore({ directory: path });
  await store.write(receipt('created'));
  await store.write(receipt('dispatched'));

  // A new process opens the same journal and sees the same receipt.
  const restarted = createReceiptStore({ directory: path });
  const found = await restarted.find({ idempotencyKey: action.idempotencyKey });
  assert.equal(found.state, 'dispatched', 'the last state written is the state read back');
  assert.equal(found.id, 'r1');
  assert.equal(found.scope.profileId, 'profile-1', 'the receipt names the profile it belongs to');
  assert.equal(found.observationFingerprint, 'fp-before');
  assert.equal(await restarted.privateFile(), true, 'the journal is not world readable');

  const lines = (await readFile(join(path, receiptJournalName), 'utf8')).trim().split('\n');
  assert.equal(lines.length, 2, 'the journal is append-only: nothing is rewritten in place');
  assert.deepEqual(JSON.parse(lines[0]).state, 'created');
  assert.deepEqual(JSON.parse(lines[1]).state, 'dispatched');
});

test('only receipts that may still have an effect in flight are reported', async t => {
  const path = await directory(t);
  const store = createReceiptStore({ directory: path });
  await store.write(receipt('created', { id: 'a' }));
  await store.write(receipt('dispatched', { id: 'b' }));
  // An uncertain effect is still in flight: only a reconciliation resolves it.
  await store.write(transitionReceipt(receipt('dispatched', { id: 'c' }), 'uncertain'));
  await store.write(transitionReceipt(transitionReceipt(receipt('dispatched', { id: 'd' }), 'certain'), 'verified'));

  assert.deepEqual((await store.inFlight()).map(item => item.id).sort(), ['a', 'b', 'c']);
  assert.equal(isInFlight({ state: 'verified' }), false);
  assert.equal(isInFlight({ state: 'failed' }), false);
  assert.equal(isInFlight({ state: 'reconciled_not_occurred' }), false);
});

test('a torn last line is skipped instead of hiding the durable states before it', async t => {
  const path = await directory(t);
  const store = createReceiptStore({ directory: path });
  await store.write(receipt('created'));
  await store.write(receipt('dispatched'));
  // A crash mid-append leaves a partial line.
  const journal = join(path, receiptJournalName);
  const { appendFile } = await import('node:fs/promises');
  await appendFile(journal, '{"id":"r1","state":"dispat', { mode: 0o600 });

  const restarted = createReceiptStore({ directory: path });
  assert.equal((await restarted.find({ id: 'r1' })).state, 'dispatched');
  assert.equal((await restarted.inFlight()).length, 1);
});

test('a store that cannot be written does not lose the receipt in memory', async t => {
  const failing = { write: async () => { throw new Error('disk_full'); } };
  const { BrowserExecutionKernel } = await import('../src/execution.mjs');
  const snapshot = { url: 'https://accounts.google.com/signin', text: 'Sign in', fingerprint: 'fp-1',
    challengeFrame: false, controls: [{ key: 'sig-submit', tag: 'button', type: '', label: 'Next',
      enabled: true }] };
  const kernel = new BrowserExecutionKernel({ account: { platform: 'youtube', username: 'a@b.c' },
    site: { origins: ['https://accounts.google.com'], credentialOrigins: ['https://accounts.google.com'],
      homeUrl: 'https://www.youtube.com/' }, runId: 'receipt-failure', receipts: failing,
    observe: async () => snapshot });
  const outcome = await kernel.execute({ candidate: { kind: 'submit_login', control: snapshot.controls[0] },
    snapshot, observation: kernel.observe(snapshot).observation, source: 'jev', expectedPostcondition: null,
    dispatch: async () => null });
  assert.equal(outcome.receipt.state, 'verified', 'the run still completes');
  assert.deepEqual(kernel.storeFailures, ['receipt_store_unavailable', 'receipt_store_unavailable',
    'receipt_store_unavailable', 'receipt_store_unavailable'], 'every failed write is recorded');
  assert.equal(outcome.receipt.postconditionMet, true);
});
