import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { requireThat, errorCode } from '../src/core.mjs';
import { readPrivate } from '../src/storage.mjs';
import { Multilogin } from '../src/multilogin.mjs';
import { connect, stopBrowserProfile } from '../src/runner.mjs';

// Upload-Post/TikTok OAuth connector for ONE warmed Multilogin profile.
//
//   --mode check      verify the TikTok session and report the logged-in handle
//   --mode authorize  open the provided Upload-Post authorize URL, click TikTok's
//                     own Authorize control, and capture where the callback lands
//
// The script does not type credentials, does not fabricate cookies and never
// solves a challenge. If TikTok asks for a human verification or a login, it
// reports `human_required` and leaves the profile running for a person.
//
// Usage:
//   node scripts/uploadpost-connect.mjs --profile-id <id> --handle <tiktok_handle> \
//     --mode check|authorize [--authorize-url URL | --authorize-url-file <file>] \
//     [--evidence-dir /data/uploadpost-evidence] [--watchdog-ms 240000] [--keep-profile] \
//     [--token-file /data/automation-token] [--folder-id <folder>]

export const DEFAULT_FOLDER = '2b104092-39f8-459e-be4c-74e037507dd3';

export function parseArguments(argv) {
  const options = { positional: [] };
  const valueFlags = ['--profile-id', '--handle', '--mode', '--authorize-url', '--authorize-url-file', '--evidence-dir',
    '--token-file', '--folder-id', '--launcher-url', '--code', '--watchdog-ms'];
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

/** The sidebar profile link exposes the signed-in handle as `/@handle`. */
export async function readTiktokHandle(page) {
  return page.evaluate(() => {
    const links = [...document.querySelectorAll('a[href^="/@"]')].map(anchor => anchor.getAttribute('href') || '');
    const match = links.map(href => /^\/@([A-Za-z0-9._]+)/.exec(href)).find(Boolean);
    return match ? match[1] : null;
  }).catch(() => null);
}

export async function tiktokSessionState(page) {
  let handle = await readTiktokHandle(page);
  if (!handle) {
    // The sidebar markup changes; the logged-in profile URL is authoritative:
    // tiktok.com/profile redirects to tiktok.com/@<handle>.
    await page.goto('https://www.tiktok.com/profile', { waitUntil: 'commit', timeout: 40000 }).catch(() => {});
    await page.waitForLoadState('domcontentloaded', { timeout: 20000 }).catch(() => {});
    await page.waitForTimeout(1500);
    const fromUrl = /tiktok\.com\/@([A-Za-z0-9._]+)/.exec(page.url());
    if (fromUrl) handle = fromUrl[1];
  }
  const loginVisible = await page.getByRole('button', { name: /^log in$/i }).first().isVisible().catch(() => false)
    || /\/login/.test(page.url());
  const challenge = /captcha|verify|challenge/i.test(page.url());
  return { handle, loginVisible, challenge };
}

/** Click TikTok's own authorize control; returns which label matched. */
export async function authorizeTiktok(page) {
  const candidates = [/^continue$/i, /^authorize$/i, /^allow$/i, /authorize/i, /agree/i, /^同意$/, /授权/];
  for (const pattern of candidates) {
    try {
      const control = page.getByRole('button', { name: pattern }).first();
      await control.waitFor({ state: 'visible', timeout: 3000 });
      await control.scrollIntoViewIfNeeded({ timeout: 3000 }).catch(() => {});
      await control.click({ timeout: 8000 });
      return String(pattern);
    } catch { /* next label */ }
  }
  try {
    const fallback = page.locator('button, [role="button"]').filter({ hasText: /continue|authorize|allow|agree|授权|同意/i }).first();
    await fallback.waitFor({ state: 'visible', timeout: 3000 });
    await fallback.click({ timeout: 8000 });
    return 'text-fallback';
  } catch { return null; }
}

const hostOf = (value) => { try { return new URL(value).hostname; } catch { return ''; } };

/** Enumerate controls that could be the consent action, across frames. */
export async function probeAuthorizeControls(page) {
  const frames = page.frames().map(frame => ({ main: frame === page.mainFrame(), host: hostOf(frame.url()),
    path: (() => { try { return new URL(frame.url()).pathname; } catch { return ''; } })() }));
  const controls = [];
  for (const frame of page.frames()) {
    const matches = await frame.locator('button, [role="button"], a')
      .filter({ hasText: /continue|authorize|allow|agree|授权|同意/i }).all().catch(() => []);
    for (const match of matches.slice(0, 6)) {
      const box = await match.boundingBox().catch(() => null);
      const text = (await match.innerText().catch(() => '')).replace(/\s+/g, ' ').slice(0, 40);
      const tag = await match.evaluate(element => element.tagName).catch(() => '');
      controls.push({ mainFrame: frame === page.mainFrame(), tag, text, box });
    }
  }
  return { frames, controls };
}

/**
 * Click the consent action with a real mouse event at the element's centre.
 * Playwright's element handle click has silently no-op'd on TikTok's consent
 * page; the raw mouse event at the same coordinates does register.
 */
export async function mouseClickControl(page, control) {
  await control.scrollIntoViewIfNeeded({ timeout: 3000 }).catch(() => {});
  const box = await control.boundingBox();
  requireThat(box, 'control_has_no_box');
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 8 });
  await page.mouse.down();
  await page.waitForTimeout(80);
  await page.mouse.up();
  return { x: Math.round(box.x + box.width / 2), y: Math.round(box.y + box.height / 2) };
}

