import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { requireThat } from '../src/core.mjs';
import { readPrivate } from '../src/storage.mjs';
import { Multilogin } from '../src/multilogin.mjs';
import { connect, stopBrowserProfile } from '../src/runner.mjs';

// Read the exit IP / geolocation of ONE Multilogin profile's browser.
// Used to verify a custom proxy before trusting it with account sessions.
//
// Usage:
//   node scripts/profile-net-check.mjs --profile-id <id> [--url https://ipinfo.io/json] \
//     [--evidence-dir /data/network-evidence] [--watchdog-ms 180000] [--keep-profile]

export const DEFAULT_FOLDER = '2b104092-39f8-459e-be4c-74e037507dd3';

export function parseArguments(argv) {
  const options = { positional: [] };
  const valueFlags = ['--profile-id', '--url', '--evidence-dir', '--token-file', '--folder-id', '--label', '--watchdog-ms'];
  for (let index = 0; index < argv.length; index++) {
    const token = argv[index];
    if (token === '--keep-profile') options.keepProfile = true;
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

export async function main(argv = process.argv.slice(2)) {
  const options = parseArguments(argv);
  requireThat(options['profile-id'], 'profile_id_required');
  const folderId = options['folder-id'] || DEFAULT_FOLDER;
  const url = options.url || 'https://ipinfo.io/json';
  const token = (await readPrivate(resolve(options['token-file'] || '/data/automation-token'))).trim();
  const api = new Multilogin({ token, launcherUrl: 'https://launcher.mlx.yt:45001' });
  const evidenceDir = options['evidence-dir'] || '/data/network-evidence';
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const started = Date.now();
  const log = (event, extra = {}) => console.error(JSON.stringify({ at: new Date().toISOString(), elapsedMs: Date.now() - started, event, profileId: options['profile-id'], ...extra }));
  const watchdog = setTimeout(() => { log('watchdog_timeout'); process.exit(3); }, Number(options['watchdog-ms'] || 180000));
  const report = { step: 'profile_net_check', label: options.label || null, profileId: options['profile-id'], url, status: null };

  log('profile_resolve');
  const meta = await api.profileMeta(options['profile-id']);
  requireThat(meta, 'profile_metadata_missing');
  requireThat(!meta.in_use_by, 'profile_in_use');
  log('profile_start');
  const port = await api.start(folderId, options['profile-id'], false);
  log('profile_started', { port });
  const session = await connect(port, { cdpHost: '127.0.0.1' });
  const page = session.page;
  page.setDefaultTimeout(20000);
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 40000 }).catch(() => {});
    await page.waitForTimeout(1500);
    const text = await page.evaluate(() => document.body?.innerText ?? '').catch(() => '');
    try {
      report.exit = JSON.parse(text);
      report.status = 'ok';
    } catch {
      report.bodyPreview = String(text).replace(/\s+/g, ' ').slice(0, 200);
      report.status = 'unparsed';
    }
    await mkdir(evidenceDir, { recursive: true, mode: 0o700 });
    report.screenshot = resolve(evidenceDir, `net-${options['profile-id']}-${stamp}.png`);
    await page.screenshot({ path: report.screenshot }).catch(() => {});
  } catch (error) {
    report.error = String(error?.message ?? error).slice(0, 200);
    report.status = 'error';
  } finally {
    clearTimeout(watchdog);
    if (!options.keepProfile) await stopBrowserProfile(api, options['profile-id'], session.browser).catch(() => {});
  }
  const reportPath = resolve(evidenceDir, `net-${options['profile-id']}-${stamp}.json`);
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 }).catch(() => {});
  report.reportPath = reportPath;
  log('done', { status: report.status, exitIp: report.exit?.ip ?? null, country: report.exit?.country ?? null });
  console.log(JSON.stringify(report, null, 2));
  return report.status === 'ok' ? 0 : 2;
}

if (process.argv[1] && import.meta.url === new URL(`file://${resolve(process.argv[1])}`).href) {
  main().then((code) => process.exit(code)).catch((error) => {
    console.error(JSON.stringify({ status: 'error', error: String(error?.message ?? error) }));
    process.exit(2);
  });
}
