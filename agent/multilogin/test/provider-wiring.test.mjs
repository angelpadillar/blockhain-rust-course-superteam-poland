import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runJobBatch, validateJobs } from '../src/jobs.mjs';
import { accountsFromRecords } from '../src/accounts.mjs';
import { createGuide } from '../src/jev.mjs';
import { MultiloginSessionProvider } from '../src/session-provider.mjs';
import { writeJson } from '../src/storage.mjs';
import { PilotError } from '../src/core.mjs';

// The production batch/job path must own its profile/session through
// MultiloginSessionProvider: same existing profile, same launcher-returned CDP
// endpoint, same existing context, graceful stop, then lock release. These tests
// drive the REAL runJobBatch and spy on the provider.
const FOLDER = '2b104092-39f8-459e-be4c-74e037507dd3';
const PROFILE = 'e86dc95e-c8de-4bd5-ae5b-5e2b4a828256';
const SECRET = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
const IDENTITY = 'Accounts\nCanary Fixture\ncanary.fixture@gmail.com\nAdd account\nSwitch account\nSign out\nGoogle Account';

// One deterministic action (open the account menu) reveals the identity evidence,
// exactly like the real verified-identity flow.
function stubPage({ authenticated = true } = {}) {
  const state = { url: 'https://accounts.google.com/ServiceLogin?service=youtube', text: 'YouTube home',
    clicks: 0, fills: 0, controls: [{ tag: 'button', type: '', label: 'Account menu', name: 'menu' }] };
  const element = control => ({ tagName: control.tag.toUpperCase(), id: '', innerText: control.label,
    labels: [], disabled: false, readOnly: false, required: false, form: null, href: '',
    getAttribute: name => (name === 'aria-label' ? control.label : name === 'type' ? control.type
      : name === 'name' ? control.name : null), querySelector: () => null });
  return { state,
    url: () => state.url,
    goto: async url => { state.url = url; return { status: () => 200 }; },
    $$: async () => state.controls.map(control => ({
      isVisible: async () => true, isEnabled: async () => true,
      evaluate: async fn => fn(element(control)), dispose: async () => {},
      click: async () => { state.clicks++;
        if (authenticated) { state.url = 'https://www.youtube.com/'; state.text = IDENTITY; } },
      fill: async () => { state.fills++; },
    })),
    locator: () => ({ count: async () => 0, first() { return this; }, innerText: async () => state.text }),
    on: () => {}, off: () => {},
  };
}

async function harness(t, { seedMapping = true, page = stubPage(), attachFails = false } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'provider-wiring-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const account = accountsFromRecords([{ ref: 'yt-live-01', platform: 'youtube',
    username: 'canary.fixture@gmail.com', password: 'rehearsal-only', totp: SECRET, proxyCountry: 'pl' }])
    .get('yt-live-01');
  const context = { id: 'existing-mimic-context', newPage: async () => page, setDefaultTimeout: () => {} };
  const calls = { creates: [], starts: [], stops: [], ports: [], attaches: [], order: [], proxyChanges: 0,
    provider: [], lockSnapshots: [] };
  const browser = { connected: true,
    isConnected: () => browser.connected,
    newBrowserCDPSession: async () => ({ send: async method => {
      calls.order.push(method); browser.connected = false; } }),
    close: async () => { calls.order.push('browser.close'); },
    contexts: () => [context],
  };
  const api = {
    create: async detail => { calls.creates.push(detail?.name || null); return 'created-profile-0001'; },
    start: async (folderId, profileId) => { browser.connected = true; calls.starts.push(profileId);
      const port = 47000 + calls.starts.length; calls.ports.push(port); return port; },
    stop: async profileId => { calls.order.push(`api.stop:${profileId}`); calls.stops.push(profileId); },
    changeProxy: async () => { calls.proxyChanges++; },
    premiumProxy: async () => undefined,
  };
  if (seedMapping) {
    await writeJson(join(directory, 'accounts', account.id, 'profiles.json'), { version: 1, folderId: FOLDER,
      profiles: { [account.id]: { name: 'jev-youtube-existing', platform: 'youtube', characterId: null,
        accountHandle: account.username, setupStatus: 'completed', proxyMode: 'multilogin', proxyCountry: 'pl',
        proxyIndex: 0, osType: 'linux', cloudStorage: true, pending: null, profileId: PROFILE } } });
    await writeJson(join(directory, 'profile-refs.json'), { version: 1, refs: {
      'yt-live-profile-01': { profileId: PROFILE, accountId: account.id, platform: 'youtube',
        createdAt: '2026-09-01T00:00:00.000Z', lastJobId: 'canary-previous' } } });
  }
  // Spy on the provider the job layer constructs.
  const spies = {};
  const record = name => function (...args) {
    calls.provider.push({ name, profileId: this.profileId, profileRef: args[0]?.profileRef ?? null });
    return spies[name].apply(this, args);
  };
  for (const name of ['claimOwnership', 'start', 'connect', 'suspend', 'detach']) {
    spies[name] = MultiloginSessionProvider.prototype[name];
    MultiloginSessionProvider.prototype[name] = record(name);
  }
  spies.bindProfileId = MultiloginSessionProvider.prototype.bindProfileId;
  MultiloginSessionProvider.prototype.bindProfileId = function (...args) {
    calls.provider.push({ name: 'bindProfileId', profileId: args[0] });
    return spies.bindProfileId.apply(this, args);
  };
  t.after(() => {
    for (const name of Object.keys(spies)) MultiloginSessionProvider.prototype[name] = spies[name];
  });
  return { directory, account, calls, browser, context, page, api, attachFails };
}

