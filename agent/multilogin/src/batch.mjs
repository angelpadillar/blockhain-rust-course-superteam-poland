import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import { requireThat, errorCode } from './core.mjs';
import { lock, readJson, writeJson } from './storage.mjs';
import { runBatch, validateConfig } from './runner.mjs';

// A global lock protects the registry; independent account directories own their
// lifecycle checkpoints. Their state remains authoritative after interruption.
export async function runConcurrentBatch({ accounts, config: supplied, directory,
  concurrency = 1, onAccount = async () => {}, runAccount = runBatch, ...dependencies }) {
  const config = validateConfig(supplied);
  requireThat(Number.isInteger(concurrency) && concurrency >= 1 && concurrency <= 5, 'invalid_concurrency');
  requireThat(accounts.length > 0 && accounts.length <= config.maxAccounts, 'invalid_batch_size');
  requireThat(new Set(accounts.map(account => account.id)).size === accounts.length
    && accounts.every(account => /^[a-f0-9]{20}$/.test(account.id)), 'invalid_batch_accounts');
  const release = await lock(directory);
  const statePath = resolve(directory, 'profiles.json');
  const report = { id: randomUUID(), startedAt: new Date().toISOString(), mode: 'concurrent-login',
    concurrency, peakWorkers: 0, accounts: [], completed: 0, notStarted: accounts.length };
  const reportPath = resolve(directory, 'reports', `${report.id}.json`);
  const activePorts = new Map(); const sourceApi = dependencies.api;
  const ownedApi = Object.create(sourceApi);
  report.peakStartedProfiles = 0;
  ownedApi.start = async (...args) => {
    const port = await sourceApi.start(...args);
    requireThat(!activePorts.has(port), 'browser_endpoint_already_owned');
    activePorts.set(port, args[1]); report.peakStartedProfiles = Math.max(report.peakStartedProfiles, activePorts.size);
    return port;
  };
  ownedApi.stop = async profileId => {
    const result = await sourceApi.stop(profileId);
    for (const [port, owner] of activePorts) if (owner === profileId) activePorts.delete(port);
    return result;
  };
  try {
    const state = await readJson(statePath, { version: 1, folderId: config.folderId, profiles: {} });
    requireThat(state.version === 1 && state.folderId === config.folderId && state.profiles, 'state_workspace_mismatch');
    requireThat(!state.executionLayout || state.executionLayout === 'account-workers-v1', 'unknown_state_layout');
    // Recover account mappings written before a previous aggregate report could finish.
    for (const id of await readdir(resolve(directory, 'accounts')).catch(error => {
      if (error.code === 'ENOENT') return []; throw error;
    })) {
      requireThat(/^[a-f0-9]{20}$/.test(id), 'invalid_account_worker_directory');
      const child = await readJson(resolve(directory, 'accounts', id, 'profiles.json'), null);
      if (!child) continue;
      requireThat(child.version === 1 && child.folderId === config.folderId && Object.keys(child.profiles).every(key => key === id), 'account_worker_state_mismatch');
      if (child.profiles[id]) {
        requireThat(!state.profiles[id]?.profileId || !child.profiles[id].profileId
          || state.profiles[id].profileId === child.profiles[id].profileId, 'account_worker_profile_conflict');
        state.profiles[id] = child.profiles[id];
      }
    }
    const jobs = [];
    for (const account of accounts) {
      const childDirectory = resolve(directory, 'accounts', account.id);
      const childPath = resolve(childDirectory, 'profiles.json');
      let child = await readJson(childPath, null);
      if (!child) {
        child = { version: 1, folderId: config.folderId, profiles: {} };
        if (state.profiles[account.id]) child.profiles[account.id] = state.profiles[account.id];
        await writeJson(childPath, child);
      }
      requireThat(child.version === 1 && child.folderId === config.folderId
        && Object.keys(child.profiles).every(id => id === account.id), 'account_worker_state_mismatch');
      const existing = child.profiles[account.id];
      requireThat(!existing?.profileId || !state.profiles[account.id]?.profileId
        || existing.profileId === state.profiles[account.id].profileId, 'account_worker_profile_conflict');
      if (existing) state.profiles[account.id] = existing;
      if (account.characterId) {
        requireThat(!Object.entries(state.profiles).some(([id, profile]) => id !== account.id
          && profile.characterId === account.characterId && profile.platform === account.platform), 'character_platform_already_bound');
      }
      jobs.push({ account, directory: childDirectory, statePath: childPath });
    }
    // Protect against accidental use of the older sequential entrypoint after migration.
    state.executionLayout = 'account-workers-v1'; await writeJson(statePath, state);
    report.accounts = accounts.map(account => ({ accountId: account.id, platform: account.platform, status: 'queued' }));
    await writeJson(reportPath, report);
    let next = 0; let active = 0;
    async function worker() {
      for (;;) {
        const index = next++; if (index >= jobs.length) return;
        const job = jobs[index]; active++; report.peakWorkers = Math.max(report.peakWorkers, active);
        try {
          const result = await runAccount({ ...dependencies, api: ownedApi, accounts: [job.account], config, directory: job.directory });
          report.accounts[index] = { ...result.report.accounts[0], reportPath: result.reportPath };
        } catch (error) {
          report.accounts[index] = { accountId: job.account.id, platform: job.account.platform,
            status: 'needs_attention', reason: errorCode(error) };
        } finally { active--; }
        try { await onAccount({ accountId: job.account.id, status: report.accounts[index].status,
          reason: report.accounts[index].reason || null }); } catch {}
      }
    }
    await Promise.all(Array.from({ length: Math.min(concurrency, jobs.length) }, () => worker()));
    for (const job of jobs) {
      const child = await readJson(job.statePath);
      if (child.profiles[job.account.id]) state.profiles[job.account.id] = child.profiles[job.account.id];
    }
    state.characters = Object.create(null);
    for (const [accountId, profile] of Object.entries(state.profiles)) {
      if (!profile.characterId) continue;
      state.characters[profile.characterId] ||= {};
      state.characters[profile.characterId][profile.platform] = { accountId, accountHandle: profile.accountHandle,
        profileId: profile.profileId || null, setupStatus: profile.setupStatus || 'provisioning', lastVerifiedAt: profile.lastVerifiedAt || null };
    }
    await writeJson(statePath, state);
    report.completed = report.accounts.filter(account => account.status.startsWith('completed')).length;
    report.notStarted = 0; report.finishedAt = new Date().toISOString();
    report.durationMs = Date.parse(report.finishedAt) - Date.parse(report.startedAt);
    report.jev = report.accounts.reduce((total, account) => {
      for (const key of ['calls', 'latencyMs', 'inputTokens', 'outputTokens', 'exactActions']) total[key] += account.jev?.[key] || 0;
      total.usageComplete &&= account.jev?.usageComplete === true;
      return total;
    }, { calls: 0, latencyMs: 0, inputTokens: 0, outputTokens: 0, exactActions: 0, usageComplete: true });
    await writeJson(reportPath, report);
    return { report, reportPath };
  } finally { await release(); }
}
