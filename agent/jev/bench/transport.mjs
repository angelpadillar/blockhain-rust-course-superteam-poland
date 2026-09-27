import { chromium } from 'playwright-core';
import { browserEnvironment } from '../src/glovo.mjs';

const LOOPBACK_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);
const SUBRESOURCE_TYPES = new Set(['script', 'stylesheet', 'image', 'font', 'media', 'manifest', 'texttrack']);

function originNotLoopback() {
  const error = new Error('benchmark_origin_not_loopback');
  error.code = 'benchmark_origin_not_loopback';
  return error;
}

function assertLoopbackOrigin(origin) {
  let url;
  try {
    url = new URL(origin);
  } catch {
    throw originNotLoopback();
  }
  if (!['http:', 'https:'].includes(url.protocol) || !LOOPBACK_HOSTNAMES.has(url.hostname)) {
    throw originNotLoopback();
  }
}

export async function openProvider() {
  const started = performance.now();
  const browser = await chromium.launch({
    channel: process.env.JEV_BROWSER_CHANNEL || 'chrome',
    headless: process.env.BROWSER_BENCH_HEADFUL !== '1',
    chromiumSandbox: true,
    env: browserEnvironment(),
  });
  return {
    version: browser.version(),
    name: 'local-chrome-playwright',
    startupMs: performance.now() - started,
    async open({ origin, additionalOrigins = [] } = {}) {
      for (const candidate of [origin, ...additionalOrigins]) assertLoopbackOrigin(candidate);
      const context = await browser.newContext({
        viewport: { width: 1100, height: 800 },
        acceptDownloads: false,
        serviceWorkers: 'block',
      });
      const diagnostics = { requestFailures: 0, pageErrors: 0, blockedRequests: 0 };
      const allowed = new Set([origin, ...additionalOrigins]);
      await context.route('**/*', async route => {
        const req = route.request();
        let ok = false;
        try {
          const u = new URL(req.url());
          ok = allowed.has(u.origin) || (['GET', 'HEAD'].includes(req.method()) && !req.isNavigationRequest() && SUBRESOURCE_TYPES.has(req.resourceType()));
        } catch {}
        if (ok) await route.continue();
        else {
          diagnostics.blockedRequests++;
          await route.abort('blockedbyclient');
        }
      });
      const page = await context.newPage();
      page.on('requestfailed', () => diagnostics.requestFailures++);
      page.on('pageerror', () => diagnostics.pageErrors++);
      return { page, context, diagnostics, close: () => context.close() };
    },
    close: () => browser.close(),
  };
}
