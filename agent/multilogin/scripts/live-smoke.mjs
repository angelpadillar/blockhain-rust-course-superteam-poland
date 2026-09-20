import { createInterface } from 'node:readline';
import { resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
import { Multilogin } from '../src/multilogin.mjs';
import { loadPlaywright, seedSites } from '../src/runner.mjs';
import { readJson, writeJson, lock } from '../src/storage.mjs';
import { requireThat, errorCode } from '../src/core.mjs';
import { createJev } from '../src/jev.mjs';
import { navigate } from '../src/login.mjs';

// Temporary token enters via stdin with no echo. No credentials are written to disk.
// Creates/reuses only this pilot's dedicated cloud profile; never opens existing accounts.
let api, state, statePath, release, browser, choose, started = false;
const report = { startedAt: new Date().toISOString(), checks: [], proxySwitches: 0 };
try {
  const input = createInterface({ input: process.stdin, terminal: false });
  const secrets = JSON.parse(await new Promise(resolve => input.once('line', resolve))); input.close();
  const config = JSON.parse(await readFile(process.argv[2] || 'config.vps.json', 'utf8'));
  const directory = resolve(process.argv[3] || '/data/smoke');
  release = await lock(directory); statePath = resolve(directory, 'profile.json');
  api = new Multilogin({ token: secrets.multiloginToken, launcherUrl: config.launcherUrl });
  const folders = await api.folders();
  requireThat(folders.folders?.some(folder => folder.folder_id === config.folderId), 'folder_unavailable');
  report.checks.push({ name: 'workspace_access', passed: true });
  state = await readJson(statePath, { name: 'jev-infrastructure-smoke-20260919', pending: null });
  if (state.profileId && state.pending === 'start') {
    const status = await api.status(state.profileId);
    report.previousProfileStatus = status.status;
    if (['stopped', 'start_browser_error', 'download_core_error', 'validate_proxy_error'].includes(status.status)) {
      state.pending = null; await writeJson(statePath, state);
      if (status.status === 'validate_proxy_error') {
        const proxy = await api.premiumProxy(config.proxyCountry);
        state.pending = 'proxy_change'; await writeJson(statePath, state);
        await api.changeProxy(state.profileId, proxy);
        state.pending = null; await writeJson(statePath, state);
        report.proxySwitches++;
        report.checks.push({ name: 'premium_proxy_refresh_same_profile', passed: true });
      }
    }
  }
  requireThat(!state.pending, 'smoke_profile_requires_reconciliation');
  if (!state.profileId) {
    const proxy = await api.premiumProxy(config.proxyCountry);
    state.pending = 'create'; await writeJson(statePath, state);
    state.profileId = await api.create({ name: state.name, folderId: config.folderId, osType: 'linux', cloudStorage: true, proxy });
    state.pending = null; await writeJson(statePath, state);
  }
  report.profileId = state.profileId;
  report.checks.push({ name: 'cloud_profile_with_premium_proxy', passed: true });
  const startProfile = async () => {
    state.pending = 'start'; await writeJson(statePath, state);
    try {
      const port = await api.start(config.folderId, state.profileId, true); started = true;
      state.pending = null; await writeJson(statePath, state); return port;
    } catch (error) {
      if (error.lifecycleStopped !== true) throw error;
      state.pending = null; await writeJson(statePath, state);
      if (report.proxySwitches >= 1) throw error;
      const proxy = await api.premiumProxy(config.proxyCountry);
      state.pending = 'proxy_change'; await writeJson(statePath, state);
      await api.changeProxy(state.profileId, proxy);
      state.pending = null; report.proxySwitches++; await writeJson(statePath, state);
      report.checks.push({ name: 'premium_proxy_refresh_same_profile', passed: true });
      return startProfile();
    }
  };
  const stopProfile = async () => {
    state.pending = 'stop'; await writeJson(statePath, state);
    if (browser?.isConnected()) {
      const cdp = await browser.newBrowserCDPSession();
      await cdp.send('Browser.close').catch(() => {});
    }
    const deadline = Date.now() + 10000;
    while (browser?.isConnected() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 100));
    requireThat(!browser?.isConnected(), 'browser_stop_not_confirmed');
    await api.stop(state.profileId);
    started = false; state.pending = null; await writeJson(statePath, state);
  };
  const port = await startProfile();
  const { chromium } = await loadPlaywright();
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: 20000 });
  const context = browser.contexts()[0]; requireThat(context, 'missing_multilogin_context');
  if (state.cookieMarked) report.checks.push({ name: 'cookie_preserved_from_previous_stopped_run',
    passed: (await context.cookies('https://example.com/')).some(cookie => cookie.name === 'jev_smoke' && cookie.value === 'ready') });
  report.checks.push({ name: 'playwright_attached_to_multilogin', passed: true });
  context.setDefaultTimeout(10000);
  const page = await context.newPage();
  report.phase = 'public_page_navigation';
  await navigate(page, 'https://example.com/');
  requireThat((await page.locator('h1').innerText()) === 'Example Domain', 'public_page_unverified');
  report.checks.push({ name: 'public_page_through_premium_proxy', passed: true });
  // An explicit test marker, unrelated to any social or merchant authentication.
  await context.addCookies([{ name: 'jev_smoke', value: 'ready', url: 'https://example.com/', expires: Math.floor(Date.now() / 1000) + 3600 }]);
  requireThat((await context.cookies('https://example.com/')).some(cookie => cookie.name === 'jev_smoke' && cookie.value === 'ready'), 'test_cookie_not_created');
  report.checks.push({ name: 'test_cookie_present_before_stop', passed: true });
  state.cookieMarked = true; await writeJson(statePath, state);
  if (secrets.typesafeKey) {
    report.phase = 'live_jev_action';
    try {
    const link = page.getByRole('link', { name: 'Learn more', exact: true });
    const href = await link.getAttribute('href');
    requireThat(href && ['iana.org', 'www.iana.org'].includes(new URL(href).hostname), 'smoke_link_unexpected');
    choose = createJev({ apiKey: secrets.typesafeKey, goal: 'Follow the Learn more link to read about example domains.' });
    const choice = await choose({ page: { text: await page.locator('body').innerText() },
      actions: [{ id: 'ready', description: 'Click the observed Learn more link to IANA about example domains.' }] });
    requireThat(choice.action.id === 'ready', 'smoke_wrong_action');
    await link.click();
    await page.waitForURL(url => ['iana.org', 'www.iana.org'].includes(url.hostname), { timeout: 15000 });
    report.checks.push({ name: 'live_jev_action_in_multilogin', passed: true, metrics: choose.metrics });
    } catch (error) {
      report.checks.push({ name: 'live_jev_action_in_multilogin', passed: false, reason: errorCode(error),
        confidence: error.confidence, probability: error.probability });
    }
  } else report.checks.push({ name: 'live_jev_action_in_multilogin', passed: false, reason: 'typesafe_key_missing' });
  await page.close();
  report.phase = 'merchant_homepage_visits';
  report.seedSites = await seedSites(context, config.seedSites);
  await stopProfile();
  report.checks.push({ name: 'clean_profile_stop', passed: true });
  await browser.close().catch(() => {});
  report.phase = 'restart_persistence';
  const reopenPort = await startProfile();
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${reopenPort}`, { timeout: 20000 });
  const restored = browser.contexts()[0]; requireThat(restored, 'missing_multilogin_context');
  const cookies = await restored.cookies('https://example.com/');
  requireThat(cookies.some(cookie => cookie.name === 'jev_smoke' && cookie.value === 'ready'), 'profile_cookie_not_preserved');
  report.checks.push({ name: 'cookie_preserved_across_profile_restart', passed: true });
  await stopProfile();
  report.status = report.checks.every(check => check.passed) ? 'completed' : 'partial';
} catch (error) {
  report.status = 'needs_attention'; report.reason = errorCode(error);
  if (error.vendorCode) report.vendorCode = error.vendorCode;
  if (Number.isFinite(error.confidence)) report.confidence = error.confidence;
  if (Number.isFinite(error.probability)) report.probability = error.probability;
}
finally {
  if (started) {
    try { await api.stop(state.profileId); state.pending = null; await writeJson(statePath, state); }
    catch (error) { report.cleanupReason = errorCode(error); }
  }
  await browser?.close().catch(() => {});
  if (choose) report.jev = { ...choose.metrics };
  if (statePath) {
    await writeJson(resolve(statePath, '..', 'reports', `${report.startedAt.replace(/[^0-9T]/g, '')}.json`), report);
    await writeJson(resolve(statePath, '..', 'latest-report.json'), report);
  }
  if (release) await release();
  console.log(JSON.stringify(report, null, 2));
  if (report.status !== 'completed') process.exitCode = 2;
}
