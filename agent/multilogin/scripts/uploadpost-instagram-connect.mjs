import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { requireThat, errorCode, totp } from '../src/core.mjs';
import { readPrivate } from '../src/storage.mjs';
import { Multilogin } from '../src/multilogin.mjs';
import { connect, stopBrowserProfile } from '../src/runner.mjs';

// Upload-Post Instagram OAuth connector for ONE warmed Multilogin profile.
//
//   --mode check    verify the Instagram session and report the current handle
//   --mode connect  open the provided Upload-Post/Instagram authorize URL, follow
//                   the Instagram consent UI, relay the app.upload-post.com
//                   callback if the proxy cannot reach it, and report the result
//
// The script never types a password and never fabricates cookies. A login wall,
// forced re-auth or challenge becomes `human_required`.
//
// Usage:
//   node scripts/uploadpost-instagram-connect.mjs --profile-id <id> [--handle <ig_handle>] \
//     --mode check|connect [--authorize-url URL | --authorize-url-file FILE] \
//     [--evidence-dir /data/instagram-evidence] [--watchdog-ms 300000] [--keep-profile]

export const DEFAULT_FOLDER = '2b104092-39f8-459e-be4c-74e037507dd3';
export const AC_PROFILES_URL = 'https://accountscenter.instagram.com/profiles/';
export const EDIT_URL = 'https://www.instagram.com/accounts/edit/';

export function parseArguments(argv) {
  const options = { positional: [] };
  const valueFlags = ['--profile-id', '--handle', '--mode', '--authorize-url', '--authorize-url-file',
    '--evidence-dir', '--token-file', '--folder-id', '--launcher-url', '--code', '--watchdog-ms',
    '--email', '--accounts-file'];
  for (let index = 0; index < argv.length; index++) {
    const token = argv[index];
    if (token === '--keep-profile') options.keepProfile = true;
    else if (token === '--auto-login') options.autoLogin = true;
    else if (valueFlags.includes(token)) {
      const value = argv[index + 1];
      requireThat(typeof value === 'string' && !value.startsWith('--'), 'invalid_command_arguments');
      options[token.slice(2)] = value; index++;
    } else if (token.startsWith('--')) throw new Error(`unknown argument ${token}`);
    else options.positional.push(token);
  }
  return options;
}

async function visibleDom(page) {
  return page.evaluate(() => {
    const visible = el => !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
    const buttons = [...document.querySelectorAll('button, [role="button"], [role="menuitem"], a')]
      .filter(visible).map(b => (b.innerText || '').replace(/\s+/g, ' ').trim()).filter(Boolean).slice(0, 25);
    const inputs = [...document.querySelectorAll('input')].filter(visible)
      .map(i => ({ type: i.getAttribute('type') || 'text', name: i.getAttribute('name') || '',
        placeholder: i.getAttribute('placeholder') || '' })).slice(0, 12);
    const text = (document.body.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 700);
    return { url: location.href, buttons, inputs, text };
  }).catch(() => null);
}

/** Read the logged-in Instagram handle through Accounts Center. */
export async function readInstagramHandle(page) {
  await page.goto(AC_PROFILES_URL, { waitUntil: 'commit', timeout: 40000 }).catch(() => {});
  await page.waitForLoadState('domcontentloaded', { timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(3500);
  const url = page.url();
  let body = await page.locator('body').innerText({ timeout: 8000 }).catch(() => '');
  if (/\/accounts\/login/.test(url) || /use another profile|create new account|forgot password/i.test(body)) return null;
  const row = page.getByText(/^instagram$/i).first();
  if (await row.isVisible().catch(() => false)) {
    await row.click({ timeout: 8000 }).catch(() => {});
    await page.waitForTimeout(3000);
    body = await page.locator('body').innerText({ timeout: 8000 }).catch(() => '');
  }
  const match = /(?:^|\n)([a-z0-9._]{3,30})\nInstagram(?:\n|$)/i.exec(body);
  return match ? match[1] : null;
}

/** Instagram's forced-authentication screen shows the remembered account card. */
export async function completeAccountPicker(page) {
  const body = await page.locator('body').innerText({ timeout: 6000 }).catch(() => '');
  if (!/use another profile|create new account/i.test(body)) return null;
  const card = page.getByRole('button', { name: /^continue$/i }).first();
  if (!(await card.isVisible().catch(() => false))) return null;
  await card.click({ timeout: 8000 }).catch(() => {});
  await page.waitForTimeout(3500);
  const after = await page.locator('body').innerText({ timeout: 6000 }).catch(() => '');
  if (/password/i.test(after)) return 'password_required';
  if (/confirmation code|security code|enter the 6-digit/i.test(after)) return 'code_required';
  return 'continued';
}

async function igFirstVisible(page, selectors) {
  for (const selector of selectors) {
    const control = page.locator(selector).first();
    if (await control.isVisible().catch(() => false)) return control;
  }
  return null;
}

async function igClickByText(page, patterns, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const pattern of patterns) {
      const control = page.getByRole('button', { name: pattern }).first();
      if (await control.isVisible().catch(() => false) && await control.isEnabled().catch(() => false)) {
        await control.click({ timeout: 6000 }).catch(() => {});
        return true;
      }
    }
    await page.waitForTimeout(600);
  }
  return false;
}

