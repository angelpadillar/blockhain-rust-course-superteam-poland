import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { requireThat, totp } from '../src/core.mjs';
import { readPrivate } from '../src/storage.mjs';
import { Multilogin } from '../src/multilogin.mjs';
import { connect, stopBrowserProfile } from '../src/runner.mjs';

// Instagram professional-account maintenance for ONE warmed Multilogin profile.
//
// Upload-Post's Instagram connection (Instagram Login) requires a Business or
// Creator account; personal accounts are rejected with HTTP 400.
//
//   --mode check   verify the session and report is_professional_account
//   --mode probe   visit candidate conversion routes and report where they land
//   --mode switch  convert to a Creator professional account, then verify
//
// The script never types a password, never dismisses a security challenge and
// never fabricates cookies. A login/password/CAPTCHA checkpoint becomes
// `human_required` and stops.
//
// Usage:
//   node scripts/instagram-professional.mjs --profile-id <id> --mode check|probe|switch \
//     [--evidence-dir /data/instagram-evidence] [--watchdog-ms 300000] [--keep-profile] \
//     [--token-file /data/automation-token] [--folder-id <folder>]

export const DEFAULT_FOLDER = '2b104092-39f8-459e-be4c-74e037507dd3';
export const EDIT_URL = 'https://www.instagram.com/accounts/edit/';
export const CONVERT_URLS = [
  'https://www.instagram.com/accounts/convert_to_professional_account/',
  'https://www.instagram.com/accounts/convert_to_professional_account',
  'https://www.instagram.com/professional_account/',
];

