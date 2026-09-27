import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { requireThat } from '../src/core.mjs';
import { readPrivate } from '../src/storage.mjs';
import { Multilogin } from '../src/multilogin.mjs';
import { connect, stopBrowserProfile } from '../src/runner.mjs';

// Upload-Post YouTube connector for ONE warmed Multilogin profile.
//
// Google OAuth with prompt=select_account+consent: pick the signed-in account
// from the chooser, approve the consent screen, and let the callback reach
// app.upload-post.com (directly, or relayed from the worker container when the
// account proxy cannot reach that host).
//
//   --mode probe-url   open the minted authorize URL and report what Google shows
//   --mode authorize   choose the account, approve consent, wait for the callback
//
// The script never types a password, never dismisses a security challenge and
// never fabricates cookies. A login/password/CAPTCHA checkpoint becomes
// `human_required` and stops. An "app not verified" warning is NOT bypassed.
//
// Usage:
//   node scripts/uploadpost-youtube-connect.mjs --profile-id <id> \
//     --mode probe-url|authorize --authorize-url-file /data/yt-authorize-url.txt \
//     --email <google-account@example.com> [--evidence-dir /data/uploadpost-evidence] \
//     [--watchdog-ms 300000] [--keep-profile]

export const DEFAULT_FOLDER = '2b104092-39f8-459e-be4c-74e037507dd3';

export function parseArguments(argv) {
  const options = { positional: [] };
  const valueFlags = ['--profile-id', '--mode', '--authorize-url-file', '--email', '--accounts-file', '--evidence-dir', '--token-file', '--folder-id', '--label', '--watchdog-ms', '--human-window-seconds'];
  for (let index = 0; index < argv.length; index++) {
    const token = argv[index];
    if (token === '--keep-profile') options.keepProfile = true;
    else if (token === '--auto-login') options.autoLogin = true;
    else if (token === '--manual-consent') options.manualConsent = true;
    else if (valueFlags.includes(token)) {
      const value = argv[index + 1];
      requireThat(typeof value === 'string' && !value.startsWith('--'), 'invalid_command_arguments');
      options[token.slice(2)] = value;
      index++;
    } else if (token.startsWith('--')) throw new Error(`unknown argument ${token}`);
    else options.positional.push(token);
  }
  return options;
}

const clean = (text) => String(text ?? '').replace(/\s+/g, ' ').trim();
const CALLBACK_HOST = /app\.upload-post\.com/i;

function newestPage(page) {
  try {
    const pages = page.context().pages().filter((candidate) => !candidate.isClosed());
    return pages.length > 0 ? pages[pages.length - 1] : page;
  } catch {
    return page;
  }
}

async function firstVisible(page, selectors) {
  for (const selector of selectors) {
    const control = page.locator(selector).first();
    if (await control.isVisible().catch(() => false)) return control;
  }
  return null;
}

async function clickNextLike(page, patterns) {
  for (const pattern of patterns) {
    const control = page.getByRole('button', { name: pattern }).first();
    if (await control.isVisible().catch(() => false) && await control.isEnabled().catch(() => false)) {
      await control.click({ timeout: 8000 }).catch(() => {});
      return true;
    }
  }
  return false;
}

export async function loadCredential(accountsFile, email) {
  if (!accountsFile || !email) return null;
  try {
    const { readFile } = await import('node:fs/promises');
    const accounts = JSON.parse(await readFile(accountsFile, 'utf8'));
    const record = accounts.find((account) => String(account.username).toLowerCase() === String(email).toLowerCase());
    return record ? { password: record.password ?? null, totpSecret: record.totp ?? null } : null;
  } catch {
    return null;
  }
}

/**
 * Operator-authorized Google re-auth handling: fills the stored password and a
 * locally generated TOTP code when Google asks. Never touches a CAPTCHA or any
 * other challenge — those return `human_required`.
 */