/** The consent action if the normal role/text matches find nothing. */
export async function findConsentControl(page) {
  const patterns = [/^continue$/i, /^authorize$/i, /^allow$/i, /authorize/i, /agree/i, /^同意$/, /授权/];
  for (const pattern of patterns) {
    const control = page.getByRole('button', { name: pattern }).first();
    if (await control.isVisible().catch(() => false)) return control;
  }
  const fallback = page.locator('button, [role="button"]').filter({ hasText: /continue|authorize|allow|agree|授权|同意/i }).first();
  if (await fallback.isVisible().catch(() => false)) return fallback;
  return null;
}

/** TikTok renders the consent UI a few seconds after navigation commits. */
export async function waitForConsentControl(page, timeoutMs = 25000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const control = await findConsentControl(page);
    if (control) return control;
    await page.waitForTimeout(500);
  }
  return null;
}

/** Wait for the OAuth handoff: a URL change, a new tab, or a callback frame. */
export async function waitForAuthHandoff(browser, page, knownPages, timeoutMs = 45000) {
  const deadline = Date.now() + timeoutMs;
  const startUrl = page.url();
  while (Date.now() < deadline) {
    const fresh = browser.contexts().flatMap(context => context.pages()).find(candidate => !knownPages.has(candidate));
    if (fresh) return { page: fresh, via: 'new_page' };
    if (page.url() !== startUrl) return { page, via: 'same_page' };
    const frame = page.frames().find(candidate => /upload-post\.com$/i.test(hostOf(candidate.url())));
    if (frame) return { page, via: 'frame', frameUrl: frame.url() };
    await page.waitForTimeout(500);
  }
  return null;
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArguments(argv);
  requireThat(options['profile-id'], 'profile_id_required');
  const mode = options.mode || 'check';
  requireThat(['check', 'authorize'].includes(mode), 'invalid_mode');
  const folderId = options['folder-id'] || DEFAULT_FOLDER;
  const token = (await readPrivate(resolve(options['token-file'] || '/data/automation-token'))).trim();
  const api = new Multilogin({ token, launcherUrl: options['launcher-url'] || 'https://launcher.mlx.yt:45001' });
  const evidenceDir = options['evidence-dir'] || '/data/uploadpost-evidence';
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const started = Date.now();
  const log = (event, extra = {}) => console.error(JSON.stringify({ at: new Date().toISOString(),
    elapsedMs: Date.now() - started, event, profileId: options['profile-id'], ...extra }));
  // A stuck navigation must never hang the operator: log and exit; the profile
  // stays visible in the viewer for manual handling.
  const watchdog = setTimeout(() => { log('watchdog_timeout'); process.exit(3); }, Number(options['watchdog-ms'] || 240000));
  watchdog.unref?.();
  const report = { step: 'uploadpost_connect', code: options.code || null, mode, profileId: options['profile-id'], handle: null,
    expectedHandle: options.handle || null, authorized: false, callbackHost: null, callbackUrlPath: null,
    callbackText: null, clickedLabel: null, warnings: [] };

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
    try {
      await page.goto('https://www.tiktok.com/foryou', { waitUntil: 'commit', timeout: 40000 });
    } catch (error) {
      report.status = 'tiktok_unreachable';
      report.warnings.push(`tiktok_goto:${String(error?.message || error).slice(0, 120)}`);
      throw error;
    }
    log('tiktok_goto');
    await page.waitForLoadState('domcontentloaded', { timeout: 20000 }).catch(() => {});
    await page.waitForSelector('body', { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(2500);
    const state = await tiktokSessionState(page);
    report.handle = state.handle;
    log('tiktok_state', { handle: state.handle, loginVisible: state.loginVisible });

    if (!state.handle || state.loginVisible) {
      report.warnings.push(state.loginVisible ? 'tiktok_login_visible' : 'tiktok_handle_not_found');
      report.status = 'human_required';
    } else if (options.handle && state.handle.toLowerCase() !== options.handle.toLowerCase()) {
      report.warnings.push(`handle_mismatch:${state.handle}`);
      report.status = 'handle_mismatch';
    } else if (mode === 'check') {
      report.status = 'session_ok';
    } else {
      const authorizeUrl = options['authorize-url']
        || (options['authorize-url-file'] ? (await readPrivate(resolve(options['authorize-url-file']))).trim() : null);
      requireThat(authorizeUrl, 'authorize_url_required');
      log('authorize_goto');
      const knownPages = new Set(session.context.pages());
      // Some account proxies cannot reach app.upload-post.com (the OAuth
      // callback host), which would strand the exchange in ERR_TIMED_OUT. The
      // callback is authenticated by the single-use state, so relay the same
      // GET from the worker container, which can reach the host, and never
      // store or log the URL (it carries the code and state).
      const relayedCallbacks = [];
      report.callbackRelayed = false;
      report.relayedCallbacks = relayedCallbacks;
      await session.context.route('https://app.upload-post.com/**', async route => {
        const target = route.request().url();
        let parsed = { hostname: 'app.upload-post.com', pathname: '/', searchParams: new URLSearchParams() };
        try { parsed = new URL(target); } catch { /* defaults */ }
        const queryKeys = [...parsed.searchParams.keys()];
        const relayHeaders = {};
        const originalHeaders = route.request().headers();
        for (const name of ['user-agent', 'referer', 'accept-language']) {
          if (originalHeaders[name]) relayHeaders[name] = originalHeaders[name];
        }
        try {
          const response = await fetch(target, { redirect: 'manual', headers: relayHeaders,
            signal: AbortSignal.timeout(20000) });
          let finalHost = ''; let finalPath = ''; let connectReturn = {};
          const location = response.headers.get('location');
          if (location) {
            try {
              const redirectTo = new URL(location, target);
              finalHost = redirectTo.hostname; finalPath = redirectTo.pathname;
              for (const key of ['connect_status', 'platform', 'error_code', 'error_description']) {
                if (redirectTo.searchParams.has(key)) connectReturn[key] = redirectTo.searchParams.get(key).slice(0, 120);
              }
            } catch { /* keep blanks */ }
          }
          relayedCallbacks.push({ host: parsed.hostname, path: parsed.pathname, status: response.status,
            queryKeys, finalHost, finalPath, connectReturn });
          report.callbackRelayed = true;
          if (location && response.status >= 300 && response.status < 400) {
            // Forward the outcome redirect to the browser as-is; the callback
            // exchange already happened on this GET.
            await route.fulfill({ status: response.status, headers: { location }, body: '' });
          } else {
            await route.fulfill({ status: 200, contentType: 'text/html',
              body: '<!doctype html><html><body>OAuth callback relayed.</body></html>' });
          }
        } catch (error) {
          relayedCallbacks.push({ host: parsed.hostname, path: parsed.pathname, queryKeys,
            error: String(error?.message || error).slice(0, 80) });
          await route.fulfill({ status: 502, contentType: 'text/html', body: 'callback relay failed' }).catch(() => {});
        }
      });
      // page.goto can hang when the authorize URL redirects straight into the
      // relayed callback (account already granted). Fire the navigation and
      // drive the flow from explicit waits instead.
      await page.evaluate(url => { window.location.assign(url); }, authorizeUrl).catch(() => {});
      await page.waitForTimeout(2500);
      await page.waitForLoadState('domcontentloaded', { timeout: 20000 }).catch(() => {});
      await page.waitForTimeout(2000);
      if (/\/login/i.test(page.url())) {
        report.status = 'human_required';
        report.warnings.push('authorize_redirected_to_login');
      } else {
        log('authorize_click');
        const control = await waitForConsentControl(page);
        report.consentProbe = await probeAuthorizeControls(page).catch(() => null);
        if (!control) {
          report.status = 'authorize_control_not_found';
          report.warnings.push('authorize_button_missing');
        } else {
          report.clickedLabel = await control.evaluate(element => (element.innerText || element.textContent || '')
            .replace(/\s+/g, ' ').trim().slice(0, 40)).catch(() => null);
          // TikTok's consent button intermittently ignores a CDP mouse click,
          // and keyboard activation can submit twice (two codes, one state).
          // Try one raw mouse click first; fall back to keyboard/DOM click.
          const strategies = [
            ['mouse-center', async current => { report.clickPoint = await mouseClickControl(page, current)
              .catch(() => report.clickPoint); }],
            ['keyboard-enter', async current => { await current.focus().catch(() => {});
              await page.keyboard.press('Enter'); }],
            ['dom-click', async current => { await current.evaluate(element => element.click()); }],
          ];
          report.attempts = [];
          let target = null;
          for (const [name, activate] of strategies) {
            if (target) break;
            const current = await waitForConsentControl(page, 8000);
            if (!current) break;
            report.attempts.push(name);
            await activate(current).catch(error =>
              report.warnings.push(`activate:${name}:${String(error?.message || error).slice(0, 60)}`));
            log('authorize_activated', { strategy: name });
            target = await waitForAuthHandoff(session.browser, page, knownPages, 30000);
            if (!target) log('authorize_no_handoff', { strategy: name });
          }
          // Follow TikTok interstitials until the browser reaches a non-TikTok host.
          if (target) {
            const targetUrl = () => (target.via === 'frame' ? target.frameUrl : target.page.url());
            report.handoffChain = [hostOf(targetUrl())];
            for (let hop = 0; hop < 3 && /tiktok\.com$/i.test(hostOf(targetUrl())); hop++) {
              const currentPage = target.page;
              const next = await waitForAuthHandoff(session.browser, currentPage,
                new Set([...knownPages, currentPage]), 20000);
              if (!next) break;
              target = next;
              report.handoffChain.push(hostOf(targetUrl()));
            }
          }
          if (!target) {
            report.status = 'callback_unexpected';
            report.warnings.push('authorize_no_handoff');
          } else {
            const targetPage = target.page;
            await targetPage.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {});
            const finalUrl = target.via === 'frame' ? target.frameUrl : targetPage.url();
            const parsed = new URL(finalUrl);
            const connectReturn = {};
            for (const key of ['connect_status', 'platform', 'error_code', 'error_description']) {
              if (parsed.searchParams?.has(key)) connectReturn[key] = parsed.searchParams.get(key).slice(0, 120);
            }
            report.connectReturn = connectReturn;
            report.handoffVia = target.via;
            report.callbackHost = parsed.hostname;
            report.callbackUrlPath = parsed.pathname;
            const textSource = target.via === 'frame'
              ? targetPage.frames().find(candidate => candidate.url() === target.frameUrl) || targetPage
              : targetPage;
            report.callbackText = (await textSource.locator('body').innerText({ timeout: 8000 }).catch(() => '')).slice(0, 600);
            report.authorized = /upload-post\.com$/i.test(parsed.hostname);
            report.status = report.authorized ? 'callback_reached' : 'callback_unexpected';
            if (/upload-post\.com$/i.test(parsed.hostname) && /log ?in|sign ?in/i.test(report.callbackText)) {
              report.warnings.push('uploadpost_login_required');
            }
          }
        }
      }
    }

    await mkdir(evidenceDir, { recursive: true, mode: 0o700 });
    const shot = resolve(evidenceDir, `uploadpost-${options['profile-id']}-${stamp}.png`);
    await page.screenshot({ path: shot }).catch(() => {});
    report.screenshot = shot;
    const reportPath = resolve(evidenceDir, `uploadpost-${options['profile-id']}-${stamp}.json`);
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
    report.reportPath = reportPath;
  } finally {
    clearTimeout(watchdog);
    if (!options.keepProfile) await stopBrowserProfile(api, options['profile-id'], session.browser).catch(() => {});
  }
  log('done', { status: report.status });
  console.log(JSON.stringify(report, null, 2));
  return ['session_ok', 'callback_reached'].includes(report.status) ? 0 : 2;
}

if (!process.argv[1] || process.argv[1] === '-' || process.argv[1].endsWith('uploadpost-connect.mjs')) {
  main().then(code => { process.exit(code); }).catch(error => {
    console.error(JSON.stringify({ step: 'uploadpost_connect', error: String(error?.message || error), code: errorCode(error) }));
    process.exit(1);
  });
}
