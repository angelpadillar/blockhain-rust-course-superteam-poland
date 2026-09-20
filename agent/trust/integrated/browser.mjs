import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
let playwright;
try { playwright = require('../../jev/node_modules/playwright-core'); }
catch { playwright = require('../../hackathon/jev/node_modules/playwright-core'); }

export async function openFixtureBrowser(origin) {
  const browser = await playwright.chromium.launch({ channel: process.env.GIFTING_BROWSER_CHANNEL || 'chrome', headless: true, chromiumSandbox: true });
  const context = await browser.newContext({ viewport: { width: 1200, height: 900 }, serviceWorkers: 'block' });
  await context.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
  const page = await context.newPage(), evidencePage = await context.newPage();
  const read = async (confirmation = false) => {
    const keys = ['merchantId', 'merchant', 'itemId', 'item', 'variant', 'quantity', 'recipientId', 'recipient', 'currency', 'totalMinor', ...(confirmation ? ['orderId', 'attemptId', 'status'] : [])];
    const value = {};
    for (const key of keys) value[key] = await page.locator(`[data-field="${key}"]`).innerText({ timeout: 4000 });
    value.quantity = Number(value.quantity); value.totalMinor = Number(value.totalMinor);
    return value;
  };
  return {
    version: browser.version(),
    async checkout(runId) { await page.goto(`${origin}/merchant/${runId}/checkout`); return read(); },
    async dispatch(runId, attemptId) {
      await page.getByLabel('Confirmed attempt reference').fill(attemptId);
      await Promise.all([page.waitForURL(url => !url.pathname.endsWith('/checkout')), page.getByRole('button', { name: 'Place simulated order' }).click()]);
      if (new URL(page.url()).pathname.endsWith('/uncertain')) return { uncertain: true };
      return { observed: await read(true) };
    },
    async order(runId, orderId) { await page.goto(`${origin}/merchant/${runId}/orders/${orderId}`); return read(true); },
    async capture(stage, runId) {
      const target = stage === 'approval' ? evidencePage : page;
      if (stage === 'approval') await target.goto(`${origin}/evidence-view/${runId}`);
      return { bytes: await target.screenshot({ type: 'png', fullPage: true }), url: target.url(), title: await target.title() };
    },
    close: () => browser.close(),
  };
}
