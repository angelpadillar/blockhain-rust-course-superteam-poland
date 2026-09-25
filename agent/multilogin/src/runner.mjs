import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { PilotError, requireThat, errorCode, failurePolicy } from './core.mjs';
import { lock, readJson, writeJson } from './storage.mjs';
import { resolveProxy } from './multilogin.mjs';
import { runLogin, navigate } from './login.mjs';

export async function loadPlaywright() {
  try { return await import('playwright-core'); }
  catch {
    // Workspace fallback for local development; standalone deployment uses npm ci.
    try { return await import(new URL('../../../hackathon/jev/node_modules/playwright-core/index.mjs', import.meta.url)); }
    catch { throw new PilotError('install_playwright_core'); }
  }
}
export const defaults = {
  launcherUrl: 'https://launcher.mlx.yt:45001', cdpHost: '127.0.0.1',
  osType: process.platform === 'darwin' ? 'macos' : 'linux', cloudStorage: true, headless: false,
  maxAccounts: 6, maxProxySwitches: 1, maxSteps: 20, maxSeconds: 180, verifyRestart: true,
  humanCheckpointSeconds: 600,
  seedSites: ['https://www.amazon.pl/', 'https://www.ebay.com/'], proxyMode: 'multilogin', proxyCountry: null, proxyPool: [],
  // Degraded mode: the profile's ALREADY-ATTACHED proxy is the only one allowed.
  // Provisioning and rotation are refused; a failing proxy fails closed.
  reuseExistingProxy: false,
  // Bandwidth discipline: a genuine security surface gets a bounded settle and
  // one re-observe before a person is asked, media is not fetched during a job,
  // and a YouTube run checks the home/auth surface before any Google redirect.
  challengeSettleMs: 1500,
  blockMedia: true,
  youtubeStartAtHome: true,
};
export function validateConfig(supplied) {
  const config = { ...defaults, ...supplied };
  requireThat(['macos', 'linux', 'windows'].includes(config.osType), 'invalid_profile_os');
  requireThat(typeof config.cloudStorage === 'boolean' && typeof config.headless === 'boolean'
    && typeof config.verifyRestart === 'boolean', 'invalid_profile_flags');
  requireThat(Number.isInteger(config.maxAccounts) && config.maxAccounts >= 1 && config.maxAccounts <= 6, 'max_six_accounts_per_pilot');
  requireThat(Number.isInteger(config.maxProxySwitches) && config.maxProxySwitches >= 0 && config.maxProxySwitches <= 2, 'invalid_proxy_retry_limit');
  requireThat(Number.isInteger(config.maxSteps) && config.maxSteps >= 1 && config.maxSteps <= 30, 'invalid_step_limit');
  requireThat(Number.isInteger(config.maxSeconds) && config.maxSeconds >= 10 && config.maxSeconds <= 300, 'invalid_time_limit');
  requireThat(Number.isInteger(config.humanCheckpointSeconds) && config.humanCheckpointSeconds >= 1
    && config.humanCheckpointSeconds <= 7200, 'invalid_human_checkpoint_limit');
  requireThat(['multilogin', 'pool', 'none'].includes(config.proxyMode), 'invalid_proxy_mode');
  requireThat(typeof config.reuseExistingProxy === 'boolean', 'invalid_proxy_reuse_flag');
  requireThat(Number.isInteger(config.challengeSettleMs) && config.challengeSettleMs >= 0
    && config.challengeSettleMs <= 10000, 'invalid_challenge_settle');
  requireThat(typeof config.blockMedia === 'boolean' && typeof config.youtubeStartAtHome === 'boolean',
    'invalid_bandwidth_flags');
  requireThat(config.proxyCountry === null || /^[a-z]{2}$/.test(config.proxyCountry), 'invalid_proxy_country');
  requireThat(Array.isArray(config.proxyPool), 'invalid_proxy_pool');
  requireThat(typeof config.cdpHost === 'string' && /^[a-zA-Z0-9.-]+$/.test(config.cdpHost), 'invalid_cdp_host');
  requireThat(Array.isArray(config.seedSites) && config.seedSites.length <= 2
    && config.seedSites.every(url => defaults.seedSites.includes(url)), 'invalid_seed_sites');
  return config;
}

export async function seedSites(context, urls) {
  const results = [];
  for (const url of urls) {
    const page = await context.newPage();
    try {
      await navigate(page, url);
      requireThat(new URL(page.url()).hostname === new URL(url).hostname, 'seed_redirect_requires_review');
      results.push({ site: new URL(url).hostname, status: 'visited' });
    } catch (error) { results.push({ site: new URL(url).hostname, status: 'needs_attention', reason: errorCode(error) }); }
    finally { await page.close().catch(() => {}); }
  }
  return results;
}
export async function connect(port, config) {
  const { chromium } = await loadPlaywright();
  let browser;
  try { browser = await chromium.connectOverCDP(`http://${config.cdpHost}:${port}`, { timeout: 15000 }); }
  catch { throw new PilotError('browser_attachment_failed'); }
  const context = browser.contexts()[0];
  requireThat(context, 'missing_multilogin_context');
  context.setDefaultTimeout(7000);
  return { browser, context, page: await context.newPage() };
}

