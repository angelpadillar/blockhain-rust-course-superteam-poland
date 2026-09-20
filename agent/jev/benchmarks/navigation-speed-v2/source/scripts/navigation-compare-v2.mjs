import { readFile, mkdir } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import { loadSettings, assert } from '../src/config.mjs';
import { acquireProfileLock, saveJson } from '../src/storage.mjs';
import { browserEnvironment } from '../src/glovo.mjs';
import { recoverNavigationJournals } from '../src/navigation-journal.mjs';
import { createNavigationDiagnostics } from '../src/navigation-diagnostics.mjs';
import { createJev } from '../src/jev.mjs';
import { navigationUrl, blocksNavigationMutation, runNavigation, repeatAuthorizedAgeConfirmation } from '../src/navigation.mjs';
import { runNavigationCandidate } from '../src/navigation-candidate-v2.mjs';
import { comparisonProtocol, createComparisonJournal, shouldStopComparison } from '../src/navigation-comparison-v2.mjs';

assert(process.argv.slice(2).every(a => ['--key-stdin', '--repeat-confirmed-age'].includes(a) || a.startsWith('--task=')), 'unsupported_comparison_argument');
const settings = await loadSettings();
const taskPath = process.argv.find(a => a.startsWith('--task='))?.slice(7) || 'cases/foczka-navigation.json';
const task = JSON.parse(await readFile(taskPath, 'utf8'));
const protocol = await comparisonProtocol(task);
const repeatAge = process.argv.includes('--repeat-confirmed-age');
let key = settings.apiKey;
if (process.argv.includes('--key-stdin')) {
  console.log('Ready for Typesafe key on stdin; input must be hidden by the caller.');
  const lines = createInterface({ input: process.stdin, terminal: false });
  key = await new Promise(resolve => lines.once('line', resolve));
  lines.close(); process.stdin.pause();
}
const results = [], batchId = new Date().toISOString().replace(/[:.]/g, '-');
const environment = 'Hetzner VPS; identical Playwright Chromium image, existing Glovo account/profile, 1440x1000 pl-PL Europe/Warsaw';
const controller = new AbortController(), cancel = () => controller.abort();
process.once('SIGINT', cancel); process.once('SIGTERM', cancel);
let release, decide, batchReason = null;
const batchDirectory = join(settings.dataDir, 'navigation', 'comparisons');
const batchPath = join(batchDirectory, `${batchId}.json`);
async function saveBatch() {
  await mkdir(batchDirectory, { recursive: true, mode: 0o700 });
  await saveJson(batchPath, { batchId, capturedAt: new Date().toISOString(), task, protocol, environment, batchReason,
    ageConfirmationPolicy: repeatAge ? 'Account holder authorized repeating the exact existing declaration for this navigation-only case; time included.' : 'Manual confirmation required.',
    pricing: { inputUsdPerMillion: settings.config.inputUsdPerMillion, outputUsdPerMillion: settings.config.outputUsdPerMillion,
      scope: 'Estimated model API costs only; excludes infrastructure, setup and operator work.' }, results });
}
try {
  release = await acquireProfileLock(settings.dataDir);
  await recoverNavigationJournals(settings.dataDir);
  await saveBatch();
  for (const [index, arm] of protocol.sequence.entries()) {
    controller.signal.throwIfAborted();
    const run = index + 1, pair = Math.floor(index / 2) + 1;
    const journal = await createComparisonJournal(settings.dataDir, { task, config: settings.config, environment, batchId, run, arm, pair, protocol });
    const diagnostics = createNavigationDiagnostics({ journal, abort: reason => controller.abort(reason) });
    // Persist every started attempt before browser/API work, even if its terminal
    // journal write later fails. A partial batch must not hide billed attempts.
    results.push({ run, pair, arm, journalId: journal.id, sourceSha256: protocol.sourceHashes[arm],
      status: 'starting', completionVerified: false });
    await saveBatch();
    let context, result, blockedMutations = 0, browserLaunchMs = null;
    const attemptStarted = performance.now();
    try {
      decide ||= createJev({ apiKey: key, model: settings.config.model }); key = null;
      await diagnostics.onEvent({ type: 'browser_launch_planned' });
      controller.signal.throwIfAborted();
      const launchStarted = performance.now();
      context = await chromium.launchPersistentContext(join(settings.dataDir, 'profile'), {
        headless: true, chromiumSandbox: true, env: browserEnvironment(), acceptDownloads: false, serviceWorkers: 'block',
        locale: 'pl-PL', timezoneId: 'Europe/Warsaw', viewport: { width: 1440, height: 1000 },
      });
      await context.route('**/*', async route => {
        const request = route.request();
        if (blocksNavigationMutation(request.method(), request.url(), { task, postData: request.postData() })) {
          blockedMutations++;
          return diagnostics.blockMutation(request.method(), request.url(), () => route.abort());
        }
        if (request.isNavigationRequest() && !navigationUrl(request.url())) return route.abort();
        return route.continue();
      });
      const page = await context.newPage();
      for (const other of context.pages()) if (other !== page) await other.close();
      context.on('page', popup => { if (popup !== page) void popup.close(); });
      page.on('dialog', dialog => void dialog.dismiss()); page.setDefaultTimeout(5000);
      browserLaunchMs = performance.now() - launchStarted;
      await diagnostics.onEvent({ type: 'browser_launched', browserLaunchMs });
      const runner = arm === 'baseline' ? runNavigation : runNavigationCandidate;
      result = await runner({ page, task, decide, config: settings.config,
        ...(repeatAge ? { confirmAge: repeatAuthorizedAgeConfirmation } : {}),
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(task.maxRunMs)]),
        onEvent: event => diagnostics.onEvent(event),
        onStep: step => console.log(JSON.stringify({ run, arm, step: step.step, outcome: step.outcome, modelMs: step.modelMs })) });
    } catch (error) {
      result = { status: 'incomplete', reason: error.code || (controller.signal.aborted ? 'AbortError' : 'startup_failed'),
        completionVerified: false, basketActions: 0, purchaseActions: 0 };
    } finally {
      if (context) {
        try { await context.close(); }
        catch { result = { ...result, status: 'incomplete', reason: 'browser_close_failed', completionVerified: false }; }
      }
    }
    try { await diagnostics.flush(); }
    catch { result = { ...result, status: 'incomplete', reason: 'navigation_journal_failed', completionVerified: false }; }
    let completed = { run, pair, arm, journalId: journal.id, sourceSha256: protocol.sourceHashes[arm],
      browserLaunchMs, fullAttemptMs: performance.now() - attemptStarted, blockedMutations, ...result };
    try { await diagnostics.finish(completed); }
    catch { completed = { ...completed, status: 'incomplete', reason: 'navigation_journal_failed', completionVerified: false }; }
    results[index] = completed; await saveBatch();
    console.log(JSON.stringify({ run, arm, journalId: journal.id, status: completed.status, reason: completed.reason,
      metrics: result.metrics, verification: result.verification, browserLaunchMs, fullAttemptMs: completed.fullAttemptMs, blockedMutations }));
    if (shouldStopComparison(completed) || controller.signal.aborted) { batchReason = 'stopped_after_attention_required'; break; }
  }
} catch (error) {
  batchReason = error.code || (controller.signal.aborted ? 'cancelled_or_timed_out' : 'comparison_failed');
  process.exitCode = 1;
} finally {
  key = null;
  try { await saveBatch(); } finally {
    if (release) await release();
    process.removeListener('SIGINT', cancel); process.removeListener('SIGTERM', cancel);
  }
}
if (results.length !== protocol.sequence.length || results.some(r => r.status !== 'reached_target')) process.exitCode = 1;
console.log(JSON.stringify({ batchId, batchReason, recordedAttempts: results.length,
  completedRuns: results.filter(r => !['starting', 'running'].includes(r.status)).length,
  passed: results.filter(r => r.status === 'reached_target' && r.verification?.passed).length }));