/** Load the Instagram credential record (never logged). */
export async function loadIgCredential(accountsFile, key) {
  try {
    const accounts = JSON.parse(await readFile(accountsFile, 'utf8'));
    const norm = String(key ?? '').toLowerCase();
    const record = accounts.find((account) => account.platform === 'instagram'
      && (String(account.username).toLowerCase() === norm
        || String(account.previousUsername ?? '').toLowerCase() === norm
        || String(account.ref) === key));
    return record
      ? { username: record.username, previousUsername: record.previousUsername ?? null, password: record.password ?? null, totpSecret: record.totp ?? null }
      : null;
  } catch {
    return null;
  }
}

/**
 * Operator-authorized login on Instagram's forced-authentication page inside the
 * OAuth flow. Fills username/password, generates TOTP locally when asked, and
 * dismisses "Not now" interstitials. CAPTCHAs/challenges stop as human_required.
 */
export async function igLogin(page, credential, log) {
  if (!credential?.password) return 'no_credential';
  const candidates = [...new Set([credential.username, credential.previousUsername].filter(Boolean))];
  // Phase 1: reach a password field. Instagram shows either the saved-profile
  // picker ("Continue as <handle>", which opens a password modal) or a full form.
  const deadline = Date.now() + 90000;
  let ready = false;
  while (Date.now() < deadline) {
    const passField = await igFirstVisible(page, ['input[name="password"]', 'input[type="password"]']);
    if (passField) { ready = true; break; }
    const buttonTexts = await page.evaluate(() => [...document.querySelectorAll('button, [role="button"]')]
      .map((b) => (b.innerText || '').replace(/\s+/g, ' ').trim()).filter(Boolean).slice(0, 12)).catch(() => []);
    if (buttonTexts.some((text) => /continue|log in/i.test(text))) {
      const bodyText = await page.evaluate(() => (document.body?.innerText || '').replace(/\s+/g, ' ')).catch(() => '');
      if (candidates.some((candidate) => bodyText.toLowerCase().includes(String(candidate).toLowerCase()))) {
        const picker = page.locator('button:has-text("Continue"), [role="button"]:has-text("Continue")').first();
        if (await picker.isVisible().catch(() => false)) {
          await picker.click({ timeout: 8000 }).catch(() => {});
          log('ig_login', { step: 'saved_profile_continue' });
          await page.waitForTimeout(6000);
          continue;
        }
      }
    }
    await page.waitForTimeout(1500);
  }
  if (!ready) return 'form_not_found';
  // Phase 2: fill the password (username field optional) and submit.
  for (const candidate of candidates) {
    const passField = await igFirstVisible(page, ['input[name="password"]', 'input[type="password"]']);
    if (!passField) break;
    const userField = await igFirstVisible(page, ['input[name="username"]', 'input[aria-label*="username" i]', 'input[type="text"]']);
    if (userField) await userField.fill(candidate).catch(() => {});
    await passField.fill(credential.password).catch(() => {});
    await page.waitForTimeout(600);
    const submit = page.locator('button[type="submit"], button:has-text("Log in")').first();
    if (await submit.isVisible().catch(() => false)) await submit.click().catch(() => {});
    else await igClickByText(page, [/^log in$/i, /^continue$/i], 5000);
    log('ig_login', { step: 'password_submitted', candidate });
    await page.waitForTimeout(6000);
    let text = await page.evaluate(() => (document.body?.innerText || '').replace(/\s+/g, ' ')).catch(() => '');
    if (/captcha|challenge_required|suspicious|unusual/i.test(text)) return 'human_required';
    if (/password was incorrect|incorrect password|couldn't find an account/i.test(text)) {
      log('ig_login', { step: 'password_rejected', candidate });
      continue;
    }
    // Two-step verification (6-digit code): wait for the code input itself —
    // the page can take a while and its URL/text vary.
    const codeSelectors = ['input[name="verificationCode"]', 'input[name="securityCode"]', 'input[autocomplete="one-time-code"]',
      'input[inputmode="numeric"]', 'input[placeholder="Code" i]', 'input[aria-label*="code" i]', 'input[type="text"]'];
    let codeField = null;
    const codeDeadline = Date.now() + 40000;
    while (Date.now() < codeDeadline) {
      codeField = await igFirstVisible(page, codeSelectors);
      if (codeField && await codeField.isEditable().catch(() => false)) break;
      codeField = null;
      if (!page.url().includes('/accounts/login')) break;
      const current = await page.evaluate(() => (document.body?.innerText || '').replace(/\s+/g, ' ')).catch(() => '');
      if (/password was incorrect|incorrect password/i.test(current)) break;
      await page.waitForTimeout(1500);
    }
    if (codeField && credential.totpSecret) {
      const { code } = totp(credential.totpSecret);
      await codeField.fill(code).catch(() => {});
      await page.waitForTimeout(600);
      // "Trust this device" is offered here; favour it so 2FA is not repeated.
      const trust = page.getByRole('checkbox', { name: /trust this device/i }).first();
      if (await trust.isVisible().catch(() => false) && !(await trust.isChecked().catch(() => true))) {
        await trust.click().catch(() => {});
      }
      const submit2 = page.locator('button[type="submit"]').first();
      if (await submit2.isVisible().catch(() => false)) await submit2.click().catch(() => {});
      else await igClickByText(page, [/^continue$/i, /^confirm$/i, /^next$/i], 6000);
      log('ig_login', { step: 'totp_submitted' });
      await page.waitForTimeout(10000);
    }
    if (/two_step_verification|\/challenge\/|two_factor/i.test(page.url())) {
      log('ig_login', { step: 'two_step_required' });
      return 'human_required';
    }
    await igClickByText(page, [/^not now$/i, /not now/i], 5000);
    if (!page.url().includes('/accounts/login')) {
      await igClickByText(page, [/^not now$/i, /not now/i], 4000);
      return 'logged_in';
    }
  }
  return 'login_failed';
}