export async function stopBrowserProfile(api, profileId, browser) {
  // Chromium must flush its persistent data before the launcher's cloud sync.
  // API-only stopping lost the test cookie; graceful close passed the live test.
  if (browser?.isConnected?.()) {
    const cdp = await browser.newBrowserCDPSession();
    await cdp.send('Browser.close').catch(() => {});
    const deadline = Date.now() + 10000;
    while (browser.isConnected() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 100));
    requireThat(!browser.isConnected(), 'browser_stop_not_confirmed');
  }
  await api.stop(profileId);
}

// `provider` (a MultiloginSessionProvider) is the production profile/session
// lifecycle: ownership lock, launcher start, launcher-returned CDP endpoint, the
// existing context and the graceful stop. When it is supplied this function does
// not start, attach or stop a profile itself.
export async function runBatch({ accounts, config: supplied, api, guideFactory, directory,
  connectImpl = connect, loginImpl = runLogin, seedImpl = seedSites, provider = null }) {
  const config = validateConfig(supplied);
  requireThat(accounts.length <= config.maxAccounts, 'too_many_accounts');
  requireThat(/^[a-zA-Z0-9-]{8,80}$/.test(config.folderId || '') && !config.folderId.includes('REPLACE'), 'folder_id_required');
  for (const account of accounts) {
    if (config.proxyMode === 'multilogin') requireThat(account.proxyCountry || config.proxyCountry, 'proxy_country_required');
  }
  const release = await lock(directory);
  const statePath = resolve(directory, 'profiles.json');
  const report = { id: randomUUID(), startedAt: new Date().toISOString(), mode: 'live-jev',
    reuseExistingProxy: config.reuseExistingProxy === true, accounts: [] };
  const reportPath = resolve(directory, 'reports', `${report.id}.json`);
  try {
    const state = await readJson(statePath, { version: 1, folderId: config.folderId, profiles: {} });
    requireThat(!state.executionLayout, 'use_concurrent_batch_runner');
    requireThat(state.version === 1 && state.folderId === config.folderId && state.profiles, 'state_workspace_mismatch');
    const save = () => {
      state.characters = Object.create(null);
      for (const [accountId, profile] of Object.entries(state.profiles)) {
        if (!profile.characterId) continue;
        state.characters[profile.characterId] ||= {};
        state.characters[profile.characterId][profile.platform] = { accountId, accountHandle: profile.accountHandle,
          profileId: profile.profileId || null, setupStatus: profile.setupStatus || 'provisioning',
          lastVerifiedAt: profile.lastVerifiedAt || null };
      }
      return writeJson(statePath, state);
    };
    for (const account of accounts) {
      const began = performance.now(); const guide = guideFactory();
      const result = { accountId: account.id, platform: account.platform, status: 'running', events: [], proxySwitches: 0 };
      report.accounts.push(result); await writeJson(reportPath, report);
      let record = state.profiles[account.id]; let session; let started = false;
      const event = async detail => { result.events.push(detail); await writeJson(reportPath, report); };
      const stop = async () => {
        if (!started) return;
        record.pending = 'stop'; await save();
        // One ownership abstraction: with a provider, the graceful stop (Chromium
        // flushed, then Multilogin stop/sync) is its job; ownership stays held.
        if (provider) await provider.suspend();
        else await stopBrowserProfile(api, record.profileId, session?.browser);
        started = false; record.pending = null; await save();
        if (!provider) { await session?.browser?.close().catch(() => {}); session = null; }
      };
      const start = async () => {
        record.pending = 'start'; await save();
        // The pending marker is cleared before the attach can fail, exactly as in
        // the direct path, so an interrupted attach is never left unreconciled.
        if (provider) {
          await provider.start();
          started = true; record.pending = null; await save();
          session = await provider.connect();
        } else {
          const port = await api.start(config.folderId, record.profileId, config.headless);
          started = true; record.pending = null; await save();
          session = await connectImpl(port, config);
        }
      };
      const newProxy = async index => {
        // Degraded mode never provisions or rotates: the profile's own attached
        // proxy is the only one allowed, and a missing profile is refused.
        if (config.reuseExistingProxy) {
          const error = new PilotError('reuse_existing_proxy_requires_profile');
          error.proxyReuseBlocked = true; throw error;
        }
        if (config.proxyMode === 'multilogin') return api.premiumProxy(account.proxyCountry || config.proxyCountry);
        if (config.proxyMode === 'pool') {
          requireThat(config.proxyPool[index], 'proxy_pool_exhausted'); return resolveProxy(config.proxyPool[index]);
        }
        return undefined;
      };
      try {
        if (account.characterId) requireThat(!Object.entries(state.profiles).some(([otherId, other]) =>
          otherId !== account.id && other.characterId === account.characterId && other.platform === account.platform), 'character_platform_already_bound');
        if (record) {
          requireThat(!record.pending, 'profile_lifecycle_requires_reconciliation');
          requireThat(record.profileId && record.platform === account.platform, 'profile_mapping_invalid');
          requireThat(record.proxyMode === config.proxyMode && record.osType === config.osType
            && record.cloudStorage === config.cloudStorage, 'profile_configuration_changed');
          if (config.proxyMode === 'multilogin') requireThat(record.proxyCountry === (account.proxyCountry || config.proxyCountry), 'profile_country_changed');
          requireThat(!record.characterId || !account.characterId || record.characterId === account.characterId, 'account_character_changed');
          if (account.characterId) record.characterId = account.characterId;
          record.accountHandle = account.username; await save();
        } else {
          const proxy = await newProxy(0);
          record = { name: `jev-${account.platform}-${account.id}`, platform: account.platform,
            characterId: account.characterId || null, accountHandle: account.username, setupStatus: 'provisioning',
            proxyMode: config.proxyMode, proxyCountry: account.proxyCountry || config.proxyCountry,
            proxyIndex: 0, osType: config.osType, cloudStorage: config.cloudStorage, pending: 'create' };
          state.profiles[account.id] = record; await save();
          record.profileId = await api.create({ name: record.name, folderId: config.folderId,
            osType: config.osType, cloudStorage: config.cloudStorage, proxy });
          record.pending = null; await save();
        }
        result.profileId = record.profileId;
        // The provider wraps the SAME profile the record layer resolved (or just
        // created): it is bound before it is started.
        if (provider) provider.bindProfileId(record.profileId);
        const withRecovery = async task => { for (;;) {
          try {
            await start();
            return await task();
          } catch (error) {
            const code = errorCode(error);
            await stop();
            if (!started && record.pending === 'start' && error.lifecycleStopped === true) {
              record.pending = null; await save();
            }
            if (!failurePolicy(code).rotateProxy || config.proxyMode === 'none' || result.proxySwitches >= config.maxProxySwitches) throw error;
            // The rotation the policy would allow is disabled in degraded mode:
            // the original failure is re-thrown, marked, and nothing is provisioned.
            if (config.reuseExistingProxy) { error.proxyRotationDisabled = true; throw error; }
            const proxy = await newProxy(record.proxyIndex + 1);
            record.pending = 'proxy_change'; await save();
            await api.changeProxy(record.profileId, proxy);
            record.proxyIndex++; record.pending = null; result.proxySwitches++; await save();
            await event({ phase: 'transport_recovery', reason: code, proxySwitches: result.proxySwitches });
          }
        } };
        result.login = await withRecovery(() => loginImpl({ page: session.page, account, choose: guide,
          maxSteps: config.maxSteps, maxSeconds: config.maxSeconds, onStep: event }));
        requireThat(result.login?.verified, 'login_not_verified');
        result.seedSites = await seedImpl(session.context, config.seedSites);
        await stop();
        if (config.verifyRestart) {
          result.reopen = await withRecovery(() => loginImpl({ page: session.page, account, choose: guide, verifyOnly: true,
            maxSteps: 5, maxSeconds: 45, onStep: event }));
          requireThat(result.reopen?.verified, 'session_or_identity_not_verified');
          await stop();
        }
        result.status = result.seedSites.some(item => item.status !== 'visited') ? 'completed_with_seed_attention' : 'completed';
        record.lastVerifiedAt = new Date().toISOString(); await save();
      } catch (error) { result.status = 'needs_attention'; result.reason = errorCode(error); }
      finally {
        try { await stop(); } catch (error) {
          result.status = 'needs_attention'; result.cleanupReason = errorCode(error);
          // Keep the pending lifecycle marker, preventing an unattended duplicate start.
        }
        result.durationMs = Math.round(performance.now() - began);
        result.jev = { ...guide.metrics };
        if (record) { record.setupStatus = result.status; await save(); }
        await writeJson(reportPath, report);
      }
      if (record?.pending) break;
    }
    report.finishedAt = new Date().toISOString();
    report.completed = report.accounts.filter(item => item.status.startsWith('completed')).length;
    report.notStarted = accounts.length - report.accounts.length;
    await writeJson(reportPath, report);
    return { report, reportPath };
  } finally { await release(); }
}
