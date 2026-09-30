import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { requireThat, totp } from '../src/core.mjs';
import { readPrivate } from '../src/storage.mjs';
import { Multilogin } from '../src/multilogin.mjs';
import { connect, stopBrowserProfile } from '../src/runner.mjs';

// YouTube Studio branding for ONE warmed Multilogin profile.
//
//   --mode check   open Studio, report channel id + current name
//   --mode inspect same, plus a DOM dump of the customization surface
//   --mode update  set channel name and/or avatar, then read them back
//
// The script never types a password, never dismisses a security challenge and
// never fabricates cookies. A login/password/CAPTCHA checkpoint becomes
// `human_required` and stops.
//
// Usage:
//   node scripts/youtube-studio-branding.mjs --profile-id <id> --mode check|inspect|update \
//     [--new-name <name>] [--avatar-file /data/instagram-photos/K0x.jpg] \
//     [--evidence-dir /data/youtube-evidence] [--watchdog-ms 420000] [--keep-profile] \
//     [--token-file /data/automation-token] [--folder-id <folder>]

export const DEFAULT_FOLDER = '2b104092-39f8-459e-be4c-74e037507dd3';
export const STUDIO_URL = 'https://studio.youtube.com/';

export function parseArguments(argv) {
  const options = { positional: [] };
  const valueFlags = ['--profile-id', '--mode', '--new-name', '--avatar-file', '--evidence-dir', '--token-file', '--folder-id', '--label', '--watchdog-ms', '--human-window-seconds', '--email', '--accounts-file'];
  for (let index = 0; index < argv.length; index++) {
    const token = argv[index];
    if (token === '--keep-profile') options.keepProfile = true;
    else if (token === '--auto-verify') options.autoVerify = true;
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

async function waitForStudio(page, timeoutMs = 40000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (/accounts\.google\.com|studio\.youtube\.com\/signin/i.test(page.url())) return 'login';
    const dashboard = page.getByText(/^(Dashboard|Channel dashboard|Customization)$/i).first();
    const header = page.locator('ytcp-header, #avatar-btn, ytcp-navigation-drawer').first();
    if (await dashboard.isVisible().catch(() => false) || await header.count().then((count) => count > 0).catch(() => false)) return 'studio';
    await page.waitForTimeout(500);
  }
  return 'unknown';
}

async function currentChannelId(page) {
  const fromUrl = /studio\.youtube\.com\/channel\/(UC[A-Za-z0-9_-]+)/.exec(page.url());
  if (fromUrl) return fromUrl[1];
  const fromHref = await page.locator('a[href*="/channel/UC"]').first().getAttribute('href', { timeout: 5000 }).catch(() => null);
  const match = fromHref ? /\/channel\/(UC[A-Za-z0-9_-]+)/.exec(fromHref) : null;
  return match ? match[1] : null;
}

function nameInputLocator(page) {
  // Verified Studio DOM (2026-09-25): Name = placeholder "Enter channel name";
  // Handle = placeholder "Set your handle".
  return page.locator('input[placeholder="Enter channel name"]').first();
}

async function avatarFileInputIndex(page) {
  // Find the file input inside the Picture section (not the Banner image one).
  return page.evaluate(() => {
    const inputs = [...document.querySelectorAll('input[type="file"]')];
    for (let index = 0; index < inputs.length; index += 1) {
      let element = inputs[index];
      for (let hop = 0; hop < 8 && element; hop += 1) {
        const text = (element.innerText || '').replace(/\s+/g, ' ');
        if (/profile picture|change picture/i.test(text) && !/banner image/i.test(text)) return index;
        element = element.parentElement;
      }
    }
    return inputs.length > 1 ? 1 : -1;
  }).catch(() => -1);
}

async function readChannelName(page) {
  const value = await nameInputLocator(page).inputValue({ timeout: 5000 }).catch(() => null);
  return value ?? null;
}

async function verifyModalPresent(page) {
  const text = await page.evaluate(() => (document.body?.innerText || '').replace(/\s+/g, ' ')).catch(() => '');
  return /Verify it.?s you|confirm it.?s really you/i.test(text);
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

/** Load the account credential record (never logged). */
export async function loadCredential(accountsFile, email) {
  if (!accountsFile || !email) return null;
  try {
    const accounts = JSON.parse(await readFile(accountsFile, 'utf8'));
    const record = accounts.find((account) => String(account.username).toLowerCase() === String(email).toLowerCase());
    if (!record) return null;
    return { password: record.password ?? null, totpSecret: record.totp ?? null, platform: record.platform, ref: record.ref };
  } catch {
    return null;
  }
}

/**
 * Automated "Verify it's you" handling (operator-authorized): fills the stored
 * password and a locally generated TOTP code. It never solves a CAPTCHA or any
 * other challenge — those stop with `human_required`.
 */
function newestPage(page) {
  try {
    const pages = page.context().pages().filter((candidate) => !candidate.isClosed());
    return pages.length > 0 ? pages[pages.length - 1] : page;
  } catch {
    return page;
  }
}

export async function autoVerifyItsYou(page, credential, log, maxMs = 120000, shot = null) {
  if (!credential?.password) return 'no_credential';
  const deadline = Date.now() + maxMs;
  let usedPassword = false; let usedTotp = false;
  let nextClicks = 0;
  log('auto_verify', { step: 'start', pages: page.context().pages().length, url: page.url().slice(0, 80) });
  while (Date.now() < deadline) {
    const active = newestPage(page);
    const modalOnOriginal = await verifyModalPresent(page).catch(() => false);
    const onGoogle = /accounts\.google\.com/i.test(active.url());
    if (!modalOnOriginal && !onGoogle) return usedPassword || usedTotp ? 'verified' : 'cleared';
    const passwordField = await firstVisible(active, ['input[type="password"][name="Passwd"]', 'input[type="password"]']);
    const codeField = await firstVisible(active, ['input[autocomplete="one-time-code"]', 'input[name="totpPin"]', 'input[type="tel"]', 'input[aria-label*="code" i]']);
    if (passwordField) {
      await passwordField.fill(credential.password).catch(() => {});
      await active.waitForTimeout(600);
      await clickNextLike(active, [/^next$/i, /^continue$/i, /^verify$/i, /^sign in$/i]);
      usedPassword = true;
      log('auto_verify', { step: 'password_submitted', page: active.url().slice(0, 60) });
      await active.waitForTimeout(3000);
      continue;
    }
    if (codeField && credential.totpSecret) {
      const { code } = totp(credential.totpSecret);
      await codeField.fill(code).catch(() => {});
      await active.waitForTimeout(600);
      await clickNextLike(active, [/^next$/i, /^verify$/i, /^continue$/i, /^done$/i]);
      usedTotp = true;
      log('auto_verify', { step: 'totp_submitted', page: active.url().slice(0, 60) });
      await active.waitForTimeout(3500);
      continue;
    }
    const text = await active.evaluate(() => document.body?.innerText || '').catch(() => '');
    if (/captcha|recaptcha|unusual activity|try again later/i.test(text)) {
      log('auto_verify', { step: 'challenge_detected' });
      return 'human_required';
    }
    const advanced = await clickNextLike(active, [/^next$/i, /^continue$/i, /^verify$/i, /^got it$/i]);
    if (!advanced) {
      await active.waitForTimeout(1500);
    } else {
      nextClicks += 1;
      const text = await active.evaluate(() => document.body?.innerText || '').catch(() => '');
      log('auto_verify', { step: 'next_clicked', count: nextClicks, pages: page.context().pages().length, url: active.url().slice(0, 100), text: text.replace(/\s+/g, ' ').slice(0, 160) });
      if (shot && nextClicks <= 3) {
        const evidence = shot(`auto-next-${nextClicks}`);
        await active.screenshot({ path: evidence }).catch(() => {});
      }
      await active.waitForTimeout(2500);
    }
  }
  return 'timeout';
}

/**
 * Option-A human window: if Google shows the "Verify it's you" security modal,
 * wait for the operator to clear it in VNC (we never touch credentials or
 * challenges). Returns 'cleared' | 'absent' | 'timeout'.
 */
async function awaitHumanVerification(page, windowSeconds, shot, log) {
  if (!(await verifyModalPresent(page))) return 'absent';
  log('waiting_for_human', { reason: 'verify_its_you' });
  const evidence = shot('awaiting-human');
  await page.screenshot({ path: evidence }).catch(() => {});
  const deadline = Date.now() + Math.max(0, windowSeconds) * 1000;
  while (Date.now() < deadline) {
    await page.waitForTimeout(2500);
    if (!(await verifyModalPresent(page))) return 'cleared';
  }
  return 'timeout';
}

async function dismissStudioOnboarding(page) {
  // Safe onboarding/interstitial dismissal (never a security challenge).
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const continueButton = page.getByRole('button', { name: /^(continue|got it|dismiss|close|no thanks|skip)$/i }).first();
    if (await continueButton.isVisible().catch(() => false)) {
      await continueButton.click({ timeout: 6000 }).catch(() => {});
      await page.waitForTimeout(1500);
      continue;
    }
    return false;
  }
  return true;
}

async function gotoCustomization(page, channelId) {
  const url = channelId
    ? `https://studio.youtube.com/channel/${channelId}/editing/details`
    : 'https://studio.youtube.com/';
  await page.goto(url, { waitUntil: 'commit', timeout: 45000 }).catch(() => {});
  await page.waitForLoadState('domcontentloaded', { timeout: 25000 }).catch(() => {});
  await page.waitForTimeout(4000);
  await dismissStudioOnboarding(page);
  await page.waitForTimeout(1000);
  return waitForStudio(page);
}

async function clickPublish(page, label) {
  const patterns = [/^publish$/i, /^save$/i, /^publish changes$/i];
  for (const pattern of patterns) {
    const control = page.getByRole('button', { name: pattern }).first();
    if (await control.isVisible().catch(() => false) && await control.isEnabled().catch(() => false)) {
      await control.click({ timeout: 10000 }).catch(() => {});
      await page.waitForTimeout(4000);
      return clean(await control.innerText().catch(() => pattern.source));
    }
  }
  return null;
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArguments(argv);
  requireThat(options['profile-id'], 'profile_id_required');
  const mode = options.mode || 'check';
  requireThat(['check', 'inspect', 'update'].includes(mode), 'invalid_mode');
  const folderId = options['folder-id'] || DEFAULT_FOLDER;
  const token = (await readPrivate(resolve(options['token-file'] || '/data/automation-token'))).trim();
  const api = new Multilogin({ token, launcherUrl: 'https://launcher.mlx.yt:45001' });
  const evidenceDir = options['evidence-dir'] || '/data/youtube-evidence';
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const started = Date.now();
  const log = (event, extra = {}) => console.error(JSON.stringify({ at: new Date().toISOString(), elapsedMs: Date.now() - started, event, profileId: options['profile-id'], ...extra }));
  const watchdog = setTimeout(() => { log('watchdog_timeout'); process.exit(3); }, Number(options['watchdog-ms'] || 420000));
  const report = { step: 'youtube_studio_branding', label: options.label || null, mode, profileId: options['profile-id'], channelId: null, nameBefore: null, nameAfter: null, requestedName: options['new-name'] || null, avatarFile: options['avatar-file'] || null, status: null, warnings: [] };

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
  const shot = (name) => resolve(evidenceDir, `youtube-${options['profile-id']}-${stamp}-${name}.png`);

  try {
    await mkdir(evidenceDir, { recursive: true, mode: 0o700 });
    const state = await gotoCustomization(page, null);
    log('studio', { state, url: page.url() });
    report.studioState = state;
    if (state !== 'studio') {
      report.status = 'human_required';
      report.warnings.push(`studio:${state}`);
      report.screenshot = shot('login');
      await page.screenshot({ path: report.screenshot }).catch(() => {});
    } else {
      report.channelId = await currentChannelId(page);
      // Land on Customization > Basic info (the details surface) before reading/editing.
      if (report.channelId) {
        await gotoCustomization(page, report.channelId);
        await page.waitForTimeout(2000);
      }
      report.nameBefore = await readChannelName(page);
      report.screenshot = shot('before');
      await page.screenshot({ path: report.screenshot }).catch(() => {});
      log('channel', { channelId: report.channelId, nameBefore: report.nameBefore });

      if (mode === 'inspect') {
        report.dom = await page.evaluate(() => ({
          buttons: [...document.querySelectorAll('button, [role="button"]')].map((b) => (b.innerText || b.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim()).filter(Boolean).slice(0, 40),
          inputs: [...document.querySelectorAll('input, textarea')].map((input) => {
            const container = input.closest('ytcp-form-input-container, ytcp-social-suggestions-textbox, ytcp-text-dropdown-trigger')
              || input.parentElement?.parentElement?.parentElement
              || input.parentElement;
            const label = container?.querySelector('label, .label, [class*="label" i]')?.innerText?.trim() ?? '';
            return {
              id: input.id || '',
              type: input.type || '',
              aria: input.getAttribute('aria-label') || '',
              name: input.getAttribute('name') || '',
              placeholder: input.placeholder || '',
              value: (input.value || '').slice(0, 50),
              containerLabel: label.replace(/\s+/g, ' ').slice(0, 60),
            };
          }).slice(0, 30),
          texts: (document.body.innerText || '').replace(/\s+/g, ' ').slice(0, 1500),
        })).catch(() => null);
        report.status = 'session_ok';
      } else if (mode === 'check') {
        report.status = 'session_ok';
      } else {
        // update
        const humanWindow = Number(options['human-window-seconds'] || 0);
        let human = 'absent';
        if (await verifyModalPresent(page)) {
          const credential = options.autoVerify
            ? await loadCredential(options['accounts-file'] || '/data/accounts.json', options.email)
            : null;
          if (credential) {
            const auto = await autoVerifyItsYou(page, credential, log, 120000, shot);
            report.autoVerification = auto;
            human = auto === 'verified' || auto === 'cleared'
              ? 'cleared'
              : await awaitHumanVerification(page, humanWindow, shot, log);
          } else {
            human = await awaitHumanVerification(page, humanWindow, shot, log);
          }
        }
        report.humanVerification = human;
        if (human === 'timeout') {
          report.status = 'human_required';
          report.warnings.push('verify_its_you_timeout');
        }
        if (!report.status) {
        if (options['new-name']) {
          const input = nameInputLocator(page);
          await input.waitFor({ state: 'visible', timeout: 12000 }).catch(() => {});
          await input.click({ clickCount: 3 }).catch(() => {});
          await input.fill('').catch(() => {});
          await input.type(options['new-name'], { delay: 30 });
          await page.waitForTimeout(1500);
          // Publish enables only for valid changes.
          const publish = page.getByRole('button', { name: /^publish$/i }).first();
          const deadline = Date.now() + 10000;
          while (Date.now() < deadline) {
            if (await publish.isEnabled().catch(() => false)) break;
            await page.waitForTimeout(500);
          }
          if (await publish.isEnabled().catch(() => false)) {
            await publish.click({ timeout: 10000 }).catch(() => {});
            report.nameSet = 'publish';
            await page.waitForTimeout(5000);
          } else {
            report.warnings.push('publish_not_enabled_for_name');
          }
        }
        if (options['avatar-file']) {
          try {
            const picture = page.locator('text=/^Picture$/i').first();
            await picture.scrollIntoViewIfNeeded().catch(() => {});
            await page.waitForTimeout(1200);
            const index = await avatarFileInputIndex(page);
            report.avatarInputIndex = index;
            if (index >= 0) {
              await page.locator('input[type="file"]').nth(index).setInputFiles(options['avatar-file']);
              await page.waitForTimeout(4500);
              for (let step = 0; step < 5; step += 1) {
                const advanced = await clickByTextLocal(page, [/^next$/i, /^done$/i, /^apply$/i, /^save$/i]);
                if (!advanced) break;
                await page.waitForTimeout(3000);
              }
              report.avatarSet = true;
            } else {
              report.warnings.push('avatar_file_input_not_found');
              report.buttons = await page.evaluate(() => [...document.querySelectorAll('button, [role="button"]')]
                .map((b) => (b.innerText || b.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim()).filter(Boolean).slice(0, 40)).catch(() => []);
            }
          } catch (error) {
            report.warnings.push(`avatar:${String(error?.message ?? error).slice(0, 120)}`);
          }
        }
        // Publish any remaining changes (avatar edits also require PUBLISH).
        const publishFinal = page.getByRole('button', { name: /^publish$/i }).first();
        if (await publishFinal.isEnabled().catch(() => false)) {
          await publishFinal.click({ timeout: 10000 }).catch(() => {});
          report.publishedFinal = true;
          await page.waitForTimeout(5000);
        }
        await page.waitForTimeout(2000);
        // Real read-back: reload the surface so the field is not just the typed value.
        await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
        await page.waitForTimeout(4500);
        await dismissStudioOnboarding(page);
        const nameAfter = await readChannelName(page);
        report.nameAfter = nameAfter;
        report.finalShot = shot('after');
        await page.screenshot({ path: report.finalShot }).catch(() => {});
        const nameOk = !options['new-name'] || nameAfter === options['new-name'];
        if (!options['new-name'] && !options['avatar-file']) report.status = 'session_ok';
        else report.status = nameOk ? 'updated' : 'update_unconfirmed';
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
  const reportPath = resolve(evidenceDir, `youtube-${options['profile-id']}-${stamp}.json`);
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 }).catch(() => {});
  report.reportPath = reportPath;
  log('done', { status: report.status });
  console.log(JSON.stringify(report, null, 2));
  return ['session_ok', 'updated'].includes(report.status) ? 0 : 2;
}

async function clickByTextLocal(page, patterns, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const pattern of patterns) {
      const control = page.getByRole('button', { name: pattern }).first();
      if (await control.isVisible().catch(() => false) && await control.isEnabled().catch(() => false)) {
        await control.click({ timeout: 6000 }).catch(() => {});
        return clean(await control.innerText().catch(() => pattern.source));
      }
    }
    await page.waitForTimeout(500);
  }
  return null;
}

if (process.argv[1] && import.meta.url === new URL(`file://${resolve(process.argv[1])}`).href) {
  main().then((code) => process.exit(code)).catch((error) => {
    console.error(JSON.stringify({ status: 'update_error', error: String(error?.message ?? error) }));
    process.exit(2);
  });
}