async function runCanary(input, { seedSites = [], studio = null } = {}) {
  const jobs = validateJobs([{ id: 'yt-live-01-canary', platform: 'youtube',
    accountRef: 'yt-live-01', profileRef: 'yt-live-profile-01' }]);
  const accountIndex = new Map([['yt-live-01', input.account]]);
  return runJobBatch({
    jobs, accountIndex, directory: input.directory, concurrency: 1, api: input.api,
    config: { folderId: FOLDER, cdpHost: '127.0.0.1', osType: 'linux', cloudStorage: true, headless: true,
      verifyRestart: true, proxyMode: 'multilogin', proxyCountry: 'pl', seedSites, maxSteps: 20, maxSeconds: 180,
      humanCheckpointSeconds: 60 },
    guideFactory: () => createGuide({ apiKey: 'offline-wiring', fetchImpl: async () => {
      throw new PilotError('model call attempted on a deterministic path'); } }),
    connectImpl: async (port, config) => {
      if (input.attachFails) throw new PilotError('browser_attachment_failed');
      input.calls.attaches.push({ port, context: input.context, page: input.page });
      return { browser: input.browser, context: input.context, page: input.page };
    },
    seedImpl: async () => [],
    studioImpl: studio || (async () => ({ state: 'studio', authenticated: true,
      url: 'https://studio.youtube.com/', channel: { name: 'Canary Fixture' } })),
    humanCheckpointPollMs: 50,
    onJobState: async () => {
      const entries = await readdir(join(input.directory, 'locks')).catch(() => []);
      input.calls.lockSnapshots.push(entries);
    },
  });
}

test('the batch/job path owns the profile through the provider: same profile, same endpoint, same context', async t => {
  const input = await harness(t);
  const result = await runCanary(input);
  const calls = input.calls;
  const outcome = result.report.accounts[0];
  const summary = result.summary.jobs[0];

  // The job succeeded with deterministic actions only.
  assert.equal(summary.state, 'success');
  assert.equal(outcome.login?.verified, true);
  assert.equal(outcome.reopen?.verified, true, 'the restarted profile still verifies');
  assert.equal(outcome.jev?.calls, 0, 'no model call was needed');
  assert.equal(input.page.state.fills, 0, 'no credential was submitted');

  // The provider WAS the lifecycle: ownership once, two start/attach cycles (the
  // login and the restart verification), a graceful stop each time, then release.
  const lifecycle = calls.provider.filter(entry => entry.name !== 'bindProfileId').map(entry => entry.name);
  assert.deepEqual(lifecycle, ['claimOwnership', 'start', 'connect', 'suspend', 'start', 'connect', 'suspend',
    'detach', 'suspend'], 'the trailing suspend is detach() finding the profile already stopped');
  const ownership = calls.provider.find(entry => entry.name === 'claimOwnership');
  assert.equal(ownership.profileRef, 'yt-live-profile-01', 'ownership is keyed by the profile reference');
  assert.equal(calls.provider.findIndex(entry => entry.name === 'claimOwnership')
    < calls.provider.findIndex(entry => entry.name === 'start'), true, 'ownership is taken before the start');
  // The job layer binds the mapped id early; the record layer binds the resolved id.
  assert.deepEqual(calls.provider.filter(entry => entry.name === 'bindProfileId').map(entry => entry.profileId),
    [PROFILE, PROFILE], 'the provider wraps the SAME existing profile the mapping names');
  assert.equal(calls.provider.filter(entry => entry.name === 'claimOwnership').length, 1, 'never two locks');

  // Same profile, same launcher-returned endpoints, same existing context.
  assert.deepEqual(calls.starts, [PROFILE, PROFILE], 'the SAME profile is started twice, never another');
  assert.equal(calls.attaches.length, 2, 'two CDP attachments, one per start');
  assert.deepEqual(calls.attaches.map(entry => entry.port), calls.ports, 'attached to the returned ports');
  assert.equal(calls.attaches.every(entry => entry.context === input.context), true,
    'the EXISTING context is reused');
  assert.equal(calls.creates.length, 0, 'a mapped account never falls into api.create()');
  assert.equal(calls.proxyChanges, 0, 'no proxy rotation');
  assert.equal(summary.profileId || outcome.profileId, PROFILE, 'the profile id is preserved');

  // Graceful stop before Multilogin stop/sync, twice; then the lock is free.
  assert.deepEqual(calls.order, ['Browser.close', `api.stop:${PROFILE}`, 'Browser.close', `api.stop:${PROFILE}`]);
  assert.equal(calls.stops.length, 2);
  assert.equal(calls.lockSnapshots.some(entries => entries.includes(`profile-yt-live-profile-01.lock`)), true,
    'the job held exactly one profile lock while it ran');
  assert.equal(calls.lockSnapshots.every(entries =>
    entries.filter(entry => entry.startsWith('profile-')).length <= 1), true, 'never two locks for one job');
  assert.deepEqual(await readdir(join(input.directory, 'locks')), [], 'the lock is released after completion');

  // Nothing on this path can launch a browser or make its own context.
  assert.equal(typeof input.browser.launch, 'undefined');
  assert.equal(typeof input.context.newContext, 'undefined');
});

test('a failed attach still stops gracefully and releases the provider lock', async t => {
  const input = await harness(t, { attachFails: true });
  await runCanary(input);
  const calls = input.calls;

  assert.equal(calls.starts.length, 1, 'the profile was started once');
  assert.equal(calls.creates.length, 0, 'no profile was created');
  assert.equal(calls.provider.some(entry => entry.name === 'detach'), true, 'ownership was released by the provider');
  assert.equal(calls.stops.length >= 1, true, 'the started profile was stopped again');
  assert.deepEqual(await readdir(join(input.directory, 'locks')), [], 'the lock is released after a failure');
});
