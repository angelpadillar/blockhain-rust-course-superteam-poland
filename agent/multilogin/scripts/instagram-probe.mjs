import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { requireThat, errorCode } from '../src/core.mjs';
import { readPrivate } from '../src/storage.mjs';
import { Multilogin } from '../src/multilogin.mjs';
import { connect, stopBrowserProfile } from '../src/runner.mjs';

// Temporary operational probe: discover the real Instagram web surfaces for
// (a) profile-photo upload on the Edit profile page and (b) name/username
// editing in Meta Accounts Center. Evidence only; it saves nothing.
//
// Usage: node scripts/instagram-probe.mjs --profile-id <id> [--evidence-dir /data/instagram-evidence]

const DEFAULT_FOLDER = '2b104092-39f8-459e-be4c-74e037507dd3';

export function parseArguments(argv) {
  const options = {};
  const valueFlags = ['--profile-id', '--evidence-dir', '--token-file', '--folder-id', '--launcher-url', '--label'];
  for (let index = 0; index < argv.length; index++) {
    const token = argv[index];
    requireThat(valueFlags.includes(token), `unknown argument ${token}`);
    const value = argv[index + 1];
    requireThat(typeof value === 'string' && !value.startsWith('--'), 'invalid_command_arguments');
    options[token.slice(2)] = value; index++;
  }
  return options;
}

async function visibleDom(page) {
  return page.evaluate(() => {
    const visible = el => !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
    const buttons = [...document.querySelectorAll('button, [role="button"], [role="menuitem"]')]
      .filter(visible).map(b => (b.innerText || '').replace(/\s+/g, ' ').trim()).filter(Boolean).slice(0, 25);
    const inputs = [...document.querySelectorAll('input, textarea, [contenteditable]')]
      .filter(visible).map(i => ({ tag: i.tagName.toLowerCase(), type: i.getAttribute('type') || '',
        name: i.getAttribute('name') || '', aria: i.getAttribute('aria-label') || '',
        placeholder: i.getAttribute('placeholder') || '',
        valueLen: (typeof i.value === 'string' ? i.value.length : (i.textContent || '').length) }));
    const links = [...document.querySelectorAll('a')].map(a => ({ href: a.href, text: (a.innerText || '').replace(/\s+/g, ' ').trim() }))
      .filter(entry => entry.href && entry.text).slice(0, 30);
    const text = (document.body.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 900);
    return { url: location.href, buttons, inputs, links, text };
  }).catch(() => null);
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArguments(argv);
  requireThat(options['profile-id'], 'profile_id_required');
  const folderId = options['folder-id'] || DEFAULT_FOLDER;
  const token = (await readPrivate(resolve(options['token-file'] || '/data/automation-token'))).trim();
  const api = new Multilogin({ token, launcherUrl: options['launcher-url'] || 'https://launcher.mlx.yt:45001' });
  const evidenceDir = options['evidence-dir'] || '/data/instagram-evidence';
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const report = { step: 'instagram_probe', label: options.label || null, profileId: options['profile-id'], steps: [] };
  const meta = await api.profileMeta(options['profile-id']);
  requireThat(meta, 'profile_metadata_missing');
  requireThat(!meta.in_use_by, 'profile_in_use');
  const port = await api.start(folderId, options['profile-id'], false);
  const session = await connect(port, { cdpHost: '127.0.0.1' });

  try {
    const page = session.page;
    page.setDefaultTimeout(15000);
    await mkdir(evidenceDir, { recursive: true, mode: 0o700 });
    const snap = async name => {
      const info = await visibleDom(page);
      const shot = resolve(evidenceDir, `probe-${stamp}-${name}.png`);
      await page.screenshot({ path: shot }).catch(() => {});
      report.steps.push({ name, ...info, screenshot: shot });
    };

    // A) Instagram Edit profile + photo menu/chooser behaviour.
    await page.goto('https://www.instagram.com/accounts/edit/', { waitUntil: 'commit', timeout: 40000 }).catch(() => {});
    await page.waitForLoadState('domcontentloaded', { timeout: 20000 }).catch(() => {});
    await page.waitForTimeout(2000);
    await page.locator('input[placeholder="Website"], textarea[placeholder="Bio"]').first()
      .waitFor({ state: 'visible', timeout: 20000 }).catch(() => {});
    await page.waitForTimeout(1200);
    await snap('edit');
    const chooserPromise = page.waitForEvent('filechooser', { timeout: 8000 }).catch(() => null);
    const change = page.getByRole('button', { name: /change photo/i }).first();
    await change.click({ timeout: 8000 }).catch(() => {});
    await page.waitForTimeout(1800);
    await snap('after-change-photo');
    const chooser = await chooserPromise;
    report.photoFlow = { directFileChooser: !!chooser };
    if (chooser) await chooser.setFiles([]).catch(() => {});
    else await page.keyboard.press('Escape').catch(() => {});
    await page.waitForTimeout(1200);

    // B) Meta Accounts Center -> Profiles and personal details.
    await page.goto('https://accountscenter.instagram.com/profiles/', { waitUntil: 'commit', timeout: 40000 }).catch(() => {});
    await page.waitForLoadState('domcontentloaded', { timeout: 20000 }).catch(() => {});
    await page.waitForTimeout(4500);
    await snap('ac-profiles');

    // C) Open the Instagram profile row, then any Name/Username row inside it.
    const profileRow = page.getByText(/^instagram$/i).first();
    if (await profileRow.isVisible().catch(() => false)) {
      await profileRow.click({ timeout: 8000 }).catch(() => {});
      await page.waitForTimeout(4000);
      await snap('ac-profile-detail');
    }
    for (const [key, pattern] of [['name', /^Name$/i], ['username', /^Username$/i]]) {
      const row = page.getByText(pattern).first();
      const visible = await row.isVisible().catch(() => false);
      report[`has${key[0].toUpperCase()}${key.slice(1)}Row`] = visible;
      if (!visible) continue;
      await row.click({ timeout: 8000 }).catch(() => {});
      await page.waitForTimeout(4000);
      await snap(`ac-${key}-edit`);
      await page.setDefaultTimeout(15000);
      await page.goBack({ timeout: 20000 }).catch(() => {});
      await page.waitForTimeout(3000);
    }
  } finally {
    await stopBrowserProfile(api, options['profile-id'], session.browser).catch(() => {});
  }
  const reportPath = resolve(evidenceDir, `probe-${stamp}.json`);
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  report.reportPath = reportPath;
  console.log(JSON.stringify({ reportPath, steps: report.steps.map(step => step.name), photoFlow: report.photoFlow,
    hasNameRow: report.hasNameRow, hasUsernameRow: report.hasUsernameRow }, null, 2));
  return 0;
}

if (!process.argv[1] || process.argv[1] === '-' || process.argv[1].endsWith('instagram-probe.mjs')) {
  main().then(code => { process.exit(code); }).catch(error => {
    console.error(JSON.stringify({ step: 'instagram_probe', error: String(error?.message || error), code: errorCode(error) }));
    process.exit(1);
  });
}
