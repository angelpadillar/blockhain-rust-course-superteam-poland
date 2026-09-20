import { chromium } from 'playwright-core';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { assert, Stop } from './config.mjs';
import { allowedUrl, allowedSetupUrl, isCheckout, candidates, fingerprint, blocksMutation } from './policy.mjs';

import { readShoppingDom, parseObservation } from './dom.mjs';
export { readShoppingDom, parseObservation } from './dom.mjs';

const CONTROL = 'a,button,input,textarea,[role="button"],[role="option"],[role="tab"]';
export function browserEnvironment() {
  return Object.fromEntries(['PATH', 'HOME', 'LANG', 'DISPLAY', 'XDG_RUNTIME_DIR', 'TMPDIR']
    .filter(key => process.env[key]).map(key => [key, process.env[key]]));
}

export class GlovoAdapter {
  constructor(page, config) { this.page = page; this.config = config; }
  async observeSetup() {
    assert(allowedSetupUrl(this.page.url()), 'outside_setup_pages');
    return parseObservation(await this.page.locator('body').evaluate(readShoppingDom), this.page.url(), this.config);
  }
  async observe() {
    assert(allowedUrl(this.page.url(), this.config), 'outside_configured_store');
    return parseObservation(await this.page.locator('body').evaluate(readShoppingDom), this.page.url(), this.config);
  }
  async waitReady(signal, checkout = false) {
    const until = Date.now() + 10000;
    while (Date.now() < until) {
      signal.throwIfAborted();
      const observation = await this.observe();
      if (observation.blocked) throw new Stop('browser_challenge');
      if (observation.unavailable) throw new Stop('merchant_unavailable');
      if (checkout ? observation.checkoutReady : observation.cartKnown) return observation;
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    throw new Stop(checkout ? 'checkout_not_rendered' : 'cart_not_readable');
  }
  async execute(action, job, signal) {
    signal.throwIfAborted();
    const fresh = await this.observe();
    assert(!isCheckout(fresh.url), 'checkout_is_read_only');
    const valid = candidates(fresh, job, this.config).find(a => a.kind === action.kind && a.value === action.value
      && fingerprint(a.control) === fingerprint(action.control));
    assert(valid, 'stale_or_forbidden_action');
    const locator = this.page.locator(CONTROL).nth(valid.control.index);
    assert(await locator.isVisible() && await locator.isEnabled(), 'control_unavailable');
    if (valid.kind === 'click') await locator.click({ timeout: 5000 });
    else if (valid.kind === 'fill') await locator.fill(valid.value, { timeout: 5000 });
    else if (valid.kind === 'press') await locator.press('Enter', { timeout: 5000 });
    // Debounced search and client-side basket updates count as browser time.
    let last = '', stableSince = Date.now();
    const until = Date.now() + 6000;
    while (Date.now() < until) {
      signal.throwIfAborted();
      const next = await this.observe();
      const signature = JSON.stringify(next);
      if (signature !== last) { last = signature; stableSince = Date.now(); }
      if (Date.now() - stableSince >= 700) return;
      await new Promise(resolve => setTimeout(resolve, 150));
    }
  }
}

export async function openBrowser({ dataDir, config, headless = true, onboard = false, managedSignals = false }) {
  const profile = join(dataDir, 'profile');
  await mkdir(profile, { recursive: true, mode: 0o700 });
  const context = await chromium.launchPersistentContext(profile, {
    headless, chromiumSandbox: process.env.JEV_CHROMIUM_SANDBOX !== 'false',
    handleSIGINT: !managedSignals, handleSIGTERM: !managedSignals, handleSIGHUP: !managedSignals,
    env: browserEnvironment(), acceptDownloads: false, serviceWorkers: 'block',
    locale: 'pl-PL', timezoneId: 'Europe/Warsaw', viewport: { width: 1440, height: 1000 },
    ...(process.env.JEV_BROWSER_CHANNEL ? { channel: process.env.JEV_BROWSER_CHANNEL } : {}),
  });
  try {
    const page = await context.newPage();
    // Close restored tabs so a previous checkout cannot perform background work.
    for (const other of context.pages()) if (other !== page) await other.close();
    if (!onboard) {
      await context.route('**/*', async route => {
        const request = route.request();
        if (blocksMutation(request.method(), request.url())
          || (request.isNavigationRequest() && request.frame() === page.mainFrame() && !allowedUrl(request.url(), config))) {
          await route.abort();
        } else await route.continue();
      });
      context.on('page', async popup => { if (popup !== page) await popup.close().catch(() => {}); });
      page.on('dialog', dialog => void dialog.dismiss().catch(() => {}));
    }
    page.setDefaultTimeout(5000);
    const startUrl = onboard && config.expectedAccountLabel
      ? config.storeUrl.replace(/\/stores\/[^/]+\/?$/, '/categories/jedzenie_1') : config.storeUrl;
    await page.goto(startUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    return { page, context, adapter: new GlovoAdapter(page, config), close: () => context.close() };
  } catch (error) { await context.close(); throw error; }
}
