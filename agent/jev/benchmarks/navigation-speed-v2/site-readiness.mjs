// Read-only diagnostic: one ordinary homepage navigation, no model or input.
import { readFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import { loadSettings } from './src/config.mjs';
import { acquireProfileLock, saveJson } from './src/storage.mjs';
import { browserEnvironment } from './src/glovo.mjs';
import { navigationUrl, blocksNavigationMutation, readNavigationDom } from './src/navigation.mjs';

const settings = await loadSettings();
const task = JSON.parse(await readFile('cases/foczka-navigation.json', 'utf8'));
const directory = join(settings.dataDir, 'navigation', 'diagnostics');
await mkdir(directory, { recursive: true, mode: 0o700 });
const file = join(directory, `site-readiness-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
const report = { scope: 'One normal homepage navigation; observe for eight seconds; no inputs, reloads, model calls or cache changes.',
  status: 'starting', modelCalls: 0, inputActions: 0, blockedMutations: 0, samples: [] };
let context, release;
const started = performance.now();
try {
  release = await acquireProfileLock(settings.dataDir);
  await saveJson(file, report);
  context = await chromium.launchPersistentContext(join(settings.dataDir, 'profile'), {
    headless: true, chromiumSandbox: true, env: browserEnvironment(), acceptDownloads: false, serviceWorkers: 'block',
    locale: 'pl-PL', timezoneId: 'Europe/Warsaw', viewport: { width: 1440, height: 1000 },
  });
  await context.route('**/*', async route => {
    const request = route.request();
    if (blocksNavigationMutation(request.method(), request.url(), { task, postData: request.postData() })) {
      report.blockedMutations++; return route.abort();
    }
    if (request.isNavigationRequest() && !navigationUrl(request.url())) return route.abort();
    return route.continue();
  });
  const page = await context.newPage();
  for (const other of context.pages()) if (other !== page) await other.close();
  context.on('page', popup => { if (popup !== page) void popup.close(); });
  page.on('dialog', dialog => void dialog.dismiss());
  page.setDefaultTimeout(5000);
  const response = await page.goto(task.startUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
  report.navigationHttpStatus = response?.status() ?? null;
  const navigationFinished = performance.now();
  for (;;) {
    const observation = await page.locator('body').evaluate(readNavigationDom);
    report.samples.push({ elapsedAfterNavigationMs: performance.now() - navigationFinished,
      homepage: page.url() === task.startUrl || page.url() === task.startUrl + '/',
      siteUnavailable: observation.siteUnavailable, controlCount: observation.controls.length,
      headingCount: observation.headings.length });
    await saveJson(file, report);
    if (performance.now() - navigationFinished >= 8000) break;
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  report.status = 'completed';
} catch {
  report.status = 'diagnostic_failed';
} finally {
  if (context) await context.close().catch(() => { report.status = 'browser_close_failed'; });
  report.totalMs = performance.now() - started;
  await saveJson(file, report);
  if (release) await release();
}
console.log(JSON.stringify(report));
