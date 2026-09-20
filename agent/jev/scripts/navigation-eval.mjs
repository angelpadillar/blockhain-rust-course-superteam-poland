import { readFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import { loadSettings, assert } from '../src/config.mjs';
import { acquireProfileLock, saveJson } from '../src/storage.mjs';
import { browserEnvironment } from '../src/glovo.mjs';
import { createNavigationJournal, recoverNavigationJournals } from '../src/navigation-journal.mjs';
import { createNavigationDiagnostics } from '../src/navigation-diagnostics.mjs';
import { createJev } from '../src/jev.mjs';
import { navigationUrl, blocksNavigationMutation, runNavigation, repeatAuthorizedAgeConfirmation, navigationContract } from '../src/navigation.mjs';

const settings = await loadSettings();
const taskPath = process.argv.find(a => a.startsWith('--task='))?.slice(7) || 'cases/foczka-navigation.json';
const task = JSON.parse(await readFile(taskPath, 'utf8'));
navigationContract(task);
const runs = Number(process.argv.find(a => a.startsWith('--runs='))?.split('=')[1] || 1);
assert(Number.isInteger(runs) && runs >= 1 && runs <= 5, 'invalid_run_count');
let key = settings.apiKey;
if (process.argv.includes('--key-stdin')) {
  console.log('Ready for Typesafe key on stdin; input must be hidden by the caller.');
  const lines = createInterface({ input: process.stdin, terminal: false });
  key = await new Promise(resolve => lines.once('line', resolve));
  lines.close(); process.stdin.pause();
}
const results = [], batchId = new Date().toISOString().replace(/[:.]/g, '-');
const environment = 'Hetzner VPS, Playwright Chromium, existing manually configured Glovo account';
const repeatAge = process.argv.includes('--repeat-confirmed-age');
let release, decide;
const controller = new AbortController();
const cancel = () => controller.abort();
process.once('SIGINT', cancel); process.once('SIGTERM', cancel);
async function journalFor(run) {
  return createNavigationJournal(settings.dataDir, { task, config: settings.config, environment, batchId, run });
}
async function saveBatch() {
  await saveJson(join(settings.dataDir, 'navigation', `${batchId}.json`), {
    batchId, capturedAt: new Date().toISOString(), task, environment,
    ageConfirmationPolicy: repeatAge
      ? 'Account holder explicitly authorized repeating the existing 18+/terms declaration for this navigation-only case. Fixed handler; included in elapsed time.'
      : 'Manual age confirmation required; no automated acceptance.',
    pricing: { inputUsdPerMillion: settings.config.inputUsdPerMillion, outputUsdPerMillion: settings.config.outputUsdPerMillion,
      scope: 'Estimated model API cost only; excludes VPS, setup and operator time.' }, results });
}
try {
  release = await acquireProfileLock(settings.dataDir);
  await recoverNavigationJournals(settings.dataDir);
  for (let i = 0; i < runs; i++) {
    const journal = await journalFor(i + 1);
    const diagnostics = createNavigationDiagnostics({ journal, abort: reason => controller.abort(reason) });
    let context, result, blockedMutations = 0, launchMs = null;
    try {
      decide ||= createJev({ apiKey: key, model: settings.config.model }); key = null;
      await diagnostics.onEvent({ type: 'browser_launch_planned' });
      controller.signal.throwIfAborted();
      const launchStarted = performance.now();
      context = await chromium.launchPersistentContext(join(settings.dataDir, 'profile'), {
        headless: true, chromiumSandbox: true, env: browserEnvironment(),
        acceptDownloads: false, serviceWorkers: 'block', locale: 'pl-PL', timezoneId: 'Europe/Warsaw', viewport: { width: 1440, height: 1000 },
      });
      await context.route('**/*', async route => {
        const r = route.request();
        if (blocksNavigationMutation(r.method(), r.url(), { task, postData: r.postData() })) {
          blockedMutations++;
          return diagnostics.blockMutation(r.method(), r.url(), () => route.abort());
        }
        if (r.isNavigationRequest() && !navigationUrl(r.url())) return route.abort();
        return route.continue();
      });
      const page = await context.newPage();
      for (const other of context.pages()) if (other !== page) await other.close();
      context.on('page', popup => { if (popup !== page) void popup.close(); });
      page.on('dialog', dialog => void dialog.dismiss()); page.setDefaultTimeout(5000);
      launchMs = performance.now() - launchStarted;
      await diagnostics.onEvent({ type: 'browser_launched', browserLaunchMs: launchMs });
      result = await runNavigation({ page, task, decide, config: settings.config,
        ...(repeatAge ? { confirmAge: repeatAuthorizedAgeConfirmation } : {}),
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(task.maxRunMs)]),
        onEvent: event => diagnostics.onEvent(event),
        onStep: step => console.log(JSON.stringify({ run: i + 1, action: step.action, actor: step.actor, modelMs: step.modelMs })) });
    } catch (error) {
      result = { status: 'incomplete', reason: error.code || error.name || 'startup_failed',
        completionVerified: false, basketActions: 0, purchaseActions: 0 };
    } finally {
      if (context) await context.close();
    }
    try { await diagnostics.flush(); }
    catch { result = { ...result, status: 'incomplete', reason: 'navigation_journal_failed', completionVerified: false }; }
    const completed = { run: i + 1, journalId: journal.id, browserLaunchMs: launchMs, blockedMutations, ...result };
    await diagnostics.finish(completed);
    results.push(completed); await saveBatch();
    console.log(JSON.stringify({ run: i + 1, journalId: journal.id, status: result.status, reason: result.reason,
      metrics: result.metrics, verification: result.verification, blockedMutations }));
    if (result.status !== 'reached_target') { process.exitCode = 1; break; }
  }
} catch (error) {
  // Lock/startup failures are attempts too. Never silently erase the earlier journal.
  const journal = await journalFor(results.length + 1);
  const result = { run: results.length + 1, journalId: journal.id, status: 'incomplete',
    reason: error.code || error.name || 'evaluation_failed', completionVerified: false };
  await journal.finish(result); results.push(result); await saveBatch(); process.exitCode = 1;
} finally {
  key = null;
  if (release) await release();
  process.removeListener('SIGINT', cancel); process.removeListener('SIGTERM', cancel);
}
console.log(JSON.stringify({ batchId, completedRuns: results.length, passed: results.filter(r => r.status === 'reached_target').length }));