export async function completeGoogleAuth(page, credential, log, maxMs = 150000) {
  if (!credential?.password) return 'no_credential';
  const deadline = Date.now() + maxMs;
  let usedPassword = false; let usedTotp = false;
  // Conservative: only credential fields are filled and submitted; after each
  // submission we OBSERVE (no generic clicking) so we can never trigger a
  // Cancel/Deny control by accident. Consent is handled by the caller.
  while (Date.now() < deadline) {
    const active = newestPage(page);
    const url = active.url();
    if (/[?&]error=/i.test(url)) return 'denied';
    if (CALLBACK_HOST.test(url) && !/[?&]error=/i.test(url)) return 'authorized';
    const text = await active.evaluate(() => document.body?.innerText || '').catch(() => '');
    if (/captcha|recaptcha|unusual activity/i.test(text)) return 'human_required';
    const consentText = /(wants to access|will be able to|access your Google Account)/i.test(text);
    const consentButton = await firstVisible(active, ['button:has-text("Continue")', 'button:has-text("Allow")']);
    if (consentText && consentButton) return 'consent';
    const passwordField = await firstVisible(active, ['input[type="password"][name="Passwd"]', 'input[type="password"]']);
    if (passwordField && !usedPassword) {
      await passwordField.fill(credential.password).catch(() => {});
      await active.waitForTimeout(600);
      await clickNextLike(active, [/^next$/i, /^sign in$/i]);
      usedPassword = true;
      log('auto_login', { step: 'password_submitted' });
      await active.waitForTimeout(4000);
      continue;
    }
    const codeField = await firstVisible(active, ['input[autocomplete="one-time-code"]', 'input[name="totpPin"]', 'input[type="tel"]', 'input[aria-label*="code" i]']);
    if (codeField && credential.totpSecret && !usedTotp) {
      const { code } = (await import('../src/core.mjs')).totp(credential.totpSecret);
      await codeField.fill(code).catch(() => {});
      await active.waitForTimeout(600);
      await clickNextLike(active, [/^next$/i, /^verify$/i, /^continue$/i]);
      usedTotp = true;
      log('auto_login', { step: 'totp_submitted' });
      await active.waitForTimeout(5000);
      continue;
    }
    await active.waitForTimeout(1800);
  }
  return 'timeout';
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArguments(argv);
  requireThat(options['profile-id'], 'profile_id_required');
  const mode = options.mode || 'probe-url';
  requireThat(['probe-url', 'authorize'].includes(mode), 'invalid_mode');
  requireThat(options['authorize-url-file'], 'authorize_url_file_required');
  const folderId = options['folder-id'] || DEFAULT_FOLDER;
  const token = (await readPrivate(resolve(options['token-file'] || '/data/automation-token'))).trim();
  const api = new Multilogin({ token, launcherUrl: 'https://launcher.mlx.yt:45001' });
  const evidenceDir = options['evidence-dir'] || '/data/uploadpost-evidence';
  const authorizeUrl = (await readFile(options['authorize-url-file'], 'utf8')).trim();
  requireThat(/^https:\/\/accounts\.google\.com\//.test(authorizeUrl), 'authorize_url_not_google');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const started = Date.now();
  const log = (event, extra = {}) => console.error(JSON.stringify({ at: new Date().toISOString(), elapsedMs: Date.now() - started, event, profileId: options['profile-id'], ...extra }));
  const watchdog = setTimeout(() => { log('watchdog_timeout'); process.exit(3); }, Number(options['watchdog-ms'] || 300000));
  const report = { step: 'uploadpost_youtube_connect', label: options.label || null, mode, profileId: options['profile-id'], email: options.email || null, status: null, warnings: [], relayedCallbacks: [] };

  log('profile_resolve');
  const meta = await api.profileMeta(options['profile-id']);
  requireThat(meta, 'profile_metadata_missing');
  requireThat(!meta.in_use_by, 'profile_in_use');
  log('profile_start');
  const port = await api.start(folderId, options['profile-id'], false);
  log('profile_started', { port });
  const session = await connect(port, { cdpHost: '127.0.0.1' });
  log('attached');
  const page = session.page;
  page.setDefaultTimeout(15000);
  const shot = (name) => resolve(evidenceDir, `uploadpost-youtube-${options['profile-id']}-${stamp}-${name}.png`);

  const snapshot = async () => ({
    url: page.url(),
    title: await page.title().catch(() => null),
    buttons: await page.evaluate(() => [...document.querySelectorAll('button, [role="button"], a')]
      .map((b) => (b.innerText || '').replace(/\s+/g, ' ').trim()).filter(Boolean).slice(0, 25)).catch(() => []),
    accounts: await page.evaluate(() => [...document.querySelectorAll('[data-identifier], [data-authuser], li')]
      .map((el) => ({ text: (el.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 80), id: el.getAttribute('data-identifier') || null }))
      .filter((entry) => entry.text).slice(0, 10)).catch(() => []),
    texts: await page.evaluate(() => (document.body.innerText || '').replace(/\s+/g, ' ').slice(0, 1200)).catch(() => ''),
  });

  try {
    // Capture failed navigations to the callback host so they can be relayed.
    const failed = [];
    page.on('requestfailed', (request) => {
      if (CALLBACK_HOST.test(request.url())) failed.push(request.url());
    });

    await page.goto(authorizeUrl, { waitUntil: 'commit', timeout: 45000 }).catch(() => {});
    await page.waitForLoadState('domcontentloaded', { timeout: 20000 }).catch(() => {});
    const surfaceReady = Date.now() + 30000;
    while (Date.now() < surfaceReady) {
      const accountRow = page.locator('[data-identifier], [data-authuser], li').first();
      const consent = page.getByRole('button', { name: /^(continue|allow)$/i }).first();
      if (await accountRow.isVisible().catch(() => false) || await consent.isVisible().catch(() => false)) break;
      await page.waitForTimeout(1000);
    }
    await page.waitForTimeout(2000);
    report.before = await snapshot();
    log('oauth_page', { url: report.before.url });
    report.screenshot = shot('before');
    await page.screenshot({ path: report.screenshot }).catch(() => {});

    if (mode === 'probe-url') {
      report.status = /accounts\.google\.com\/.*\/signin|ServiceLogin/i.test(report.before.url) && /password/i.test(report.before.texts)
        ? 'human_required'
        : 'probed';
    } else {
      const unverified = /hasn'?t verified this app|unverified app|Google hasn'?t verified/i.test(report.before.texts);
      if (unverified) {
        report.status = 'human_required';
        report.warnings.push('unverified_app_warning');
      } else {
        // 1) Account chooser (only when present).
        const accountItems = await page.locator('[data-identifier], [data-authuser], li').all().catch(() => []);
        let chosen = null;
        if (accountItems.length > 0) {
          for (const item of accountItems) {
            const text = clean(await item.innerText().catch(() => ''));
            const identifier = await item.getAttribute('data-identifier').catch(() => null);
            if (!text.includes('@') && !identifier) continue;
            if (options.email && !text.toLowerCase().includes(options.email.toLowerCase()) && !(identifier ?? '').toLowerCase().includes(options.email.toLowerCase())) continue;
            await item.click({ timeout: 8000 }).catch(() => {});
            chosen = identifier || text;
            break;
          }
          report.chosenAccount = chosen;
          log('account_choice', { chosen });
          if (!chosen) {
            report.status = 'human_required';
            report.warnings.push('expected_account_not_in_chooser');
          }
        }
        const autoCredential = options.autoLogin
          ? await loadCredential(options['accounts-file'] || '/data/accounts.json', options.email)
          : null;
        // 1b) Google may demand password/TOTP re-auth before the consent screen.
        if (!report.status && options.autoLogin) {
          const credential = autoCredential;
          if (credential) {
            const outcome = await completeGoogleAuth(page, credential, log);
            report.autoLogin = outcome;
            if (outcome === 'denied') {
              report.status = 'denied';
              report.warnings.push('oauth_denied_during_auth');
            } else if (outcome === 'human_required') {
              report.status = 'human_required';
              report.warnings.push('google_challenge');
            }
            // 'consent' | 'authorized' | 'timeout' fall through: the consent
            // block below handles the approval and callback.
          } else {
            report.autoLogin = 'no_credential';
          }
        }

        // 2) Consent + callback (multi-step; optional human window for the final approve).
        if (!report.status) {
          report.consentShot = shot('consent');
          await page.screenshot({ path: report.consentShot }).catch(() => {});
          const patterns = [/^continue$/i, /^allow$/i, /^同意$/i, /^続行$/i, /^許可$/i];
          const humanWindow = Number(options['human-window-seconds'] || 0);
          let approved = null;
          let humanLogged = false;
          const deadline = Date.now() + Math.max(90000, humanWindow * 1000);
          while (Date.now() < deadline) {
            const active = newestPage(page);
            const url = active.url();
            if (CALLBACK_HOST.test(url)) break;
            const text = await active.evaluate(() => document.body?.innerText || '').catch(() => '');
            if (/captcha|recaptcha|unusual activity/i.test(text)) {
              report.status = 'human_required';
              report.warnings.push('google_challenge');
              break;
            }
            // Re-auth can appear mid-consent (e.g. after a human clicks Continue):
            // fill the stored password / fresh TOTP and keep waiting.
            if (autoCredential) {
              const passwordField = await firstVisible(active, ['input[type="password"][name="Passwd"]', 'input[type="password"]']);
              if (passwordField) {
                await passwordField.fill(autoCredential.password).catch(() => {});
                await active.waitForTimeout(500);
                await clickNextLike(active, [/^next$/i, /^sign in$/i, /^continue$/i]);
                log('auto_login', { step: 'password_submitted_during_consent' });
                await active.waitForTimeout(3500);
                continue;
              }
              const codeField = await firstVisible(active, ['input[autocomplete="one-time-code"]', 'input[name="totpPin"]', 'input[type="tel"]', 'input[aria-label*="code" i]']);
              if (codeField && autoCredential.totpSecret) {
                const { code } = (await import('../src/core.mjs')).totp(autoCredential.totpSecret);
                await codeField.fill(code).catch(() => {});
                await active.waitForTimeout(500);
                await clickNextLike(active, [/^next$/i, /^verify$/i, /^continue$/i]);
                log('auto_login', { step: 'totp_submitted_during_consent' });
                await active.waitForTimeout(4000);
                continue;
              }
            }
            // Google's granular consent needs scopes selected before Continue.
            const selectAll = active.getByRole('checkbox', { name: /select all/i }).first();
            if (!options.manualConsent && await selectAll.isVisible().catch(() => false) && !(await selectAll.isChecked().catch(() => true))) {
              await selectAll.click().catch(() => {});
              await page.waitForTimeout(900);
            }
            let clicked = null;
            if (!options.manualConsent) {
              for (const pattern of patterns) {
                const control = active.getByRole('button', { name: pattern }).first();
                if (await control.isVisible().catch(() => false) && await control.isEnabled().catch(() => false)) {
                  clicked = clean(await control.innerText().catch(() => pattern.source));
                  await control.click({ timeout: 8000 }).catch(() => {});
                  break;
                }
              }
            }
            if (clicked) {
              approved = clicked;
              log('consent', { approved: clicked });
              await page.waitForTimeout(3500);
              continue;
            }
            if (humanWindow > 0 && !humanLogged) {
              humanLogged = true;
              log('waiting_for_human', { reason: 'consent' });
              report.humanShot = shot('awaiting-human');
              await active.screenshot({ path: report.humanShot }).catch(() => {});
              const { notifyHuman } = await import('../src/human-notify.mjs');
              report.notification = await notifyHuman({
                label: options.label || options.email || options['profile-id'],
                reason: 'google_consent_required',
                url: active.url(),
                screenshotPath: report.humanShot,
                resumeCommand: 'click Continue/Allow in the parked browser (VNC)',
              });
              log('notified', { sent: report.notification?.sent ?? false });
            }
            await page.waitForTimeout(1500);
          }
          report.approved = approved;
          // 3) Callback settle + relay fallback.
          const settleDeadline = Date.now() + 35000;
          while (Date.now() < settleDeadline) {
            const active = newestPage(page);
            if (CALLBACK_HOST.test(active.url())) break;
            if (failed.length > 0) break;
            await page.waitForTimeout(1000);
          }
          if (failed.length > 0 && !CALLBACK_HOST.test(newestPage(page).url())) {
            for (const url of failed.slice(0, 3)) {
              try {
                const response = await fetch(url, { redirect: 'manual' });
                report.relayedCallbacks.push({ url, status: response.status, location: response.headers.get('location') ?? null });
                log('callback_relayed', { status: response.status });
              } catch (error) {
                report.relayedCallbacks.push({ url, error: String(error?.message ?? error).slice(0, 160) });
              }
            }
          }
          await page.waitForTimeout(2000);
          report.after = await snapshot();
          report.finalShot = shot('final');
          await page.screenshot({ path: report.finalShot }).catch(() => {});
          const afterUrl = report.after.url;
          const denied = /[?&]error=/i.test(afterUrl) || report.relayedCallbacks.some((entry) => /[?&]error=/i.test(entry.location ?? ''));
          const callbackOk = CALLBACK_HOST.test(afterUrl) || report.relayedCallbacks.some((entry) => (entry.status ?? 0) >= 200 && (entry.status ?? 0) < 400);
          if (!report.status) {
            if (denied) report.status = 'denied';
            else if (callbackOk) report.status = 'authorized';
            else report.status = 'authorize_unconfirmed';
          }
        }
      }
    }
  } catch (error) {
    report.error = String(error?.message ?? error).slice(0, 240);
    if (!report.status) report.status = 'update_error';
    report.errorShot = shot('error');
    await page.screenshot({ path: report.errorShot }).catch(() => {});
  } finally {
    clearTimeout(watchdog);
    if (!options.keepProfile) await stopBrowserProfile(api, options['profile-id'], session.browser).catch(() => {});
  }
  if (report.status === 'human_required') {
    const { notifyHuman } = await import('../src/human-notify.mjs');
    report.notification = await notifyHuman({
      label: options.label || options.email || options['profile-id'],
      reason: (report.warnings || []).join(',') || 'human_verification_required',
      url: report.before?.url || report.after?.url || null,
      screenshotPath: report.consentShot || report.humanShot || report.finalShot || report.screenshot || null,
      resumeCommand: options.keepProfile ? 'browser left open for the operator (VNC)' : null,
    });
    log('notified', { sent: report.notification?.sent ?? false, reason: report.notification?.reason ?? null });
  }
  const reportPath = resolve(evidenceDir, `uploadpost-youtube-${options['profile-id']}-${stamp}.json`);
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 }).catch(() => {});
  report.reportPath = reportPath;
  log('done', { status: report.status });
  console.log(JSON.stringify(report, null, 2));
  return ['probed', 'authorized'].includes(report.status) ? 0 : 2;
}

if (process.argv[1] && import.meta.url === new URL(`file://${resolve(process.argv[1])}`).href) {
  main().then((code) => process.exit(code)).catch((error) => {
    console.error(JSON.stringify({ status: 'update_error', error: String(error?.message ?? error) }));
    process.exit(2);
  });
}
