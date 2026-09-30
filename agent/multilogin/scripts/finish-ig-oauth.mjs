import { readFile } from 'node:fs/promises';
import { requireThat, totp } from '../src/core.mjs';
import { loadPlaywright } from '../src/runner.mjs';

// Finish an Instagram ⇄ Upload-Post OAuth flow in an ALREADY-RUNNING parked
// browser: saved-profile picker -> password -> TOTP (if asked) -> Allow consent.
// Side-attaches to the launcher CDP port; never closes other tabs and never
// stops the profile. CAPTCHA/challenges stop as human_required.
//
// Usage:
//   node scripts/finish-ig-oauth.mjs --port <cdp-port> --ref K02 \
//     [--accounts-file /data/accounts.json] [--timeout-ms 150000]

export function parseArguments(argv) {
  const options = { positional: [] };
  const valueFlags = ['--port', '--ref', '--handle', '--accounts-file', '--timeout-ms', '--goto-file', '--goto'];
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

const textOf = (page) => page.evaluate(() => (document.body?.innerText || '').replace(/\s+/g, ' ')).catch(() => '');

async function firstVisible(page, selectors) {
  for (const selector of selectors) {
    const control = page.locator(selector).first();
    if (await control.isVisible().catch(() => false)) return control;
  }
  return null;
}

async function clickText(page, patterns) {
  for (const pattern of patterns) {
    const control = page.getByRole('button', { name: pattern }).first();
    if (await control.isVisible().catch(() => false) && await control.isEnabled().catch(() => false)) {
      await control.click({ timeout: 8000 }).catch(() => {});
      return true;
    }
    const link = page.locator('a, [role="button"]').filter({ hasText: pattern }).first();
    if (await link.isVisible().catch(() => false)) {
      await link.click({ timeout: 8000 }).catch(() => {});
      return true;
    }
  }
  return false;
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArguments(argv);
  const port = Number(options.port);
  requireThat(Number.isInteger(port) && port > 0, 'port_required');
  const accounts = JSON.parse(await readFile(options['accounts-file'] || '/data/accounts.json', 'utf8'));
  const key = options.ref || options.handle;
  const record = accounts.find((entry) => entry.ref === key
    || String(entry.username).toLowerCase() === String(key || '').toLowerCase()
    || String(entry.previousUsername ?? '').toLowerCase() === String(key || '').toLowerCase());
  requireThat(record?.password, 'credential_not_found');
  const candidates = [...new Set([record.username, record.previousUsername].filter(Boolean))];
  const timeoutMs = Number(options['timeout-ms'] || 150000);
  const { chromium } = await loadPlaywright();
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: 15000 });
  const context = browser.contexts()[0];
  requireThat(context, 'missing_context');

  const report = { step: 'finish_ig_oauth', ref: key, port, status: null, url: null, steps: [] };
  const hostOf = (url) => { try { return new URL(url).hostname; } catch { return ''; } };
  const newest = () => {
    const pages = context.pages().filter((candidate) => !candidate.isClosed());
    const callback = pages.find((candidate) => /app\.upload-post\.com$/i.test(hostOf(candidate.url())));
    if (callback) return callback;
    const ig = pages.filter((candidate) => /instagram\.com$/i.test(hostOf(candidate.url())));
    return ig.length ? ig[ig.length - 1] : pages[pages.length - 1];
  };

  const gotoUrl = options.goto || (options['goto-file'] ? (await readFile(options['goto-file'], 'utf8')).trim() : null);
  if (gotoUrl) {
    const page = newest();
    await page.goto(gotoUrl, { waitUntil: 'commit', timeout: 45000 }).catch(() => {});
    await page.waitForLoadState('domcontentloaded', { timeout: 20000 }).catch(() => {});
    await page.waitForTimeout(4000);
    report.steps.push('goto_authorize');
  }

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const page = newest();
    if (!page) break;
    const url = page.url();
    report.url = url.split('?')[0];
    if (/app\.upload-post\.com$/i.test(hostOf(url))) {
      report.status = 'callback_reached';
      report.callbackUrl = url;
      report.callbackText = (await textOf(page)).slice(0, 300);
      break;
    }
    const text = await textOf(page);
    if (/captcha|recaptcha|unusual activity|suspicious/i.test(text)) {
      report.status = 'human_required';
      report.steps.push('captcha_detected');
      break;
    }
    const handled = await (async () => {
      const passField = await firstVisible(page, ['input[name="password"]', 'input[type="password"]']);
      if (passField) {
        const userField = await firstVisible(page, ['input[name="username"]', 'input[aria-label*="username" i]', 'input[type="text"]']);
        if (userField) await userField.fill(candidates[0]).catch(() => {});
        await passField.fill(record.password).catch(() => {});
        await page.waitForTimeout(500);
        await clickText(page, [/^log in$/i, /^continue$/i]);
        const submit = page.locator('button[type="submit"]').first();
        if (await submit.isVisible().catch(() => false)) await submit.click().catch(() => {});
        report.steps.push('password_submitted');
        await page.waitForTimeout(6000);
        return true;
      }
      const twoStep = /two_step_verification|two_factor|\/challenge\//i.test(url)
        || /authentication app|two-factor|6-digit code|confirmation code/i.test(text);
      if (twoStep && record.totp) {
        // Wait for the code input to render before touching any Continue control.
        let codeField = null;
        const codeDeadline = Date.now() + 20000;
        while (Date.now() < codeDeadline) {
          codeField = await firstVisible(page, ['input[placeholder="Code" i]', 'input[name="verificationCode"]', 'input[name="securityCode"]',
            'input[autocomplete="one-time-code"]', 'input[inputmode="numeric"]', 'input[aria-label*="code" i]',
            'input[type="text"]']);
          if (codeField && await codeField.isEditable().catch(() => false)) break;
          codeField = null;
          await page.waitForTimeout(1200);
        }
        if (codeField) {
          const { code } = totp(record.totp);
          await codeField.fill(code).catch(() => {});
          const trust = page.getByRole('checkbox', { name: /trust this device/i }).first();
          if (await trust.isVisible().catch(() => false) && !(await trust.isChecked().catch(() => true))) await trust.click().catch(() => {});
          await page.waitForTimeout(400);
          const submit = page.locator('button[type="submit"]').first();
          if (await submit.isVisible().catch(() => false)) await submit.click().catch(() => {});
          else await clickText(page, [/^continue$/i, /^confirm$/i, /^next$/i]);
          report.steps.push('totp_submitted');
          await page.waitForTimeout(10000);
          return true;
        }
      }
      if (await clickText(page, [/^continue as\b/i])) { report.steps.push('picker_continue'); await page.waitForTimeout(5000); return true; }
      if (await clickText(page, [/^allow$/i, /^authorize$/i, /^agree$/i])) { report.steps.push('consent_allow'); await page.waitForTimeout(5000); return true; }
      if (await clickText(page, [/^not now$/i])) { report.steps.push('not_now'); await page.waitForTimeout(2500); return true; }
      return false;
    })();
    if (!handled) await page.waitForTimeout(1500);
  }
  if (!report.status) report.status = /app\.upload-post\.com$/i.test(hostOf(report.url)) ? 'callback_reached' : 'timeout';
  console.log(JSON.stringify(report, null, 2));
  process.exit(report.status === 'callback_reached' ? 0 : 2);
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main().catch((error) => {
    console.error(JSON.stringify({ status: 'error', error: String(error?.message ?? error) }));
    process.exit(2);
  });
}
