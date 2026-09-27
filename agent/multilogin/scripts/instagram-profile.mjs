import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { requireThat, errorCode } from '../src/core.mjs';
import { readPrivate } from '../src/storage.mjs';
import { Multilogin } from '../src/multilogin.mjs';
import { connect, stopBrowserProfile } from '../src/runner.mjs';

// Instagram profile maintenance for ONE warmed Multilogin profile.
//
//   --mode check    verify the session and report the current handle/name
//   --mode inspect  same, plus a DOM dump of the edit surface
//   --mode update   photo + display name + username, then read the fields back
//
// Surfaces (verified 2026-09-25):
//   photo    instagram.com/accounts/edit/  -> "Change photo" -> "Upload Photo"
//   name     accountscenter.instagram.com/profiles/<id>/name/     -> "Done"
//   username accountscenter.instagram.com/profiles/<id>/username/ -> "Done"
// The script never types a password, never dismisses a security challenge and
// never fabricates cookies. A password/CAPTCHA checkpoint becomes
// `human_required` and stops.
//
// Usage:
//   node scripts/instagram-profile.mjs --profile-id <id> --mode check|inspect|update \
//     [--new-username <handle>] [--new-name <display name>] [--photo-file /data/...jpg] \
//     [--evidence-dir /data/instagram-evidence] [--watchdog-ms 300000] [--keep-profile] \
//     [--token-file /data/automation-token] [--folder-id <folder>]

export const DEFAULT_FOLDER = '2b104092-39f8-459e-be4c-74e037507dd3';
export const EDIT_URL = 'https://www.instagram.com/accounts/edit/';
export const AC_PROFILES_URL = 'https://accountscenter.instagram.com/profiles/';

export function parseArguments(argv) {
  const options = { positional: [] };
  const valueFlags = ['--profile-id', '--mode', '--new-username', '--new-name', '--photo-file',
    '--evidence-dir', '--token-file', '--folder-id', '--launcher-url', '--label', '--watchdog-ms'];
  for (let index = 0; index < argv.length; index++) {
    const token = argv[index];
    if (token === '--keep-profile') options.keepProfile = true;
    else if (valueFlags.includes(token)) {
      const value = argv[index + 1];
      requireThat(typeof value === 'string' && !value.startsWith('--'), 'invalid_command_arguments');
      options[token.slice(2)] = value; index++;
    } else if (token.startsWith('--')) throw new Error(`unknown argument ${token}`);
    else options.positional.push(token);
  }
  return options;
}

/** Wait until either the edit form or a login wall is on screen. */
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