/** Click Instagram's own consent control; returns the matched label. */
export async function authorizeInstagram(page) {
  const candidates = [/^allow$/i, /^authorize$/i, /^continue$/i, /^continue as\b/i, /^agree$/i, /^ok$/i, /allow/i, /authorize/i];
  for (const pattern of candidates) {
    const control = page.getByRole('button', { name: pattern }).first();
    if (await control.isVisible().catch(() => false) && await control.isEnabled().catch(() => false)) {
      await control.click({ timeout: 8000 }).catch(() => {});
      return String(pattern);
    }
  }
  const link = page.locator('a, [role="link"]').filter({ hasText: /allow|authorize|continue/i }).first();
  if (await link.isVisible().catch(() => false)) {
    await link.click({ timeout: 8000 }).catch(() => {});
    return 'link-fallback';
  }
  return null;
}

export async function waitForHandoff(browser, page, knownPages, timeoutMs = 45000) {
  const deadline = Date.now() + timeoutMs;
  const startUrl = page.url();
  while (Date.now() < deadline) {
    const fresh = browser.contexts().flatMap(context => context.pages()).find(candidate => !knownPages.has(candidate));
    if (fresh) return { page: fresh, via: 'new_page' };
    if (page.url() !== startUrl) return { page, via: 'same_page' };
    await page.waitForTimeout(500);
  }
  return null;
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArguments(argv);
  requireThat(options['profile-id'], 'profile_id_required');
  const mode = options.mode || 'check';
  requireThat(['check', 'connect'].includes(mode), 'invalid_mode');
  const folderId = options['folder-id'] || DEFAULT_FOLDER;
  const token = (await readPrivate(resolve(options['token-file'] || '/data/automation-token'))).trim();
  const api = new Multilogin({ token, launcherUrl: options['launcher-url'] || 'https://launcher.mlx.yt:45001' });
  const evidenceDir = options['evidence-dir'] || '/data/instagram-evidence';
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const started = Date.now();
  const log = (event, extra = {}) => console.error(JSON.stringify({ at: new Date().toISOString(),
    elapsedMs: Date.now() - started, event, profileId: options['profile-id'], ...extra }));
  const watchdog = setTimeout(() => { log('watchdog_timeout'); process.exit(3); },
    Number(options['watchdog-ms'] || 300000));
  const report = { step: 'uploadpost_instagram_connect', code: options.code || null, mode,
    profileId: options['profile-id'], handle: null, expectedHandle: options.handle || null,
    connected: false, callbackHost: null, callbackUrlPath: null, callbackText: null,
    clickedLabel: null, callbackRelayed: false, relayed: [], warnings: [] };

  log('profile_resolve');
  const meta = await api.profileMeta(options['profile-id']);
  requireThat(meta, 'profile_metadata_missing');
  requireThat(!meta.in_use_by, 'profile_in_use');
  log('profile_start');
  const port = await api.start(folderId, options['profile-id'], false);
  log('profile_started', { port });
  const session = await connect(port, { cdpHost: '127.0.0.1' });
  log('attached');

  try {
    const page = session.page;
    page.setDefaultTimeout(15000);
    await mkdir(evidenceDir, { recursive: true, mode: 0o700 });
    const shot = name => resolve(evidenceDir, `ig-oauth-${options['profile-id']}-${stamp}-${name}.png`);

    report.handle = await readInstagramHandle(page);
    log('session', { handle: report.handle });
    if (!report.handle) report.warnings.push('instagram_session_unverified');
    if (report.handle && options.handle && report.handle.toLowerCase() !== options.handle.toLowerCase()) {
      report.status = 'handle_mismatch';
      report.warnings.push(`handle_mismatch:${report.handle}`);
    } else if (mode === 'check') {
      if (report.handle) report.status = 'session_ok';
      else {
        report.status = 'human_required';
        report.screenshot = shot('session');
        await page.screenshot({ path: report.screenshot }).catch(() => {});
      }
    } else {
      const authorizeUrl = options['authorize-url']
        || (options['authorize-url-file'] ? (await readPrivate(resolve(options['authorize-url-file']))).trim() : null);
      requireThat(authorizeUrl, 'authorize_url_required');
      const knownPages = new Set(session.context.pages());
      const relayed = [];
      report.relayed = relayed;
      await session.context.route('https://app.upload-post.com/**', async route => {
        const target = route.request().url();
        let parsed = { hostname: 'app.upload-post.com', pathname: '/' };
        try { parsed = new URL(target); } catch { /* defaults */ }
        try {
          const response = await fetch(target, { redirect: 'manual', signal: AbortSignal.timeout(20000) });
          relayed.push({ host: parsed.hostname, path: parsed.pathname, status: response.status });
          report.callbackRelayed = true;
          await route.fulfill({ status: 200, contentType: 'text/html', body: '<html><body>oauth callback relayed</body></html>' });
        } catch (error) {
          relayed.push({ host: parsed.hostname, path: parsed.pathname, error: String(error?.message || error).slice(0, 80) });
          await route.fulfill({ status: 502, contentType: 'text/html', body: 'relay failed' }).catch(() => {});
        }
      });
      log('authorize_goto');
      await page.goto(authorizeUrl, { waitUntil: 'commit', timeout: 45000 }).catch(() => {});
      await page.waitForLoadState('domcontentloaded', { timeout: 20000 }).catch(() => {});
      await page.waitForTimeout(3000);
      // Instagram forces an account picker for this app; selecting the account
      // is a normal user action (no credential is typed).
      const picker = await completeAccountPicker(page);
      if (picker) { report.accountPicker = picker; log('account_picker', { result: picker }); }
      await page.waitForTimeout(1500);
      report.stage1 = await visibleDom(page);
      report.stage1Shot = shot('stage1');
      await page.screenshot({ path: report.stage1Shot }).catch(() => {});
      log('stage1', { url: report.stage1?.url?.split('?')[0], buttons: report.stage1?.buttons?.slice(0, 6) });
      // Instagram forces a fresh login for this OAuth client even with a valid
      // session. Operator-authorized: fill the stored credentials, then re-open
      // the authorize URL so the consent flow can continue.
      if (page.url().includes('/accounts/login') && options.autoLogin) {
        const credential = await loadIgCredential(options['accounts-file'] || '/data/accounts.json', options.email || options.handle);
        if (credential) {
          const login = await igLogin(page, credential, log);
          report.login = login;
          if (login === 'logged_in') {
            await page.goto(authorizeUrl, { waitUntil: 'commit', timeout: 45000 }).catch(() => {});
            await page.waitForTimeout(3500);
            const picker2 = await completeAccountPicker(page);
            if (picker2) { report.accountPicker = picker2; log('account_picker', { result: picker2 }); }
            report.loginShot = shot('after-login');
            await page.screenshot({ path: report.loginShot }).catch(() => {});
          } else {
            report.status = 'human_required';
            report.warnings.push('instagram_login_failed');
          }
        } else {
          report.login = 'no_credential';
          report.status = 'human_required';
          report.warnings.push('instagram_forced_authentication');
        }
      }
      if (picker === 'password_required' || picker === 'code_required') {
        report.status = 'human_required';
        report.warnings.push(picker === 'password_required' ? 'instagram_password_required' : 'instagram_code_required');
      } else if (page.url().includes('/accounts/login') && !report.login) {
        report.status = 'human_required';
        report.warnings.push('instagram_forced_authentication');
      } else if (!report.status) {
        report.clickedLabel = await authorizeInstagram(page);
        if (!report.clickedLabel) {
          // Broad fallback: IG's consent control can be a styled div/link.
          const broad = page.locator('button, [role="button"], a').filter({ hasText: /(allow|authorize|continue|agree)/i }).first();
          if (await broad.isVisible().catch(() => false) && await broad.isEnabled().catch(() => true)) {
            await broad.click({ timeout: 8000 }).catch(() => {});
            report.clickedLabel = 'broad-consent';
          }
        }
        log('authorize_click', { clicked: report.clickedLabel });
        await page.waitForTimeout(2500);
        report.stage2 = await visibleDom(page);
        report.stage2Shot = shot('stage2');
        await page.screenshot({ path: report.stage2Shot }).catch(() => {});
        if (!report.clickedLabel) {
          report.status = 'authorize_control_not_found';
          report.warnings.push('authorize_button_missing');
        } else {
          const target = await waitForHandoff(session.browser, page, knownPages, 45000);
          if (!target) {
            report.status = 'callback_unexpected';
            report.warnings.push('authorize_no_handoff');
          } else {
            const targetPage = target.page;
            await targetPage.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {});
            const finalUrl = new URL(targetPage.url());
            report.handoffVia = target.via;
            report.callbackHost = finalUrl.hostname;
            report.callbackUrlPath = finalUrl.pathname;
            report.callbackText = (await targetPage.locator('body').innerText({ timeout: 8000 }).catch(() => '')).slice(0, 500);
            report.connected = /upload-post\.com$/i.test(finalUrl.hostname);
            report.status = report.connected ? 'callback_reached' : 'callback_unexpected';
          }
        }
      }
    }

    report.finalShot = shot('final');
    await page.screenshot({ path: report.finalShot }).catch(() => {});
  } catch (error) {
    report.error = String(error?.message || error).slice(0, 200);
    if (!report.status) report.status = 'connect_error';
  } finally {
    clearTimeout(watchdog);
    if (!options.keepProfile) await stopBrowserProfile(api, options['profile-id'], session.browser).catch(() => {});
  }
  if (report.status === 'human_required') {
    const { notifyHuman } = await import('../src/human-notify.mjs');
    report.notification = await notifyHuman({
      label: options.code || options.handle || options['profile-id'],
      reason: (report.warnings || []).join(',') || 'human_verification_required',
      url: report.stage1?.url || null,
      screenshotPath: report.stage1Shot || report.finalShot || null,
      resumeCommand: options.keepProfile ? 'browser left open for the operator (VNC)' : null,
    });
    log('notified', { sent: report.notification?.sent ?? false, reason: report.notification?.reason ?? null });
  }
  const reportPath = resolve(evidenceDir, `ig-oauth-${options['profile-id']}-${stamp}.json`);
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 }).catch(() => {});
  report.reportPath = reportPath;
  log('done', { status: report.status });
  console.log(JSON.stringify(report, null, 2));
  return ['session_ok', 'callback_reached'].includes(report.status) ? 0 : 2;
}

if (!process.argv[1] || process.argv[1] === '-' || process.argv[1].endsWith('uploadpost-instagram-connect.mjs')) {
  main().then(code => { process.exit(code); }).catch(error => {
    console.error(JSON.stringify({ step: 'uploadpost_instagram_connect', error: String(error?.message || error), code: errorCode(error) }));
    process.exit(1);
  });
}
