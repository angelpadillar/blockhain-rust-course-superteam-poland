import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { AutomationBridge, digest, validateManifest } from '../src/automation.mjs';

const page = { url: 'https://captions.ai/home', elements: [{ ref: 'e1', role: 'button', name: 'Create test edit' }] };
function deferred() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }
async function setup(t, operation = 'click') {
  const root = await mkdtemp(path.join(os.tmpdir(), 'captions-reconcile-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const manifest = { version: 1, assets: [{ id: 'source', file: 'source.mp4', sha256: digest('fixture') }], jobs: [{ id: 'proof', assetId: 'source', prompt: 'Fixture prompt', startUrl: page.url, steps: [{ id: 'edit', operation, controls: [{ role: 'button', name: 'Create test edit' }], verifyText: 'New test edit ready', verifyTimeoutMs: 45000 }] }] };
  const calls = []; const controls = { waitFails: true, snapshot: structuredClone(page) };
  const client = { async call(name, args) {
    calls.push({ name, args });
    if (name === 'browser_snapshot') return { structuredContent: structuredClone(controls.snapshot) };
    if (name === 'browser_wait_for' && controls.waitFails) throw new Error('postcondition timeout');
    if (name === 'browser_download') {
      await mkdir(path.dirname(args.path), { recursive: true }); await writeFile(args.path, 'download fixture, not real media');
      throw new Error('response lost after successful download');
    }
    return { structuredContent: {} };
  } };
  const bridge = new AutomationBridge({ client, stateDir: root, manifestLoader: async () => manifest }); await bridge.initialize();
  const observe = () => bridge.observe();
  const act = async () => {
    const observation = await observe();
    return bridge.act({ jobId: 'proof', idempotencyKey: 'first', observationToken: observation.observationToken, ref: 'e1' });
  };
  return { root, manifest, client, bridge, calls, controls, act };
}

test('verification timeout is bounded and passed to the real wait tool', async t => {
  const { manifest, act, calls } = await setup(t);
  assert.equal((await act()).outcome, 'uncertain');
  assert.equal(calls.find(c => c.name === 'browser_wait_for').args.timeout_ms, 45000);
  for (const bad of [0, 999, 60001, 1.5, '45000']) {
    const copy = structuredClone(manifest); copy.jobs[0].steps[0].verifyTimeoutMs = bad;
    assert.throws(() => validateManifest(copy), /invalid_verify_timeout/);
  }
});

test('reviewed reconciliation observes completion, advances once, and never repeats a click', async t => {
  const { bridge, act, controls, calls } = await setup(t);
  assert.equal((await act()).outcome, 'uncertain');
  await assert.rejects(bridge.reconcile({ jobId: 'proof', idempotencyKey: 'first' }), /explicit_review_required/);
  controls.waitFails = false;
  const result = await bridge.reconcile({ jobId: 'proof', idempotencyKey: 'first', reviewed: true });
  assert.equal(result.outcome, 'verified_postcondition'); assert.equal(result.reconciled, true);
  assert.equal((await bridge.state('proof')).nextStep, 1);
  assert.equal((await bridge.reconcile({ jobId: 'proof', idempotencyKey: 'first', reviewed: true })).replayed, true);
  assert.equal((await bridge.state('proof')).nextStep, 1);
  assert.equal(calls.filter(c => c.name === 'browser_click').length, 1);
});

test('failed read-only reconciliation preserves uncertainty and blocks a new mutation', async t => {
  const { bridge, act, calls } = await setup(t);
  await act();
  const result = await bridge.reconcile({ jobId: 'proof', idempotencyKey: 'first', reviewed: true });
  assert.equal(result.outcome, 'unconfirmed');
  const state = await bridge.state('proof'); assert.equal(state.nextStep, 0); assert.equal(state.receipts.first.outcome, 'uncertain');
  const observed = await bridge.observe();
  await assert.rejects(bridge.act({ jobId: 'proof', idempotencyKey: 'second', observationToken: observed.observationToken, ref: 'e1' }), /previous_action_needs_attention/);
  assert.equal(calls.filter(c => c.name === 'browser_click').length, 1);
});

test('uncertain step policy cannot be changed into an easier postcondition', async t => {
  const { bridge, act, manifest } = await setup(t); await act();
  manifest.jobs[0].steps[0].verifyText = 'Already visible text';
  await assert.rejects(bridge.reconcile({ jobId: 'proof', idempotencyKey: 'first', reviewed: true }), /uncertain_step_changed/);
  assert.equal((await bridge.state('proof')).nextStep, 0);
});

test('wrong project evidence cannot reconcile a completed action', async t => {
  const { bridge, act, controls } = await setup(t); await act(); controls.waitFails = false;
  controls.snapshot.url = 'https://captions.ai/projects/unrelated';
  const result = await bridge.reconcile({ jobId: 'proof', idempotencyKey: 'first', reviewed: true });
  assert.equal(result.reason, 'wrong_project_page'); assert.equal((await bridge.state('proof')).nextStep, 0);
});

test('download reconciliation remains exported_unverified and never clicks download again', async t => {
  const { bridge, act, calls } = await setup(t, 'export'); await act();
  const result = await bridge.reconcile({ jobId: 'proof', idempotencyKey: 'first', reviewed: true });
  assert.equal(result.outcome, 'verified_postcondition'); assert.equal((await bridge.state('proof')).status, 'exported_unverified');
  assert.equal(calls.filter(c => c.name === 'browser_download').length, 1);
  assert.ok(result.artifact.endsWith('/exports/proof/export.mp4'));
});

test('an in-flight observation owns the browser until its snapshot completes', async t => {
  const { bridge, client } = await setup(t); const gate = deferred(); const original = client.call;
  client.call = async (name, args) => { if (name === 'browser_snapshot') await gate.promise; return original(name, args); };
  const reading = bridge.observe();
  await assert.rejects(bridge.observe(), /browser_busy/);
  await assert.rejects(bridge.select({ jobId: 'proof', observationToken: 'old' }), /browser_busy/);
  await assert.rejects(bridge.act({ jobId: 'proof', idempotencyKey: 'first', observationToken: 'old', ref: 'e1' }), /browser_busy/);
  await assert.rejects(bridge.cancel('proof'), /browser_busy/);
  gate.resolve(); await reading; assert.equal(bridge.busy, false);
});

test('a pending semantic selection owns the browser and releases it on failure', async t => {
  const { bridge, controls } = await setup(t); controls.snapshot.elements.push({ ...page.elements[0], ref: 'e2' });
  const observed = await bridge.observe(); const gate = deferred(); const entered = deferred();
  bridge.chooser = async () => { entered.resolve(); await gate.promise; throw new Error('model unavailable'); };
  const selecting = bridge.select({ jobId: 'proof', observationToken: observed.observationToken }); await entered.promise;
  await assert.rejects(bridge.observe(), /browser_busy/); gate.resolve();
  await assert.rejects(selecting, /model unavailable/); assert.equal(bridge.busy, false);
});