async function gotoEditPage(page) {
  await page.goto(EDIT_URL, { waitUntil: 'commit', timeout: 40000 }).catch(error => {
    return String(error?.message || error);
  });
  await page.waitForLoadState('domcontentloaded', { timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(2500);
  return waitForEditPage(page);
}

/** Open the Accounts Center profile detail and return its base URL. */
async function openAccountsCenterProfile(page, timeoutMs = 40000) {
  await page.goto(AC_PROFILES_URL, { waitUntil: 'commit', timeout: timeoutMs }).catch(() => {});
  await page.waitForLoadState('domcontentloaded', { timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(3500);
  const row = page.getByText(/^instagram$/i).first();
  if (await row.isVisible().catch(() => false)) {
    await row.click({ timeout: 8000 }).catch(() => {});
    await page.waitForTimeout(3200);
  }
  const url = page.url();
  const match = /^(https:\/\/accountscenter\.instagram\.com\/profiles\/\d+)\/?$/.exec(url);
  return match ? `${match[1]}/` : null;
}

/** Read one Accounts Center identity field (name|username). */
async function readAccountsCenterField(page, detailBase, field) {
  for (let attempt = 0; attempt < 3; attempt++) {
    await page.goto(`${detailBase}${field}/`, { waitUntil: 'commit', timeout: 40000 }).catch(() => {});
    await page.waitForLoadState('domcontentloaded', { timeout: 20000 }).catch(() => {});
    await page.waitForTimeout(3000);
    const value = await page.locator('input[type="text"]').last().inputValue({ timeout: 8000 }).catch(() => null);
    if (value !== null) return value;
    await page.waitForTimeout(1500);
  }
  return null;
}

/** The edit page header card exposes the handle as plain text next to the avatar. */
async function readHandleFromAccountsCenter(page, detailBase) {
  await page.goto(`${detailBase}`, { waitUntil: 'commit', timeout: 40000 }).catch(() => {});
  await page.waitForLoadState('domcontentloaded', { timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(3000);
  const text = await page.locator('body').innerText({ timeout: 8000 }).catch(() => '');
  const match = /(?:^|\n)([a-z0-9._]{3,30})\s*\n?\s*Instagram/i.exec(text);
  return match ? match[1] : null;
}

/** Accept the crop/confirm dialog if one appears. */
async function acceptCropDialog(page) {
  const steps = [];
  for (const pattern of [/^next$/i, /^done$/i, /^apply$/i, /^save$/i]) {
    const control = page.getByRole('button', { name: pattern }).first();
    if (await control.isVisible().catch(() => false)) {
      await control.click({ timeout: 8000 }).catch(() => {});
      steps.push(String(pattern));
      await page.waitForTimeout(2500);
    }
  }
  return steps;
}

async function photoApplied(page) {
  const text = await page.locator('body').innerText({ timeout: 4000 }).catch(() => '');
  return /profile photo added|photo updated|new photo/i.test(text);
}

/** Upload the profile photo: direct file input first, then the Change-photo menu. */
export async function uploadProfilePhoto(page, photoPath) {
  await page.goto(EDIT_URL, { waitUntil: 'commit', timeout: 40000 }).catch(() => {});
  await page.waitForLoadState('domcontentloaded', { timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(2500);
  const steps = [];
  const direct = page.locator('input[type="file"]').first();
  if (await direct.count().catch(() => 0) > 0) {
    try {
      await direct.setInputFiles(photoPath, { timeout: 15000 });
      steps.push('direct_input');
      await page.waitForTimeout(3500);
      steps.push(...await acceptCropDialog(page));
      if (await photoApplied(page)) {
        const submit = page.getByRole('button', { name: /^submit$/i }).first();
        if (await submit.isVisible().catch(() => false)) {
          await submit.click({ timeout: 8000 }).catch(() => {});
          steps.push('submit');
          await page.waitForTimeout(2000);
        }
        return steps;
      }
    } catch { steps.push('direct_failed'); }
  }
  const change = page.getByRole('button', { name: /change photo/i }).first();
  await change.waitFor({ state: 'visible', timeout: 15000 });
  await change.click({ timeout: 8000 });
  await page.waitForTimeout(1400);
  const upload = page.getByRole('button', { name: /upload photo/i }).first();
  await upload.waitFor({ state: 'visible', timeout: 10000 });
  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser', { timeout: 12000 }),
    upload.click({ timeout: 8000 }),
  ]);
  await chooser.setFiles(photoPath);
  await page.waitForTimeout(3500);
  steps.push(...await acceptCropDialog(page));
  const submit = page.getByRole('button', { name: /^submit$/i }).first();
  if (await submit.isVisible().catch(() => false)) {
    await submit.click({ timeout: 8000 }).catch(() => {});
    steps.push('submit');
    await page.waitForTimeout(2500);
  }
  return steps;
}

/** Set name and/or username through Meta Accounts Center; throws username_taken. */
export async function setAccountsCenterIdentity(page, { name, username }) {
  const result = {};
  const detailBase = await openAccountsCenterProfile(page);
  requireThat(detailBase, 'accounts_center_profile_not_found');
  result.detailBase = detailBase;
  for (const [field, value] of [['name', name], ['username', username]]) {
    if (!value) continue;
    await page.goto(`${detailBase}${field}/`, { waitUntil: 'commit', timeout: 40000 }).catch(() => {});
    await page.waitForLoadState('domcontentloaded', { timeout: 20000 }).catch(() => {});
    await page.waitForTimeout(3200);
    const input = page.locator('input[type="text"]').last();
    await input.waitFor({ state: 'visible', timeout: 12000 });
    const current = await input.inputValue().catch(() => null);
    if (current === value) { result[field] = current; result[`${field}Unchanged`] = true; continue; }
    await input.click({ clickCount: 3 }).catch(() => {});
    await input.fill('').catch(() => {});
    await input.type(value, { delay: 40 });
    await page.waitForTimeout(900);
    await page.keyboard.press('Tab').catch(() => {});
    await page.waitForTimeout(900);
    // Wait for an enabled Done; unavailability is decisive, rate-limit notices
    // are only fatal when Done stays disabled for a value we are changing.
    const doneButtons = page.getByRole('button', { name: /^done$/i });
    let done = null; let verdict = null; let verdictText = ''; let notice = '';
    const deadline = Date.now() + 14000;
    while (Date.now() < deadline) {
      const dialogText = await page.locator('[role="dialog"]').first().innerText({ timeout: 3000 }).catch(() => '');
      if (/is not available|isn'?t available|already (taken|in use)|username is unavailable/i.test(dialogText)) {
        verdict = 'unavailable'; verdictText = dialogText.replace(/\s+/g, ' ').slice(0, 160); break;
      }
      if (/twice within 14 days|can'?t change (your )?(name|username)|try again later/i.test(dialogText)) {
        notice = dialogText.replace(/\s+/g, ' ').slice(0, 160);
      }
      const count = await doneButtons.count().catch(() => 0);
      for (let index = 0; index < count; index++) {
        const candidate = doneButtons.nth(index);
        if (await candidate.isVisible().catch(() => false) && await candidate.isEnabled().catch(() => false)) {
          done = candidate; break;
        }
      }
      if (done) break;
      await page.waitForTimeout(700);
    }
    if (!done && notice) { verdict = 'rate_limited'; verdictText = notice; }
    if (verdict === 'unavailable') {
      result[field] = 'unavailable'; result.verdictText = verdictText;
      throw Object.assign(new Error('username_taken'), { code: 'username_taken' });
    }
    if (verdict === 'rate_limited') {
      result[field] = 'rate_limited'; result.verdictText = verdictText;
      throw Object.assign(new Error('change_rate_limited'), { code: 'change_rate_limited' });
    }
    if (!done) {
      const dialogText = await page.locator('[role="dialog"]').first().innerText({ timeout: 4000 }).catch(() => '');
      throw Object.assign(new Error(`done_not_enabled:${dialogText.replace(/\s+/g, ' ').slice(0, 140)}`),
        { code: 'done_not_enabled' });
    }
    await done.click({ timeout: 8000 });
    await page.waitForTimeout(3800);
    // A confirm dialog may follow; a password dialog means human handling.
    const dialog = page.locator('[role="dialog"]').first();
    if (await dialog.isVisible().catch(() => false)) {
      const dialogText = await dialog.innerText({ timeout: 4000 }).catch(() => '');
      if (/password/i.test(dialogText) || await dialog.locator('input[type="password"]').count().catch(() => 0) > 0) {
        result.passwordRequired = true;
        throw Object.assign(new Error('password_required'), { code: 'password_required' });
      }
      for (const pattern of [/^(change|confirm|done|ok|save|yes)$/i]) {
        const control = dialog.getByRole('button', { name: pattern }).first();
        if (await control.isVisible().catch(() => false)) {
          await control.click({ timeout: 8000 }).catch(() => {});
          await page.waitForTimeout(3000);
          break;
        }
      }
    }
    const bodyText = await page.locator('body').innerText({ timeout: 6000 }).catch(() => '');
    if (field === 'username'
      && /isn'?t available|not available|already (taken|in use)|can'?t be used|try another|unavailable/i.test(bodyText)) {
      result.username = 'taken';
      throw Object.assign(new Error('username_taken'), { code: 'username_taken' });
    }
    result[field] = await readAccountsCenterField(page, detailBase, field);
  }
  return result;
}

/** Collect all inputs/buttons across shadow roots for the inspect mode. */
export async function describeEditDom(page) {
  return page.evaluate(() => {
    const elements = [];
    const walk = root => {
      for (const el of root.querySelectorAll('*')) {
        if (el.shadowRoot) walk(el.shadowRoot);
        const tag = el.tagName.toLowerCase();
        const editable = el.getAttribute('contenteditable');
        if (['input', 'textarea', 'select'].includes(tag) || editable) {
          elements.push({ tag, name: el.getAttribute('name') || '', ariaLabel: el.getAttribute('aria-label') || '',
            placeholder: el.getAttribute('placeholder') || '', type: el.getAttribute('type') || '',
            valueLength: (typeof el.value === 'string' ? el.value.length : (el.textContent || '').length),
            visible: !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length) });
        }
      }
    };
    walk(document);
    const buttons = [...document.querySelectorAll('button, [role="button"]')]
      .map(button => (button.innerText || '').replace(/\s+/g, ' ').trim()).filter(Boolean).slice(0, 20);
    const images = [...document.querySelectorAll('img')].map(image => image.getAttribute('alt') || '')
      .filter(Boolean).slice(0, 10);
    return { elements: elements.slice(0, 40), buttons, images, texts: (document.body.innerText || '').slice(0, 1200) };
  }).catch(() => null);
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArguments(argv);
  requireThat(options['profile-id'], 'profile_id_required');
  const mode = options.mode || 'check';
  requireThat(['check', 'inspect', 'update'].includes(mode), 'invalid_mode');
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
  const report = { step: 'instagram_profile', label: options.label || null, mode, profileId: options['profile-id'],
    handle: null, fullName: null, requestedUsername: options['new-username'] || null,
    requestedName: options['new-name'] || null, photoFile: options['photo-file'] || null, warnings: [] };

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
  const shot = name => resolve(evidenceDir, `instagram-${options['profile-id']}-${stamp}-${name}.png`);
  try {
    await mkdir(evidenceDir, { recursive: true, mode: 0o700 });

    const state = await gotoEditPage(page);
    log('edit_page', { state });
    if (state === 'login' || state === 'unknown') {
      report.status = 'human_required';
      report.warnings.push(state === 'login' ? 'instagram_login_required' : 'edit_page_not_recognized');
      report.screenshot = shot('login');
      await page.screenshot({ path: report.screenshot }).catch(() => {});
    } else {
      report.screenshot = shot('edit');
      await page.screenshot({ path: report.screenshot }).catch(() => {});
      const wantsIdentityUpdate = Boolean(options['new-username'] || options['new-name']);
      const photoOnly = mode === 'update' && Boolean(options['photo-file']) && !wantsIdentityUpdate;
      if (photoOnly) {
        // Photo-only runs stay on the edit surface: no Accounts Center navigation.
        report.photoSteps = await uploadProfilePhoto(page, options['photo-file']);
        report.photoShot = shot('photo');
        await page.screenshot({ path: report.photoShot }).catch(() => {});
        report.photoApplied = await photoApplied(page);
        log('photo_uploaded', { steps: report.photoSteps, applied: report.photoApplied });
        report.status = report.photoApplied ? 'updated' : 'update_unconfirmed';
      }
      const detailBase = photoOnly ? null : await openAccountsCenterProfile(page);
      if (photoOnly) {
        // done above
      } else if (!detailBase) {
        report.status = 'human_required';
        report.warnings.push('accounts_center_profile_not_found');
      } else {
        report.accountsCenterBase = detailBase;
        report.handle = await readHandleFromAccountsCenter(page, detailBase);
        report.fullName = await readAccountsCenterField(page, detailBase, 'name');
        log('fields', { handle: report.handle, nameLength: (report.fullName || '').length });

        if (mode === 'inspect') {
          await page.goto(EDIT_URL, { waitUntil: 'commit', timeout: 40000 }).catch(() => {});
          await page.waitForTimeout(2500);
          report.dom = await describeEditDom(page);
          report.status = 'session_ok';
        } else if (mode === 'update') {
          requireThat(options['new-username'] || options['new-name'] || options['photo-file'], 'nothing_to_update');
          const wantsIdentity = Boolean(options['new-username'] || options['new-name']);
          const photoStep = async () => {
            report.photoSteps = await uploadProfilePhoto(page, options['photo-file']);
            report.photoShot = shot('photo');
            await page.screenshot({ path: report.photoShot }).catch(() => {});
            log('photo_uploaded', { steps: report.photoSteps });
          };
          // Photo-only runs do the upload first, on the freshest browser session.
          if (!wantsIdentity && options['photo-file']) await photoStep();
          if (wantsIdentity) {
            try {
              report.identity = await setAccountsCenterIdentity(page, { name: options['new-name'], username: options['new-username'] });
              log('identity_set', { name: report.identity.name, username: report.identity.username });
            } catch (error) {
              report.identityShot = shot('identity-error');
              await page.screenshot({ path: report.identityShot }).catch(() => {});
              if (error.code === 'username_taken' || error.message === 'username_taken') {
                report.status = 'username_taken';
                throw error;
              }
              if (error.code === 'password_required') {
                report.status = 'human_required';
                report.warnings.push('password_required_for_identity_change');
                throw error;
              }
              report.status = 'update_error';
              report.warnings.push(`identity:${String(error?.message || error).slice(0, 120)}`);
              throw error;
            }
          }
          if (wantsIdentity && options['photo-file']) await photoStep();
          report.after = {
            name: await readAccountsCenterField(page, detailBase, 'name'),
            username: await readAccountsCenterField(page, detailBase, 'username'),
          };
          const okName = !options['new-name'] || report.after.name === options['new-name'];
          const okUser = !options['new-username'] || report.after.username === options['new-username'];
          report.status = okName && okUser ? 'updated' : 'update_unconfirmed';
        } else {
          report.status = 'session_ok';
        }
      }
    }
    report.finalShot = shot('final');
    await page.screenshot({ path: report.finalShot }).catch(() => {});
  } catch (error) {
    report.error = String(error?.message || error).slice(0, 240);
    if (!report.status) report.status = 'update_error';
    report.errorShot = shot('error');
    await page.screenshot({ path: report.errorShot }).catch(() => {});
  } finally {
    clearTimeout(watchdog);
    if (!options.keepProfile) await stopBrowserProfile(api, options['profile-id'], session.browser).catch(() => {});
  }
  const reportPath = resolve(evidenceDir, `instagram-${options['profile-id']}-${stamp}.json`);
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 }).catch(() => {});
  report.reportPath = reportPath;
  log('done', { status: report.status });
  console.log(JSON.stringify(report, null, 2));
  return ['session_ok', 'updated'].includes(report.status) ? 0 : 2;
}

if (!process.argv[1] || process.argv[1] === '-' || process.argv[1].endsWith('instagram-profile.mjs')) {
  main().then(code => { process.exit(code); }).catch(error => {
    console.error(JSON.stringify({ step: 'instagram_profile', error: String(error?.message || error), code: errorCode(error) }));
    process.exit(1);
  });
}
