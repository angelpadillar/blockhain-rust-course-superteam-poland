import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { AutomationBridge, digest, validateManifest } from '../src/automation.mjs';
import { createJev } from '../src/jev.mjs';

const page = { url: 'https://captions.ai/home', title: 'Test project', elements: [{ ref: 'e1', role: 'file', name: 'Test clip', input_type: 'file' }, { ref: 'e2', role: 'link', name: 'Export fixture copy' }] };
function manifest(bytes = Buffer.from('fixture')) {
  return { version: 1, assets: [{ id: 'source', file: 'clip.mp4', sha256: digest(bytes) }], jobs: [{ id: 'proof', assetId: 'source', prompt: 'Keep the original voice.', startUrl: page.url, steps: [{ id: 'upload', operation: 'upload', controls: [{ role: 'file', name: 'Test clip' }], verifyText: 'Selected clip.mp4' }] }] };
}
async function setup(t, change = () => {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'captions-bridge-')); t.after(() => rm(root, { recursive: true, force: true }));
  const assets = path.join(root, 'assets'); await mkdir(assets); await writeFile(path.join(assets, 'clip.mp4'), 'fixture');
  const policy = manifest(); change(policy); const calls = []; let snapshot = structuredClone(page);
  const client = { async call(name, args) { calls.push({ name, args }); if (name === 'browser_snapshot') return { content: [{ type: 'text', text: JSON.stringify(snapshot) }] }; return { structuredContent: {} }; } };
  const bridge = new AutomationBridge({ client, stateDir: root, assetsDir: assets, manifestLoader: async () => policy }); await bridge.initialize();
  return { root, assets, policy, calls, bridge, client, setSnapshot(value) { snapshot = value; } };
}
test('approved upload uses only hash-checked jailed file and durable duplicate requests do not upload again', async t => {
  const { bridge, calls, root } = await setup(t); const observation = await bridge.observe();
  const request = { jobId: 'proof', idempotencyKey: 'one', observationToken: observation.observationToken, ref: 'e1' };
  const result = await bridge.act(request); assert.equal(result.outcome, 'verified_postcondition');
  const upload = calls.find(call => call.name === 'browser_upload_file'); assert(upload.args.paths[0].startsWith(path.join(root, 'inputs')));
  const second = await bridge.act(request); assert.equal(second.replayed, true);
  assert.equal(calls.filter(call => call.name === 'browser_upload_file').length, 1);
  const log = await readFile(path.join(root, 'automation/events.jsonl'), 'utf8'); assert(!log.includes('Keep the original voice')); assert(log.includes('actionMs'));
});
test('changed page never receives the action and fresh upstream refs are required', async t => {
  const fixture = await setup(t); const observation = await fixture.bridge.observe();
  fixture.setSnapshot({ ...page, elements: [{ ref: 'e1', role: 'button', name: 'Purchase credits' }] });
  const result = await fixture.bridge.act({ jobId: 'proof', idempotencyKey: 'one', observationToken: observation.observationToken, ref: 'e1' });
  assert.equal(result.reason, 'page_changed'); assert.equal(result.outcome, 'blocked');
  assert(!fixture.calls.some(call => call.name === 'browser_upload_file'));
});
test('asset hash change blocks upload before invoking the browser', async t => {
  const { bridge, calls, assets } = await setup(t); const observation = await bridge.observe();
  await writeFile(path.join(assets, 'clip.mp4'), 'replaced content');
  const result = await bridge.act({ jobId: 'proof', idempotencyKey: 'one', observationToken: observation.observationToken, ref: 'e1' });
  assert.equal(result.reason, 'asset_hash_mismatch'); assert(!calls.some(call => call.name === 'browser_upload_file'));
});
test('requests cannot smuggle a new prompt, path, selector, URL, or JavaScript', async t => {
  const { bridge } = await setup(t); const observation = await bridge.observe();
  for (const key of ['prompt', 'path', 'selector', 'url', 'script']) await assert.rejects(bridge.act({ jobId: 'proof', idempotencyKey: 'one', observationToken: observation.observationToken, ref: 'e1', [key]: 'anything' }), /unexpected_field/);
});
test('policy rejects account, publishing and purchase controls even if configured by mistake', () => {
  for (const name of ['Purchase credits', 'Sign in with Google', 'Delete project', 'Publish to TikTok', 'Account settings', 'Upgrade']) {
    const input = manifest(); input.jobs[0].steps[0].controls[0].name = name; assert.throws(() => validateManifest(input), /forbidden_control/);
  }
  const input = manifest(); input.assets[0].file = '../private.mp4'; assert.throws(() => validateManifest(input), /invalid_asset_file/);
});
test('an uncertain browser operation cannot be automatically repeated under a new idempotency key', async t => {
  const { bridge, client } = await setup(t); const original = client.call;
  client.call = async (name, args) => { if (name === 'browser_upload_file') throw new Error('connection lost'); return original(name, args); };
  const observation = await bridge.observe(); const request = { jobId: 'proof', idempotencyKey: 'one', observationToken: observation.observationToken, ref: 'e1' };
  assert.equal((await bridge.act(request)).outcome, 'uncertain');
  await assert.rejects(bridge.act({ ...request, idempotencyKey: 'two' }), /previous_action_needs_attention/);
});
test('a unique exact match is selected without spending a TypeSafe call', async t => {
  const { bridge } = await setup(t); bridge.chooser = () => { throw new Error('must not call'); };
  const observation = await bridge.observe(); const selected = await bridge.select({ jobId: 'proof', observationToken: observation.observationToken });
  assert.equal(selected.ref, 'e1'); assert.equal(selected.selectionMethod, 'exact-single-match');
});
test('readiness waits for delayed controls with one owner and no model calls or actions', async t => {
  const fixture = await setup(t);
  fixture.bridge.chooser = () => { throw new Error('must not call'); };
  fixture.setSnapshot({ ...page, elements: [{ ...page.elements[0], disabled: true }] });
  const pending = fixture.bridge.selectReady({ jobId: 'proof', waitMs: 1000 });
  await assert.rejects(fixture.bridge.observe(), /browser_busy/);
  setTimeout(() => fixture.setSnapshot(page), 100);
  const selected = await pending;
  assert.equal(selected.ref, 'e1'); assert.equal(selected.selectionMethod, 'exact-single-match');
  assert(selected.observations >= 2);
  assert(fixture.calls.every(call => call.name === 'browser_snapshot'));
  assert.equal(fixture.bridge.busy, false);
});
test('readiness timeout discards observation and does not perform any browser mutation', async t => {
  const fixture = await setup(t); fixture.setSnapshot({ ...page, elements: [] });
  await assert.rejects(fixture.bridge.selectReady({ jobId: 'proof', waitMs: 0 }), /control_readiness_timeout/);
  assert.equal(fixture.bridge.latest, null); assert.equal(fixture.bridge.busy, false);
  assert(fixture.calls.every(call => call.name === 'browser_snapshot'));
  await assert.rejects(fixture.bridge.selectReady({ jobId: 'proof', waitMs: 10001 }), /invalid_readiness_wait/);
});
test('readiness rejects navigation and does not retry driver failure', async t => {
  const fixture = await setup(t); fixture.setSnapshot({ ...page, url: 'https://example.com/' });
  await assert.rejects(fixture.bridge.selectReady({ jobId: 'proof' }), /wrong_origin/);
  let calls = 0; fixture.client.call = async () => { calls++; throw new Error('driver failed'); };
  await assert.rejects(fixture.bridge.selectReady({ jobId: 'proof' }), /driver failed/);
  assert.equal(calls, 1); assert.equal(fixture.bridge.busy, false);
});
test('readiness refuses an uncertain prior action before observing or calling Jev', async t => {
  const fixture = await setup(t);
  await fixture.bridge.save({ id: 'proof', nextStep: 0, completedSteps: [], attempts: {}, status: 'needs_attention', receipts: { old: { outcome: 'uncertain' } } });
  await assert.rejects(fixture.bridge.selectReady({ jobId: 'proof' }), /previous_action_needs_attention/);
  assert.equal(fixture.calls.length, 0);
});
test('TypeSafe probability maps are validated and missing optional AbortSignal is safe', async () => {
  const state = { requestedStep: 'test', candidates: [{ id: 'c0', operation: 'click', label: 'Add style' }] };
  const good = { answers: { action: { type: 'choice', choice: 'c0', confidence: 0.9, probabilities: { c0: 0.9, none: 0.1 } } }, usage: { input_tokens: 20, output_tokens: 3 } };
  let calls = 0; const chooser = createJev({ apiKey: 'fixture-only', fetchImpl: async () => { calls++; return { ok: true, json: async () => good }; } });
  assert.equal((await chooser(state)).choice, 'c0'); assert.equal(calls, 1);
  good.answers.action.probabilities = { c0: 0.9, invented: 0.1 };
  await assert.rejects(chooser(state), /Invalid TypeSafe probabilities/);
  await assert.rejects(chooser({ candidates: [{ id: 'c0' }, { id: 'c0' }] }), /Invalid TypeSafe candidates/);
});
test('upload buttons are rejected and disabled controls are never selected', async t => {
  const invalid = manifest(); invalid.jobs[0].steps[0].controls[0].role = 'button';
  assert.throws(() => validateManifest(invalid), /upload_requires_file_input/);
  const fixture = await setup(t); fixture.setSnapshot({ ...page, elements: [{ ...page.elements[0], disabled: true }] });
  const observation = await fixture.bridge.observe();
  await assert.rejects(fixture.bridge.select({ jobId: 'proof', observationToken: observation.observationToken }), /no_permitted_observed_control/);
});
test('checkbox state drift blocks the click and successful uncheck requires actual checked=false', async t => {
  const fixture = await setup(t, policy => { policy.jobs[0].steps[0] = { id: 'media-off', operation: 'uncheck', controls: [{ role: 'checkbox', name: 'Generate media' }], verifyText: 'Media disabled' }; });
  const box = { ref: 'e1', role: 'checkbox', name: 'Generate media', input_type: 'checkbox', checked: true };
  fixture.setSnapshot({ ...page, elements: [box] }); const observation = await fixture.bridge.observe();
  fixture.setSnapshot({ ...page, elements: [{ ...box, checked: false }] });
  const blocked = await fixture.bridge.act({ jobId: 'proof', idempotencyKey: 'changed', observationToken: observation.observationToken, ref: 'e1' });
  assert.equal(blocked.reason, 'page_changed'); assert(!fixture.calls.some(call => call.name === 'browser_set_checked'));
  fixture.setSnapshot({ ...page, elements: [box] }); const next = await fixture.bridge.observe();
  const result = await fixture.bridge.act({ jobId: 'proof', idempotencyKey: 'stable', observationToken: next.observationToken, ref: 'e1' });
  assert.equal(result.outcome, 'uncertain'); assert.equal(result.reason, 'checkbox_not_off');
});
test('two identically named file inputs are narrowed by exact observed accept and multiple metadata', async t => {
  const fixture = await setup(t, policy => Object.assign(policy.jobs[0].steps[0].controls[0], { accept: 'video/mp4,image/png', multiple: true }));
  fixture.bridge.chooser = () => { throw new Error('an exact match must not spend a model call'); };
  fixture.setSnapshot({ ...page, elements: [{ ...page.elements[0], accept: 'video/mp4,image/png', multiple: true }, { ...page.elements[0], ref: 'e2', accept: 'audio/mp3,video/mp4', multiple: false }] });
  const snapshot = await fixture.bridge.observe(); const selected = await fixture.bridge.select({ jobId: 'proof', observationToken: snapshot.observationToken });
  assert.equal(selected.ref, 'e1'); assert.equal(selected.selectionMethod, 'exact-single-match');
});
test('unnamed switches require exact observed label context and recorded checked state', async t => {
  const fixture = await setup(t, policy => { policy.jobs[0].steps[0] = { id: 'media-off', operation: 'uncheck', controls: [{ role: 'switch', name: '', labelContext: 'Generate media' }], verifyText: 'Generate media' }; });
  const toggle = { ref: 'e1', role: 'switch', name: '', label_context: 'Generate media', checked: true };
  fixture.setSnapshot({ ...page, elements: [toggle] });
  const original = fixture.client.call; fixture.client.call = async (name, args) => { if (name === 'browser_click') fixture.setSnapshot({ ...page, elements: [{ ...toggle, checked: false }] }); return original(name, args); };
  const snapshot = await fixture.bridge.observe();
  const result = await fixture.bridge.act({ jobId: 'proof', idempotencyKey: 'off', observationToken: snapshot.observationToken, ref: 'e1' });
  assert.equal(result.outcome, 'verified_postcondition');
  const wrong = structuredClone(fixture.policy); delete wrong.jobs[0].steps[0].controls[0].labelContext;
  assert.throws(() => validateManifest(wrong), /forbidden_control/);
});
test('resume only opens a project recorded by a verified navigation in the same immutable job', async t => {
  const fixture = await setup(t, policy => { policy.jobs[0].steps[0] = { id: 'draft', operation: 'click', controls: [{ role: 'button', name: 'Create test draft' }], verifyText: 'Settings', mayNavigate: true }; });
  const draftUrl = 'https://captions.ai/projects/fixtureProject123';
  fixture.setSnapshot({ ...page, elements: [{ ref: 'e1', role: 'button', name: 'Create test draft' }] });
  const original = fixture.client.call; fixture.client.call = async (name, args) => { if (name === 'browser_click') fixture.setSnapshot({ ...page, url: draftUrl }); return original(name, args); };
  const snapshot = await fixture.bridge.observe();
  assert.equal((await fixture.bridge.act({ jobId: 'proof', idempotencyKey: 'draft', observationToken: snapshot.observationToken, ref: 'e1' })).outcome, 'verified_postcondition');
  assert.equal(await fixture.bridge.resumeUrl('proof'), draftUrl);
  const state = await fixture.bridge.state('proof'); state.boundUrl = 'https://example.com/projects/fixtureProject123'; await fixture.bridge.save(state);
  await assert.rejects(fixture.bridge.resumeUrl('proof'), /resume_requires_recorded_project/);
});
test('a reviewed unchanged switch can recover without rewriting or replaying its uncertain receipt', async t => {
  const fixture = await setup(t, policy => { policy.jobs[0].steps[0] = { id: 'off', operation: 'uncheck', controls: [{ role: 'switch', name: '', labelContext: 'Generate media' }], verifyText: 'Generate media' }; });
  const on = { ref: 'e1', role: 'switch', name: '', label_context: 'Generate media', checked: true }; fixture.setSnapshot({ ...page, elements: [on] });
  const original = fixture.client.call; fixture.client.call = async (name, args) => { if (name === 'browser_click') throw new Error('driver failure'); return original(name, args); };
  const snapshot = await fixture.bridge.observe(); assert.equal((await fixture.bridge.act({ jobId: 'proof', idempotencyKey: 'failed', observationToken: snapshot.observationToken, ref: 'e1' })).outcome, 'uncertain');
  const saved = (await fixture.bridge.state('proof')).receipts.failed;
  await assert.rejects(fixture.bridge.recoverToggle({ jobId: 'proof', idempotencyKey: 'failed' }), /explicit_review_required/);
  const count = fixture.calls.length;
  const recovered = await fixture.bridge.recoverToggle({ jobId: 'proof', idempotencyKey: 'failed', reviewed: true });
  assert.equal(recovered.newAttemptAuthorized, true); assert.deepEqual((await fixture.bridge.state('proof')).receipts.failed, saved);
  assert(fixture.calls.slice(count).every(call => call.name === 'browser_snapshot'));
  fixture.client.call = async (name, args) => { if (name === 'browser_click') fixture.setSnapshot({ ...page, elements: [{ ...on, checked: false }] }); return original(name, args); };
  const fresh = await fixture.bridge.observe();
  assert.equal((await fixture.bridge.act({ jobId: 'proof', idempotencyKey: 'fixed', observationToken: fresh.observationToken, ref: 'e1' })).outcome, 'verified_postcondition');
});
test('a switch already off is verified without toggling it back on', async t => {
  const fixture = await setup(t, policy => { policy.jobs[0].steps[0] = { id: 'off', operation: 'uncheck', controls: [{ role: 'switch', name: 'Generate media' }], verifyText: 'Generate media' }; });
  fixture.setSnapshot({ ...page, elements: [{ ref: 'e1', role: 'switch', name: 'Generate media', checked: false }] });
  const snapshot = await fixture.bridge.observe(); const result = await fixture.bridge.act({ jobId: 'proof', idempotencyKey: 'off', observationToken: snapshot.observationToken, ref: 'e1' });
  assert.equal(result.outcome, 'verified_postcondition'); assert.equal(result.actionMethod, 'already-off');
  assert(!fixture.calls.some(call => ['browser_click', 'browser_set_checked'].includes(call.name)));
});
