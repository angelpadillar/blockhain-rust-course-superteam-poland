import { mkdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { requireThat } from '../src/core.mjs';
import { readPrivate } from '../src/storage.mjs';
import { Multilogin } from '../src/multilogin.mjs';
import { connect } from '../src/runner.mjs';
import { notifyHuman } from '../src/human-notify.mjs';

// Park ONE profile on an OAuth authorize URL for a human click-through.
// Starts the browser, opens the URL, screenshots, notifies Discord, and exits
// WITHOUT stopping the profile so the operator can finish in VNC.
//
// Usage:
//   node scripts/park-oauth.mjs --profile-id <id> --url-file /data/ig-authorize-url.txt --label K02/IG

export function parseArguments(argv) {
  const options = { positional: [] };
  const valueFlags = ['--profile-id', '--url-file', '--url', '--label', '--evidence-dir', '--token-file', '--folder-id'];
  for (let index = 0; index < argv.length; index++) {
    const token = argv[index];
    if (valueFlags.includes(token)) {
      const value = argv[index + 1];
      requireThat(typeof value === 'string' && !value.startsWith('--'), 'invalid_command_arguments');
      options[token.slice(2)] = value;
      index++;
    } else if (token.startsWith('--')) throw new Error(`unknown argument ${token}`);
    else options.positional.push(token);
  }
  return options;
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArguments(argv);
  requireThat(options['profile-id'], 'profile_id_required');
  const url = options.url || (options['url-file'] ? (await readFile(options['url-file'], 'utf8')).trim() : null);
  requireThat(/^https:\/\//.test(url || ''), 'url_required');
  const folderId = options['folder-id'] || '2b104092-39f8-459e-be4c-74e037507dd3';
  const token = (await readPrivate(resolve(options['token-file'] || '/data/automation-token'))).trim();
  const api = new Multilogin({ token, launcherUrl: 'https://launcher.mlx.yt:45001' });
  const evidenceDir = options['evidence-dir'] || '/data/instagram-evidence';
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const label = options.label || options['profile-id'];
  const report = { step: 'park_oauth', label, profileId: options['profile-id'], url: url.split('?')[0], status: null };

  const meta = await api.profileMeta(options['profile-id']);
  requireThat(meta, 'profile_metadata_missing');
  requireThat(!meta.in_use_by, 'profile_in_use');
  const port = await api.start(folderId, options['profile-id'], false);
  const session = await connect(port, { cdpHost: '127.0.0.1' });
  const page = session.page;
  page.setDefaultTimeout(15000);
  await page.goto(url, { waitUntil: 'commit', timeout: 45000 }).catch(() => {});
  await page.waitForLoadState('domcontentloaded', { timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(6000);
  await mkdir(evidenceDir, { recursive: true, mode: 0o700 });
  report.screenshot = resolve(evidenceDir, `parked-${options['profile-id']}-${stamp}.png`);
  await page.screenshot({ path: report.screenshot }).catch(() => {});
  report.pageUrl = page.url().split('?')[0];
  report.title = await page.title().catch(() => null);
  report.notification = await notifyHuman({
    label,
    reason: 'oauth_consent_park',
    url: page.url().split('?')[0],
    screenshotPath: report.screenshot,
    resumeCommand: 'finish login/consent in VNC; then verify via Upload-Post API',
  });
  report.status = 'parked';
  console.log(JSON.stringify(report, null, 2));
  // Exit without closing the browser so the operator keeps the page.
  process.exit(0);
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main().catch((error) => {
    console.error(JSON.stringify({ status: 'error', error: String(error?.message ?? error) }));
    process.exit(2);
  });
}
