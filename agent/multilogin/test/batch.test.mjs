import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runConcurrentBatch } from '../src/batch.mjs';
import { runBatch } from '../src/runner.mjs';
import { parseAccounts, PilotError } from '../src/core.mjs';
import { readJson, writeJson } from '../src/storage.mjs';

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'jev-concurrent-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const accounts = parseAccounts(Array.from({ length: 5 }, (_, i) => `fixture_${i};private-password;`).join('\n'), 'instagram');
  let creates = 0; const active = new Set(); let peak = 0;
  const api = { create: async () => `profile-${++creates}`, start: async (_folder, id) => {
    assert.equal(active.has(id), false); active.add(id); peak = Math.max(peak, active.size); return 50000 + Number(id.split('-')[1]);
  }, stop: async id => { assert.equal(active.delete(id), true); } };
  return { accounts, directory, api, concurrency: 5, config: { folderId: 'folder-0001', proxyMode: 'none', seedSites: [] },
    guideFactory: () => Object.assign(async () => {}, { metrics: { calls: 0, usageComplete: true } }),
    connectImpl: async () => ({ page: {}, context: {}, browser: { close: async () => {} } }),
    loginImpl: async () => { await new Promise(resolve => setTimeout(resolve, 25)); return { verified: true }; },
    stats: () => ({ creates, peak, active: active.size }) };
}
test('five isolated profiles overlap, persist and rerun without duplicate creation', async t => {
  const input = await fixture(t); const first = await runConcurrentBatch(input);
  assert.equal(first.report.completed, 5); assert.equal(first.report.peakWorkers, 5);
  assert.equal(input.stats().peak, 5); assert.equal(input.stats().active, 0);
  assert.equal(new Set(first.report.accounts.map(account => account.profileId)).size, 5);
  const second = await runConcurrentBatch(input);
  assert.equal(second.report.completed, 5); assert.equal(input.stats().creates, 5);
  await assert.rejects(runBatch(input), /use_concurrent_batch_runner/);
  assert.equal(JSON.stringify(await readJson(first.reportPath)).includes('private-password'), false);
});
test('one account needing verification does not cancel four others', async t => {
  const input = await fixture(t);
  input.loginImpl = async ({ account }) => {
    if (account.id === input.accounts[2].id) throw new PilotError('email_or_sms_verification_required');
    await new Promise(resolve => setTimeout(resolve, 25)); return { verified: true };
  };
  input.onAccount = () => { throw new Error('unavailable progress sink'); };
  const { report } = await runConcurrentBatch(input);
  assert.equal(report.completed, 4); assert.equal(report.accounts[2].reason, 'email_or_sms_verification_required');
  assert.equal(input.stats().active, 0);
});
test('interrupted profile creation remains unresolved on rerun while other accounts complete', async t => {
  const input = await fixture(t); const account = input.accounts[0];
  await writeJson(join(input.directory, 'accounts', account.id, 'profiles.json'), { version: 1,
    folderId: input.config.folderId, profiles: { [account.id]: { platform: 'instagram', pending: 'create' } } });
  const { report } = await runConcurrentBatch(input);
  assert.equal(report.completed, 4); assert.equal(input.stats().creates, 4);
  assert.equal(report.accounts[0].reason, 'profile_lifecycle_requires_reconciliation');
});
test('existing sequential account mapping migrates without recreating the profile', async t => {
  const input = await fixture(t); input.accounts = [input.accounts[0]];
  await runBatch(input); await runConcurrentBatch(input);
  assert.equal(input.stats().creates, 1);
});
test('batch ownership and configured concurrency are enforced', async t => {
  const input = await fixture(t); let release;
  const gate = new Promise(resolve => { release = resolve; });
  input.loginImpl = async () => { await gate; return { verified: true }; };
  const first = runConcurrentBatch({ ...input, concurrency: 2 });
  while (input.stats().active < 2) await new Promise(resolve => setTimeout(resolve, 10));
  await assert.rejects(runConcurrentBatch(input), /worker_locked_or_stale_lock/);
  release(); const { report } = await first;
  assert.equal(report.completed, 5); assert.equal(input.stats().peak, 2);
});
test('a duplicate browser-control endpoint is rejected before another account can enter credentials', async t => {
  const input = await fixture(t); input.accounts = input.accounts.slice(0, 2); input.config.verifyRestart = false;
  const start = input.api.start; input.api.start = async (...args) => { await start(...args); return 50001; };
  const logins = []; input.loginImpl = async ({ account }) => {
    logins.push(account.id); await new Promise(resolve => setTimeout(resolve, 50)); return { verified: true };
  };
  const { report } = await runConcurrentBatch(input);
  assert.equal(logins.length, 1);
  assert.equal(report.accounts.filter(account => account.reason === 'browser_endpoint_already_owned').length, 1);
  const unresolved = report.accounts.find(account => account.reason === 'browser_endpoint_already_owned');
  const state = await readJson(join(input.directory, 'accounts', unresolved.accountId, 'profiles.json'));
  assert.equal(state.profiles[unresolved.accountId].pending, 'start');
});
