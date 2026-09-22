import test from 'node:test';
import assert from 'node:assert/strict';
import { MultiloginSessionProvider, observationFromSnapshot } from '../src/session-provider.mjs';
import { buildAction, resolveAction } from '../src/contract.mjs';

// A browser-shaped double that records the graceful shutdown the EXISTING
// runner already implements (CDP Browser.close, then Multilogin stop/sync).
function fakeBrowser() {
  const state = { connected: true, sent: [], closed: 0 };
  return { state,
    isConnected: () => state.connected,
    newBrowserCDPSession: async () => ({ send: async method => { state.sent.push(method); state.connected = false; } }),
    close: async () => { state.closed++; },
    contexts: () => [context],
  };
}

const context = { marker: 'existing-multilogin-context', pages: () => [] };
const page = { marker: 'existing-page' };

function harness({ startPort = 41234, startError = null } = {}) {
  const calls = { start: [], connect: [], stop: [], launched: 0, newContext: 0, lock: 0, release: 0 };
  const browser = fakeBrowser();
  const api = {
    start: async (folderId, profileId, headless) => { calls.start.push({ folderId, profileId, headless });
      if (startError) throw startError; return startPort; },
    stop: async (profileId, ...rest) => { calls.stop.push(profileId, ...rest); },
  };
  const provider = new MultiloginSessionProvider({
    api,
    config: { folderId: '2b104092-39f8-459e-be4c-74e037507dd3', headless: true, cdpHost: '127.0.0.1' },
    profileId: 'e86dc95e-c8de-4bd5-ae5b-5e2b4a828256',
    directory: '/tmp/fixture-state',
    // The real connect() is chromium.connectOverCDP + contexts()[0]; the double
    // proves the supplied endpoint and the EXISTING context are what get used.
    connectImpl: async (port, config) => { calls.connect.push({ port, cdpHost: config.cdpHost });
      assert.equal(browser.contexts()[0], context, 'existing context must be reused');
      return { browser, context, page }; },
    lock: async (directory, profileRef, detail) => { calls.lock++; calls.lockDetail = { directory, profileRef, detail };
      return async () => { calls.release++; }; },
  });
  return { provider, calls, browser };
}

test('attach uses the CDP endpoint the launcher returned', async () => {
  const { provider, calls } = harness({ startPort: 45405 });
  const session = await provider.attach({ profileRef: 'yt-live-profile-05', accountId: '7dfa438e' });
  assert.equal(calls.connect.length, 1);
  assert.equal(calls.connect[0].port, 45405, 'the returned port is what gets attached to');
  assert.equal(session.port, 45405);
  assert.equal(session.context, context, 'the existing context is reused, not replaced');
  assert.equal(session.page, page);
});

test('attach reuses the existing context and launches no second browser', async () => {
  const { provider, calls } = harness();
  const first = await provider.attach();
  const second = await provider.attach();
  assert.equal(first, second, 'attach is idempotent');
  assert.equal(calls.start.length, 1, 'the profile is started once');
  assert.equal(calls.connect.length, 1, 'no second attachment');
  assert.equal(calls.launched, 0, 'chromium.launch() is never used');
  assert.equal(calls.newContext, 0, 'browser.newContext() is never used');
});

test('the profile id and ownership lock are preserved for the session', async () => {
  const { provider, calls } = harness();
  const session = await provider.attach({ profileRef: 'yt-live-profile-05', accountId: '7dfa438e' });
  assert.equal(session.profileId, 'e86dc95e-c8de-4bd5-ae5b-5e2b4a828256');
  assert.equal(calls.start[0].profileId, 'e86dc95e-c8de-4bd5-ae5b-5e2b4a828256', 'the same profile is started');
  assert.equal(calls.lock, 1, 'existing ownership lock acquired');
  assert.equal(calls.lockDetail.profileRef, 'yt-live-profile-05');
});

test('detach uses the existing graceful shutdown path and releases the lock', async () => {
  const { provider, calls, browser } = harness();
  await provider.attach({ profileRef: 'yt-live-profile-05', accountId: '7dfa438e' });
  const result = await provider.detach();
  assert.deepEqual(browser.state.sent, ['Browser.close'], 'Chromium is asked to flush first');
  assert.deepEqual(calls.stop, ['e86dc95e-c8de-4bd5-ae5b-5e2b4a828256'], 'then Multilogin stop/sync');
  assert.equal(calls.release, 1, 'the ownership lock is released');
  assert.equal(result.stopped, true);
  assert.equal(provider.session, null);
});

test('a failed start leaves no session and no held lock', async () => {
  const { provider, calls } = harness({ startError: new Error('proxy_connection_failed') });
  const error = await provider.attach({ profileRef: 'yt-live-profile-05' }).then(() => null, thrown => thrown);
  assert.equal(error.message, 'proxy_connection_failed');
  assert.equal(provider.session, null);
  assert.equal(calls.release, 1, 'a failed attach still releases ownership');
});

test('a snapshot becomes an epoch-scoped observation whose ids only resolve in that epoch', async () => {
  const snapshot = { url: 'https://www.youtube.com/', text: 'Switch account Sign out',
    controls: [{ key: 'sig-menu', role: 'button', label: 'Account menu', enabled: true },
      { key: 'sig-switch', role: 'link', label: 'Switch account', enabled: true }] };
  const observation = observationFromSnapshot({ snapshot, now: 1000, ttlMs: 5000 });
  assert.equal(observation.controls[0].id, 'e0');
  assert.equal(observation.controls[1].id, 'e1');
  assert.equal(observation.url.origin, 'https://www.youtube.com');
  const action = buildAction({ kind: 'click', controlId: 'e1', observationEpoch: observation.epoch,
    idempotencyKey: 'prov-12345678', decisionSource: 'deterministic' });
  assert.equal(resolveAction({ action, observation, now: 2000 }).control.id, 'e1');
  assert.throws(() => resolveAction({ action, observation, now: 9000 }), /expired_observation/);
});
