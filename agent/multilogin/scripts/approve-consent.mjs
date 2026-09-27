import { requireThat } from '../src/core.mjs';
import { loadPlaywright } from '../src/runner.mjs';

// Click the consent/allow control in an ALREADY-RUNNING browser profile without
// disturbing other tabs and without restarting any login flow. Side-attaches to
// the launcher's CDP port, finds the Google/Instagram consent page, selects
// scopes if needed, clicks Continue/Allow, and waits for the Upload-Post callback.
//
// Usage:
//   node scripts/approve-consent.mjs --port <cdp-port> [--timeout-ms 60000]

export function parseArguments(argv) {
  const options = { positional: [] };
  const valueFlags = ['--port', '--timeout-ms'];
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

function hostOf(url) {
  try { return new URL(url).hostname; } catch { return ''; }
}
const isConsent = (url) => /accounts\.google\.com$/i.test(hostOf(url)) || /instagram\.com$/i.test(hostOf(url)) && /\/consent\//.test(url);
const isCallback = (url) => /app\.upload-post\.com$/i.test(hostOf(url));

export async function main(argv = process.argv.slice(2)) {
  const options = parseArguments(argv);
  const port = Number(options.port);
  requireThat(Number.isInteger(port) && port > 0, 'port_required');
  const timeoutMs = Number(options['timeout-ms'] || 90000);
  const { chromium } = await loadPlaywright();
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: 15000 });
  const context = browser.contexts()[0];
  requireThat(context, 'missing_context');
  const report = { step: 'approve_consent', port, status: null, url: null, clicked: [], pages: [] };

  const pick = () => {
    const pages = context.pages().filter((candidate) => !candidate.isClosed());
    const callback = pages.find((candidate) => isCallback(candidate.url()));
    if (callback) return { page: callback, kind: 'callback' };
    const consent = pages.filter((candidate) => isConsent(candidate.url()));
    if (consent.length) return { page: consent[consent.length - 1], kind: 'consent' };
    return pages.length ? { page: pages[pages.length - 1], kind: 'other' } : null;
  };

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const selected = pick();
    if (!selected) break;
    const page = selected.page;
    report.url = page.url();
    report.pages = context.pages().map((candidate) => candidate.url().split('?')[0]).slice(0, 12);
    if (selected.kind === 'callback') {
      report.status = 'callback_reached';
      break;
    }
    // Select all scopes when Google offers it.
    const selectAll = page.getByRole('checkbox', { name: /select all/i }).first();
    if (await selectAll.isVisible().catch(() => false) && !(await selectAll.isChecked().catch(() => true))) {
      await selectAll.click().catch(() => {});
      report.clicked.push('select_all');
      await page.waitForTimeout(800);
    }
    let clicked = null;
    for (const pattern of [/^continue$/i, /^allow$/i]) {
      const control = page.getByRole('button', { name: pattern }).first();
      if (await control.isVisible().catch(() => false) && await control.isEnabled().catch(() => false)) {
        clicked = String(pattern);
        await control.click({ timeout: 8000 }).catch(() => {});
        break;
      }
    }
    if (clicked) {
      report.clicked.push(clicked);
      await page.waitForTimeout(3000);
      continue;
    }
    await page.waitForTimeout(1500);
  }
  if (!report.status) {
    const selected = pick();
    report.url = selected?.page?.url() ?? report.url;
    report.status = selected?.kind === 'callback' ? 'callback_reached' : 'consent_not_found';
  }
  console.log(JSON.stringify(report, null, 2));
  // Disconnect without closing the browser: exit the process.
  process.exit(report.status === 'callback_reached' ? 0 : 2);
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main().catch((error) => {
    console.error(JSON.stringify({ status: 'error', error: String(error?.message ?? error) }));
    process.exit(2);
  });
}
