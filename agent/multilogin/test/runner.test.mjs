import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runBatch, stopBrowserProfile } from '../src/runner.mjs';
import { parseAccounts, PilotError } from '../src/core.mjs';
import { lock } from '../src/storage.mjs';

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'jev-ml-test-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const calls = []; let number = 0;
  const api = {
    create: async () => { calls.push('create'); return `profile-${++number}`; },
    start: async () => { calls.push('start'); return 50001; }, stop: async () => { calls.push('stop'); },
    premiumProxy: async () => { calls.push('proxy'); return { host: 'proxy.example', port: 1080, type: 'socks5' }; },
    changeProxy: async () => { calls.push('changeProxy'); },
  };
  const accounts = parseAccounts('fixture_user;private-password;', 'instagram');
  return { directory, calls, api, accounts,
    config: { folderId: 'folder-0001', proxyMode: 'multilogin', proxyCountry: 'pl', seedSites: [] },
    guideFactory: () => Object.assign(async () => {}, { metrics: { calls: 0, mode: 'offline-test-double' } }),
    connectImpl: async () => ({ page: {}, context: {}, browser: { close: async () => {} } }),
    loginImpl: async () => ({ verified: true }), seedImpl: async () => [] };
}
test('cloud profile mapping survives repeat jobs and verifies reopened sessions', async t => {
  const input = await fixture(t);
  const first = await runBatch(input); const second = await runBatch(input);
  assert.equal(first.report.completed, 1); assert.equal(second.report.completed, 1);
  assert.equal(input.calls.filter(value => value === 'create').length, 1);
  assert.equal(input.calls.filter(value => value === 'proxy').length, 1);
  assert.equal(input.calls.filter(value => value === 'start').length, 4);
  assert.equal((await readFile(first.reportPath, 'utf8')).includes('private-password'), false);
});
test('transport failover stops the existing profile before changing proxy, then reuses its ID', async t => {
  const input = await fixture(t); let count = 0;
  input.loginImpl = async () => { if (count++ === 0) throw new PilotError('proxy_connection_failed'); return { verified: true }; };
  const { report } = await runBatch(input);
  assert.equal(report.completed, 1); assert.equal(report.accounts[0].proxySwitches, 1);
  assert.deepEqual(input.calls.slice(0, 8), ['proxy', 'create', 'start', 'stop', 'proxy', 'changeProxy', 'start', 'stop']);
  assert.equal(input.calls.filter(value => value === 'create').length, 1);
});
test('incorrect passwords do not rotate proxies or retry credentials', async t => {
  const input = await fixture(t); let count = 0;
  input.loginImpl = async () => { count++; throw new PilotError('invalid_credentials'); };
  const { report } = await runBatch(input);
  assert.equal(report.accounts[0].reason, 'invalid_credentials'); assert.equal(count, 1);
  assert.equal(input.calls.includes('changeProxy'), false);
});
test('bounded connection recovery ends after one proxy switch', async t => {
  const input = await fixture(t); input.loginImpl = async () => { throw new PilotError('proxy_connection_failed'); };
  const { report } = await runBatch(input);
  assert.equal(report.accounts[0].status, 'needs_attention'); assert.equal(report.accounts[0].proxySwitches, 1);
});
test('uncertain profile creation cannot silently create a duplicate on rerun', async t => {
  const input = await fixture(t); let creates = 0;
  input.api.create = async () => { creates++; throw new PilotError('multilogin_request_uncertain'); };
  await runBatch(input); const { report } = await runBatch(input);
  assert.equal(creates, 1); assert.equal(report.accounts[0].reason, 'profile_lifecycle_requires_reconciliation');
});
test('uncertain stop retains reconciliation marker instead of reporting completion', async t => {
  const input = await fixture(t); input.api.stop = async () => { throw new PilotError('multilogin_request_uncertain'); };
  const { report } = await runBatch(input);
  assert.equal(report.accounts[0].status, 'needs_attention');
  const state = JSON.parse(await readFile(join(input.directory, 'profiles.json'), 'utf8'));
  assert.equal(state.profiles[input.accounts[0].id].pending, 'stop');
});
test('another worker cannot acquire the same state directory', async t => {
  const { directory } = await fixture(t); const release = await lock(directory);
  await assert.rejects(lock(directory), /worker_locked_or_stale_lock/); await release();
});
test('a confirmed prelaunch proxy failure recovers without leaving an uncertain start marker', async t => {
  const input = await fixture(t); let starts = 0;
  input.api.start = async () => {
    input.calls.push('start');
    if (++starts === 1) { const error = new PilotError('proxy_connection_failed'); error.lifecycleStopped = true; throw error; }
    return 50001;
  };
  const { report } = await runBatch(input);
  assert.equal(report.completed, 1); assert.equal(report.accounts[0].proxySwitches, 1);
  assert.equal(input.calls.filter(call => call === 'create').length, 1);
  const state = JSON.parse(await readFile(join(input.directory, 'profiles.json'), 'utf8'));
  assert.equal(state.profiles[input.accounts[0].id].pending, null);
});
test('transport recovery during reopen does not resubmit account credentials', async t => {
  const input = await fixture(t); const modes = [];
  input.loginImpl = async ({ verifyOnly = false }) => {
    modes.push(verifyOnly);
    if (modes.length === 2) throw new PilotError('proxy_connection_failed');
    return { verified: true };
  };
  const { report } = await runBatch(input);
  assert.equal(report.completed, 1); assert.deepEqual(modes, [false, true, true]);
  assert.equal(report.accounts[0].proxySwitches, 1);
});
test('character registry retains account/profile binding without credentials and rejects accidental rebinding', async t => {
  const input = await fixture(t); input.accounts[0].characterId = 'character-001';
  await runBatch(input);
  const raw = await readFile(join(input.directory, 'profiles.json'), 'utf8'); const state = JSON.parse(raw);
  assert.equal(raw.includes('private-password'), false);
  assert.equal(state.characters['character-001'].instagram.accountHandle, 'fixture_user');
  assert.equal(state.characters['character-001'].instagram.setupStatus, 'completed');
  input.accounts = parseAccounts('another_user;private-password;', 'instagram'); input.accounts[0].characterId = 'character-001';
  const { report } = await runBatch(input);
  assert.equal(report.accounts[0].reason, 'character_platform_already_bound');
  assert.equal(input.calls.filter(call => call === 'create').length, 1);
});
test('browser exits gracefully before Multilogin stop/sync is requested', async () => {
  let connected = true; const calls = [];
  const browser = { isConnected: () => connected, newBrowserCDPSession: async () => ({ send: async command => { calls.push(command); connected = false; } }) };
  await stopBrowserProfile({ stop: async () => { assert.equal(connected, false); calls.push('api_stop'); } }, 'profile-0001', browser);
  assert.deepEqual(calls, ['Browser.close', 'api_stop']);
});