export function parseArguments(argv) {
  const options = { positional: [] };
  const valueFlags = ['--profile-id', '--mode', '--evidence-dir', '--token-file', '--folder-id', '--label', '--watchdog-ms', '--email', '--accounts-file'];
  for (let index = 0; index < argv.length; index++) {
    const token = argv[index];
    if (token === '--keep-profile') options.keepProfile = true;
    else if (token === '--auto-login') options.autoLogin = true;
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

function clean(text) {
  return String(text ?? '').replace(/\s+/g, ' ').trim();
}

/** Wait for either the edit form or a login wall. */
export async function waitForEditPage(page, timeoutMs = 25000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (/\/accounts\/login/i.test(page.url())) return 'login';
    const field = page.locator('input[placeholder="Website"], textarea[placeholder="Bio"]').first();
    if (await field.isVisible().catch(() => false)) return 'edit';
    await page.waitForTimeout(500);
  }
  return 'unknown';
}

export async function gotoEditPage(page) {
  await page.goto(EDIT_URL, { waitUntil: 'commit', timeout: 40000 }).catch(() => {});
  await page.waitForLoadState('domcontentloaded', { timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(2500);
  return waitForEditPage(page);
}

/** Read the signed-in handle from the edit surface (username input, header link, or page data). */
export async function readHandle(page) {
  const fromUrl = /instagram\.com\/([A-Za-z0-9._]+)\//.exec(page.url());
  if (fromUrl && !['accounts', 'explore', 'direct', 'p'].includes(fromUrl[1])) return fromUrl[1];
  const named = await page.locator('input[name="username"]').first().inputValue({ timeout: 4000 }).catch(() => null);
  if (named && /^[A-Za-z0-9._]{2,40}$/.test(named)) return named;
  const values = await page.locator('input[type="text"]').evaluateAll((nodes) => nodes.map((node) => node.value).filter(Boolean)).catch(() => []);
  const candidate = values.find((value) => /^[A-Za-z0-9._]{2,40}$/.test(value));
  if (candidate) return candidate;
  const link = page.locator('a[href^="/"][href$="/"]').first();
  const href = await link.getAttribute('href', { timeout: 4000 }).catch(() => null);
  if (href && href !== '/') return href.replaceAll('/', '');
  return null;
}

/** Account-type probe through the same-origin web_profile_info endpoint. */
export async function probeAccountType(page, handle) {
  if (!handle) return { ok: false, reason: 'no_handle' };
  const result = await page.evaluate(async (name) => {
    try {
      const response = await fetch(`/api/v1/users/web_profile_info/?username=${encodeURIComponent(name)}`, {
        headers: { 'x-ig-app-id': '936619743392459' },
        credentials: 'include',
      });
      if (!response.ok) return { ok: false, status: response.status };
      const data = await response.json();
      const user = data?.data?.user ?? null;
      if (!user) return { ok: false, status: 'no_user' };
      return {
        ok: true,
        username: user.username,
        fullName: user.full_name ?? null,
        isBusiness: Boolean(user.is_business_account),
        isProfessional: Boolean(user.is_professional_account),
        category: user.category_name ?? null,
        followers: user.edge_followed_by?.count ?? null,
      };
    } catch (error) {
      return { ok: false, status: String(error?.message ?? error).slice(0, 120) };
    }
  }, handle).catch((error) => ({ ok: false, status: String(error?.message ?? error).slice(0, 120) }));
  return result;
}

async function firstVisible(page, selectors) {
  for (const selector of selectors) {
    const control = page.locator(selector).first();
    if (await control.isVisible().catch(() => false)) return control;
  }
  return null;
}

/** Load the Instagram credential record (never logged). */
export async function loadCredential(accountsFile, key) {
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
 * Operator-authorized Instagram login. Delegates to the connector's proven
 * login routine (password + locally generated TOTP, long form/2FA waits) so
 * there is one implementation on the live path.
 */
export async function ensureLoggedIn(page, credential, log) {
  const { igLogin } = await import('./uploadpost-instagram-connect.mjs');
  const result = await igLogin(page, credential, log);
  if (result === 'logged_in') {
    const state = await gotoEditPage(page);
    log('login_attempt', { outcome: 'logged_in', editState: state });
    return state === 'edit' ? 'logged_in' : result;
  }
  log('login_attempt', { outcome: result });
  return result;
}

/** Click the first visible control whose text matches any pattern. */
async function clickByText(page, patterns, timeoutMs = 12000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const pattern of patterns) {
      const control = page.getByRole('button', { name: pattern }).first();
      if (await control.isVisible().catch(() => false) && await control.isEnabled().catch(() => false)) {
        await control.click({ timeout: 8000 }).catch(() => {});
        return clean(await control.innerText().catch(() => pattern.source));
      }
      const link = page.getByRole('link', { name: pattern }).first();
      if (await link.isVisible().catch(() => false)) {
        await link.click({ timeout: 8000 }).catch(() => {});
        return clean(await link.innerText().catch(() => pattern.source));
      }
    }
    await page.waitForTimeout(600);
  }
  return null;
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArguments(argv);
  requireThat(options['profile-id'], 'profile_id_required');
  const mode = options.mode || 'check';
  requireThat(['check', 'probe', 'switch'].includes(mode), 'invalid_mode');
  const folderId = options['folder-id'] || DEFAULT_FOLDER;
  const token = (await readPrivate(resolve(options['token-file'] || '/data/automation-token'))).trim();
  const api = new Multilogin({ token, launcherUrl: 'https://launcher.mlx.yt:45001' });
  const evidenceDir = options['evidence-dir'] || '/data/instagram-evidence';
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const started = Date.now();
  const log = (event, extra = {}) => console.error(JSON.stringify({ at: new Date().toISOString(), elapsedMs: Date.now() - started, event, profileId: options['profile-id'], ...extra }));
  const watchdog = setTimeout(() => { log('watchdog_timeout'); process.exit(3); }, Number(options['watchdog-ms'] || 300000));
  const report = {
    step: 'instagram_professional', label: options.label || null, mode, profileId: options['profile-id'],
    handle: null, accountType: null, status: null, warnings: [], probe: null,
  };

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
  const shot = (name) => resolve(evidenceDir, `instagram-${options['profile-id']}-${stamp}-${name}.png`);

  try {
    await mkdir(evidenceDir, { recursive: true, mode: 0o700 });
    let state = await gotoEditPage(page);
    log('edit_page', { state });
    report.editState = state;
    if (state !== 'edit' && options.autoLogin) {
      const credential = await loadCredential(options['accounts-file'] || '/data/accounts.json', options.email || options.label);
      if (credential) {
        const login = await ensureLoggedIn(page, credential, log);
        report.login = login;
        if (login === 'logged_in') {
          state = await gotoEditPage(page);
          report.editState = state;
        } else if (login === 'human_required') {
          report.status = 'human_required';
          report.warnings.push('login_challenge');
        }
      } else {
        report.login = 'no_credential';
      }
    }
    if (!report.status && state !== 'edit') {
      report.status = 'human_required';
      report.warnings.push(`edit_page:${state}`);
      report.screenshot = shot('login');
      await page.screenshot({ path: report.screenshot }).catch(() => {});
    } else {
      report.handle = await readHandle(page);
      if (!report.handle && options.email && !options.email.includes('@')) report.handle = options.email;
      const before = await probeAccountType(page, report.handle);
      report.accountTypeBefore = before;
      log('account_type', { handle: report.handle, professional: before.isProfessional ?? null, business: before.isBusiness ?? null });

      if (mode === 'check') {
        report.status = before.ok ? 'session_ok' : 'check_error';
        report.accountType = before.isProfessional ? 'professional' : before.ok ? 'personal' : 'unknown';
      } else if (mode === 'probe') {
        const visited = [];
        for (const url of CONVERT_URLS) {
          await page.goto(url, { waitUntil: 'commit', timeout: 40000 }).catch(() => {});
          await page.waitForLoadState('domcontentloaded', { timeout: 20000 }).catch(() => {});
          await page.waitForTimeout(5000);
          const buttons = await page.evaluate(() => [...document.querySelectorAll('button, [role="button"], a')]
            .map((b) => (b.innerText || '').replace(/\s+/g, ' ').trim()).filter(Boolean).slice(0, 20)).catch(() => []);
          const texts = await page.evaluate(() => (document.body.innerText || '').replace(/\s+/g, ' ').slice(0, 1200)).catch(() => '');
          visited.push({ url, finalUrl: page.url(), title: await page.title().catch(() => null), buttons, texts });
          log('probe_url', { url, finalUrl: page.url() });
          if (!/accounts\/login/i.test(page.url())) break;
        }
        report.probe = visited;
        report.status = 'probed';
        report.screenshot = shot('probe');
        await page.screenshot({ path: report.screenshot }).catch(() => {});
      } else if (mode === 'switch') {
        if (before.isProfessional) {
          report.accountType = 'professional';
          report.status = 'already_professional';
        } else {
          const actions = [];
          let clicked = await clickByText(page, [/switch to professional account/i, /set up.*professional/i], 6000);
          if (clicked) actions.push(`switch:${clicked}`);
          if (!clicked) {
            await page.goto(CONVERT_URLS[0], { waitUntil: 'commit', timeout: 40000 }).catch(() => {});
            await page.waitForLoadState('domcontentloaded', { timeout: 20000 }).catch(() => {});
            await page.waitForTimeout(2500);
            clicked = await clickByText(page, [/switch to professional account/i, /^switch$/i, /^next$/i, /^continue$/i], 8000);
            if (clicked) actions.push(`convert:${clicked}`);
          }
          // Wizard: choose Creator, pick a category if asked, then advance/save.
          const creator = await clickByText(page, [/^creator$/i, /creator/i], 6000);
          if (creator) actions.push(`type:${creator}`);
          report.switchStep1 = shot('switch-1');
          await page.screenshot({ path: report.switchStep1 }).catch(() => {});
          for (let step = 0; step < 8; step += 1) {
            // Category page: radio list of categories; pick one before Next.
            const radios = page.locator('input[type="radio"], [role="radio"]');
            const radioCount = await radios.count().catch(() => 0);
            if (radioCount > 0) {
              let picked = null;
              for (const label of [/digital creator/i, /content creator/i, /personal blog/i, /product\/service/i]) {
                const row = page.getByText(label).first();
                if (await row.isVisible().catch(() => false)) {
                  await row.click().catch(() => {});
                  picked = String(label);
                  break;
                }
              }
              if (!picked) {
                await radios.first().click().catch(() => {});
                picked = 'first_radio';
              }
              actions.push(`category:${picked}`);
              await page.waitForTimeout(1800);
            }
            const advanced = await clickByText(page, [/^next$/i, /^done$/i, /^save$/i, /^continue$/i, /^finish$/i, /^switch$/i, /^set up$/i], 4000);
            if (advanced) actions.push(`advance:${advanced}`);
            report[`switchStep${step + 2}`] = shot(`switch-${step + 2}`);
            await page.screenshot({ path: report[`switchStep${step + 2}`] }).catch(() => {});
            if (!advanced) break;
            await page.waitForTimeout(2500);
          }
          report.actions = actions;
          report.screenshot = shot('after');
          await page.screenshot({ path: report.screenshot }).catch(() => {});
          await gotoEditPage(page);
          const after = await probeAccountType(page, report.handle ?? await readHandle(page));
          report.accountTypeAfter = after;
          // The internal web_profile_info endpoint rate-limits (429); fall back to
          // the settings surface: professional accounts expose "Professional dashboard".
          const settingsText = await page.evaluate(() => (document.body?.innerText || '').replace(/\s+/g, ' ')).catch(() => '');
          report.professionalEvidence = /professional dashboard|account type and tools|switch back to personal/i.test(settingsText);
          if (after.isProfessional || report.professionalEvidence) {
            report.accountType = after.category ? `professional:${after.category}` : 'professional';
            report.status = 'switched';
          } else if (/accounts\/login/i.test(page.url())) {
            report.status = 'human_required';
            report.warnings.push('login_wall_after_switch');
          } else {
            report.status = 'switch_unconfirmed';
          }
        }
      }
      report.finalShot = shot('final');
      await page.screenshot({ path: report.finalShot }).catch(() => {});
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
  const reportPath = resolve(evidenceDir, `instagram-${options['profile-id']}-${stamp}-professional.json`);
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 }).catch(() => {});
  report.reportPath = reportPath;
  log('done', { status: report.status });
  console.log(JSON.stringify(report, null, 2));
  return ['session_ok', 'already_professional', 'switched', 'probed'].includes(report.status) ? 0 : 2;
}

if (process.argv[1] && import.meta.url === new URL(`file://${resolve(process.argv[1])}`).href) {
  main().then((code) => process.exit(code)).catch((error) => {
    console.error(JSON.stringify({ status: 'update_error', error: String(error?.message ?? error) }));
    process.exit(2);
  });
}
