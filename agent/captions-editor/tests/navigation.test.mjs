import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { AutomationBridge, digest } from '../src/automation.mjs';

const rootUrl = 'https://captions.ai/projects/ownedProject123';
const videoUrl = rootUrl + '/videos/ownedVideo123';
async function fixture(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'captions-navigation-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const asset = { id: 'clip', file: 'clip.mp4', sha256: digest('approved fixture') };
  const step = { id: 'render', operation: 'click', controls: [{ role: 'button', name: 'Create project' }], verifyText: 'Home', mayNavigate: true };
  const job = { id: 'proof', assetId: 'clip', prompt: 'Test prompt', startUrl: rootUrl, steps: [step] };
  const manifest = { version: 1, assets: [asset], jobs: [job] };
  const snapshot = { url: rootUrl, elements: [{ ref: 'e1', role: 'button', name: 'Create project' }] };
  const calls = [];
  const client = { async call(name) { calls.push(name); return { structuredContent: name === 'browser_snapshot' ? structuredClone(snapshot) : {} }; } };
  const bridge = new AutomationBridge({ client, stateDir: dir, manifestLoader: async () => manifest }); await bridge.initialize();
  const observed = await bridge.observe();
  const action = await bridge.act({ jobId: 'proof', idempotencyKey: 'render-01', observationToken: observed.observationToken, ref: 'e1' });
  assert.equal(action.outcome, 'verified_postcondition');
  snapshot.url = videoUrl;
  const request = { jobId: 'proof', idempotencyKey: 'render-01', reviewed: true };
  return { bridge, calls, snapshot, job, request, action };
}

test('delayed child-video navigation binds read-only, preserves receipt and step count, and resumes', async t => {
  const { bridge, calls, request, action } = await fixture(t);
  const before = calls.length;
  const result = await bridge.reconcileNavigation(request);
  assert.equal(result.outcome, 'observed_delayed_navigation');
  assert.deepEqual(calls.slice(before), ['browser_snapshot']);
  const state = await bridge.state('proof');
  assert.equal(state.boundUrl, videoUrl); assert.equal(state.nextStep, 1);
  assert.deepEqual(state.receipts['render-01'], action);
  assert.equal(await bridge.resumeUrl('proof'), videoUrl);
  assert.equal((await bridge.reconcileNavigation(request)).replayed, true);
  assert.equal(calls.filter(x => x === 'browser_click').length, 1);
});

test('reconciliation refuses unrelated projects, origins, root pages and modified URLs', async t => {
  const { bridge, snapshot, request } = await fixture(t);
  for (const url of [rootUrl, videoUrl + '?admin=1', videoUrl + '#section', videoUrl.replace('ownedProject123', 'otherProject123'), videoUrl.replace('https:', 'http:'), videoUrl.replace('captions.ai', 'example.com'), rootUrl + '/videos/a']) {
    snapshot.url = url;
    await assert.rejects(bridge.reconcileNavigation(request), /navigation_not_same_project_video/);
    assert.equal((await bridge.state('proof')).boundUrl, rootUrl);
  }
});

test('only the latest immutable verified mayNavigate action authorizes delayed binding', async t => {
  const { bridge, job, request } = await fixture(t);
  await assert.rejects(bridge.reconcileNavigation({ ...request, reviewed: false }), /explicit_review_required/);
  await assert.rejects(bridge.reconcileNavigation({ ...request, url: videoUrl }), /unexpected_field/);
  await assert.rejects(bridge.reconcileNavigation({ ...request, idempotencyKey: 'other' }), /requires_latest_verified_navigation/);
  job.steps[0].mayNavigate = false;
  await assert.rejects(bridge.reconcileNavigation(request), /completed_step_changed/);
  job.steps[0].mayNavigate = true;
  const state = await bridge.state('proof'); state.receipts['render-01'].outcome = 'uncertain'; await bridge.save(state);
  await assert.rejects(bridge.reconcileNavigation(request), /requires_latest_verified_navigation/);
});

test('a later verified step prevents an older navigation receipt from rebinding', async t => {
  const { bridge, job, request } = await fixture(t);
  const later = { id: 'later', operation: 'click', controls: [{ role: 'button', name: 'Preview' }], verifyText: 'Preview' };
  job.steps.push(later);
  const state = await bridge.state('proof'); state.nextStep = 2; state.completedSteps.push(digest(later)); await bridge.save(state);
  await assert.rejects(bridge.reconcileNavigation(request), /requires_latest_verified_navigation/);
});
