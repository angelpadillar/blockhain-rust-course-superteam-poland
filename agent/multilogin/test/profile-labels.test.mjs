import test from 'node:test';
import assert from 'node:assert/strict';
import { renameProfilePreservingConfiguration, applyProfileLabels,
  parametersDigest, proxyShapeOf } from '../src/profile-labels.mjs';

// Safe labeling: the profile name is the only label-like field the API exposes,
// so a rename must carry the profile's own parameters back byte-identically and
// verify afterwards that only the name moved.
function fakeApi({ before, after = null, failUpdate = false } = {}) {
  const calls = { updates: [], metas: 0 };
  let requestedName = null;
  return { calls,
    async profileMeta() { calls.metas++; if (calls.metas === 1) return before;
      return after || { ...before, name: requestedName }; },
    async updateProfile(args) { if (failUpdate) throw new Error('update_failed');
      requestedName = args.name; calls.updates.push(args); } };
}

const parameters = { fingerprint: { navigator: {} }, flags: { proxy_masking: 'custom', canvas_masking: 'real' },
  proxy: { type: 'socks5', host: 'proxy.invalid', port: 1080, username: 'u', password: 'p' }, storage: { is_local: false } };

test('a rename preserves parameters and the proxy exactly and verifies the result', async () => {
  const api = fakeApi({ before: { name: 'old-name', is_auto_update: true, parameters } });
  const result = await renameProfilePreservingConfiguration({ api, profileId: 'profile-00000001',
    name: 'YT-01 | GOOD | Studio verified' });
  assert.equal(result.parametersUnchanged, true);
  assert.equal(result.proxyUnchanged, true);
  assert.equal(api.calls.updates.length, 1);
  assert.equal(api.calls.updates[0].parameters, parameters, 'the same parameters object is sent back');
  assert.equal(api.calls.updates[0].autoUpdateCore, true);
  assert.equal(parametersDigest(api.calls.updates[0].parameters), result.parametersDigest);
});

test('a rename that would move parameters or the proxy is refused', async () => {
  const moved = { ...parameters, flags: { ...parameters.flags, canvas_masking: 'noise' } };
  const api = fakeApi({ before: { name: 'old', is_auto_update: true, parameters },
    after: { name: 'new', parameters: moved } });
  await assert.rejects(renameProfilePreservingConfiguration({ api, profileId: 'profile-00000001',
    name: 'new' }), /profile_parameters_changed/);

  const proxyMoved = { ...parameters, proxy: { ...parameters.proxy, port: 1081 } };
  const proxyApi = fakeApi({ before: { name: 'old', is_auto_update: true, parameters },
    after: { name: 'new', parameters: proxyMoved } });
  await assert.rejects(renameProfilePreservingConfiguration({ api: proxyApi, profileId: 'profile-00000001',
    name: 'new' }), /profile_proxy_changed/);

  const identity = fakeApi({ before: { name: 'same', is_auto_update: true, parameters } });
  await assert.rejects(renameProfilePreservingConfiguration({ api: identity, profileId: 'profile-00000001',
    name: 'same' }), /profile_name_unchanged/);
  assert.equal(identity.calls.updates.length, 0, 'no update is sent when nothing would change');
});

test('applyProfileLabels dry-runs by default and never stops on one failure', async () => {
  const report = { profiles: [
    { accountRef: 'yt-live-01', profileId: 'profile-00000001', label: 'YT-01 | GOOD | Studio verified' },
    { accountRef: 'yt-live-04', profileId: 'profile-00000004', label: 'YT-04 | HUMAN | security verification' },
    { accountRef: 'yt-live-05', profileId: null, label: 'YT-05 | BAD | cancelled / login incomplete' },
  ] };
  const dryApi = fakeApi({ before: { name: 'old', is_auto_update: true, parameters } });
  const dry = await applyProfileLabels({ report, api: dryApi, apply: false });
  assert.deepEqual(dry.results.map(result => result.action), ['would_rename', 'would_rename', 'skipped']);
  assert.equal(dryApi.calls.updates.length, 0);

  let update = 0;
  const names = new Map();
  const api = {
    async profileMeta(profileId) { return { name: names.get(profileId) || 'old', is_auto_update: true, parameters }; },
    async updateProfile({ profileId, name }) {
      if (++update === 1) throw new Error('update_failed');
      names.set(profileId, name);
    } };
  const applied = await applyProfileLabels({ report: { profiles: [
    { accountRef: 'yt-live-04', profileId: 'profile-00000004', label: 'YT-04 | HUMAN | security verification' },
    { accountRef: 'yt-live-01', profileId: 'profile-00000001', label: 'YT-01 | GOOD | Studio verified' },
  ] }, api, apply: true });
  assert.deepEqual(applied.results.map(result => result.action), ['failed', 'renamed']);
  assert.equal(applied.results[1].name, 'YT-01 | GOOD | Studio verified');
});

test('proxy shape comparison ignores credential values but sees port/type/masking changes', () => {
  const base = proxyShapeOf(parameters);
  assert.deepEqual(base, { type: 'socks5', port: 1080, masking: 'custom' });
  assert.deepEqual(proxyShapeOf({ ...parameters, proxy: { ...parameters.proxy, password: 'different' } }), base);
  assert.notDeepEqual(proxyShapeOf({ ...parameters, proxy: { ...parameters.proxy, port: 1081 } }), base);
});
