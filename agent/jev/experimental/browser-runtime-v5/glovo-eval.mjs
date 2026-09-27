// Live Glovo Kraków navigation eval for the v5 runtime — the before/after
// arm against the 13.6s baseline. Same authorized read-only route, same
// persistent profile, same independent verifier; the loop and its metrics
// are v5's. Run inside the jev-hackathon image with the jev-data volume:
//   docker run --rm -v jev-hackathon_jev-data:/app/data -v /opt/jev-v5:/jev-v5 \
//     -e JEV_CONFIG=/jev-v5/cases/config.local.json jev-hackathon-onboarding \
//     sh -c 'ln -sfn /app/node_modules /jev-v5/node_modules; \
//       node /jev-v5/experimental/browser-runtime-v5/glovo-eval.mjs --key-stdin --repeat-confirmed-age'
import { readFile, mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { chromium } from 'playwright-core';
import { loadSettings, normalize, Stop } from '../../src/config.mjs';
import { acquireProfileLock, saveJson } from '../../src/storage.mjs';
import { browserEnvironment } from '../../src/glovo.mjs';
import { navigationUrl, navigationContract } from '../../src/navigation.mjs';
import { createLedger } from '../browser-runtime-v3/providers.mjs';
import { readHiddenKey } from '../browser-runtime-v4/session.mjs';
import { runLoop } from './runtime.mjs';
import { createJevDecider } from './jev.mjs';
import { glovoSpec, glovoRequestFilter, verifyGlovo, glovoNavigationUrl } from './glovo.mjs';

const args = process.argv.slice(2);
const taskPath = args.find(a => a.startsWith('--task='))?.slice(7)
  || fileURLToPath(new URL('./cases/foczka-navigation.json', import.meta.url));
const task = JSON.parse(await readFile(taskPath, 'utf8'));
navigationContract(task);
const runs = Number(args.find(a => a.startsWith('--runs='))?.split('=')[1] || 1);
if (!Number.isInteger(runs) || runs < 1 || runs > 5) throw new Stop('invalid_run_count');
const repeatAge = args.includes('--repeat-confirmed-age');
const outputRoot = args.find(a => a.startsWith('--output-dir='))?.slice(13);

const settings = await loadSettings();
const key = args.includes('--key-stdin') ? await readHiddenKey() : settings.apiKey;
const batchId = `glovo-v5-${new Date().toISOString().replace(/[:.]/g, '-')}`;
const directory = resolve(outputRoot || join(settings.dataDir, 'navigation-v5', batchId));
await mkdir(directory, { recursive: true, mode: 0o700 });
const environment = 'Hetzner VPS, Playwright Chromium persistent profile, existing manually configured Glovo account';
const batch = { batchId, status: 'starting', environment, taskId: task.id,
  ageConfirmationPolicy: repeatAge
    ? 'Account holder explicitly authorized repeating the existing 18+/terms declaration for this navigation-only case. Fixed deterministic handler; included in elapsed time.'
    : 'Manual age confirmation required; age-dialog controls are policy-excluded so the model cannot consent itself.',
  scope: 'Read-only catalogue navigation: find store, open product, verify identity. No basket, order, payment, account or upload action is offered or permitted.',
  pricing: { inputUsdPerMillion: settings.config.inputUsdPerMillion, outputUsdPerMillion: settings.config.outputUsdPerMillion },
  results: [] };
await saveJson(join(directory, 'batch.json'), batch);

let release;
const controller = new AbortController();
const cancel = () => controller.abort();
process.once('SIGINT', cancel); process.once('SIGTERM', cancel);
const sources = ['glovo-eval.mjs', 'glovo.mjs', 'runtime.mjs', 'session.mjs', 'snapshot.mjs', 'questions.mjs',
  'policy.mjs', 'donewhen.mjs', 'jev.mjs', '../browser-runtime-v3/providers.mjs', '../browser-runtime-v4/session.mjs',
  '../../src/jev.mjs', '../../src/navigation.mjs', '../../src/storage.mjs', '../../src/glovo.mjs', '../../src/config.mjs'];
async function fingerprint() {
  const hashes = {};
  for (const file of sources) hashes[file] = createHash('sha256').update(await readFile(new URL(file, import.meta.url))).digest('hex');
  return { hashes, sha256: createHash('sha256').update(JSON.stringify(hashes)).digest('hex') };
}
batch.sourceSha256 = (await fingerprint()).sha256;

try {
  release = await acquireProfileLock(settings.dataDir);
  for (let i = 0; i < runs; i++) {
    const row = { run: i + 1, status: 'starting', events: [], journalMs: 0, journalWrites: 0 };
    const path = join(directory, `attempt-${i + 1}.json`); batch.results.push(row);
    let tail = Promise.resolve();
    const persist = () => {
      tail = tail.catch(() => {}).then(async () => {
        const before = performance.now();
        try { await saveJson(path, structuredClone(row)); }
        catch { row.journalError = 'journal_write_failed'; throw new Stop('journal_write_failed'); }
        finally { row.journalMs += performance.now() - before; row.journalWrites++; }
      });
      return tail;
    };
    const ledger = createLedger({ maxCalls: 40, maxUsd: task.maxModelUsd,
      onEvent: async event => { row.events.push(event); row.accounting = ledger.summary(); await persist(); } });
    let context;
    try {
      const launchStarted = performance.now();
      context = await chromium.launchPersistentContext(join(settings.dataDir, 'profile'), {
        headless: true, chromiumSandbox: true, env: browserEnvironment(),
        acceptDownloads: false, serviceWorkers: 'block', locale: 'pl-PL', timezoneId: 'Europe/Warsaw',
        viewport: { width: 1440, height: 1000 },
      });
      row.browserLaunchMs = performance.now() - launchStarted;
      const counters = { blockedMutations: 0 };
      const filter = glovoRequestFilter(task, counters);
      let page = null;
      await context.route('**/*', async route => {
        const request = route.request();
        const verdict = filter(request, { mainFrame: page ? request.frame() === page.mainFrame() : false });
        if (verdict === 'allow') await route.continue().catch(() => {});
        else await route.abort().catch(() => {});
      });
      page = await context.newPage();
      for (const other of context.pages()) if (other !== page) await other.close();
      context.on('page', popup => { if (popup !== page) void popup.close(); });
      page.on('dialog', dialog => void dialog.dismiss());
      page.setDefaultTimeout(5000);
      const started = performance.now();
      await page.goto(task.startUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
      row.navigationMs = performance.now() - started;
      if (page.url() !== task.startUrl && page.url() !== task.startUrl + '/') throw new Stop('wrong_navigation_start');
      // Destination precondition, identical to the v3 route: the configured
      // Kraków address must be visible before any step counts.
      const deadline = performance.now() + 8000;
      let destinationSeen = false;
      while (performance.now() < deadline) {
        const rawText = await page.locator('body').innerText().catch(() => '');
        if (/verify you are human|captcha challenge|potwierdź, że jesteś człowiekiem/i.test(rawText)) throw new Stop('browser_challenge');
        if (/Oh, no![\s\S]*It looks like there's a problem, but we're working on it\./i.test(rawText)) throw new Stop('merchant_site_unavailable');
        const pageText = ` ${normalize(rawText).replace(/,/g, '')} `;
        if (pageText.includes(` ${normalize(settings.config.expectedAddress).replace(/,/g, '')} `)) { destinationSeen = true; break; }
        await new Promise(resolve => setTimeout(resolve, 300));
      }
      if (!destinationSeen) throw new Stop('destination_requires_setup');
      row.destinationVerifiedAtMs = performance.now() - started;
      const decide = createJevDecider({ apiKey: key, model: settings.config.model, ledger });
      const spec = glovoSpec(task, { authorizeAgeConfirmation: repeatAge, expectedAddress: settings.config.expectedAddress });
      row.spec = { goal: spec.goal, doneWhen: spec.doneWhen };
      row.runtime = await runLoop({ page, spec, decide,
        allowedUrl: glovoNavigationUrl, requestFilter: filter,
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(task.maxRunMs)]),
        maxSteps: task.maxSteps, maxActions: 40, maxMs: task.maxRunMs, maxModelCalls: 40,
        onEvent: async event => { row.events.push(event); await persist(); } });
      row.reason = row.runtime.reason;
      row.blockedMutations = counters.blockedMutations;
      if (counters.denied?.length) row.deniedRequests = counters.denied.slice(0, 10);
      const verifyStarted = performance.now();
      try { row.verification = await verifyGlovo(page, task); }
      catch (error) { row.verification = { passed: false, reason: error.code || 'verification_failed' }; }
      row.verificationMs = performance.now() - verifyStarted;
      row.verifiedSuccess = row.runtime.status === 'completed' && row.verification.passed === true && !row.journalError;
      row.status = row.verifiedSuccess ? 'reached_target' : 'incomplete';
      row.basketActions = 0; row.purchaseActions = 0;
      row.taskMs = performance.now() - started;
    } catch (error) {
      row.status = 'incomplete'; row.verifiedSuccess = false;
      row.reason = error instanceof Stop || /^[a-z][a-z0-9_]{0,80}$/.test(error.code || '') ? error.code : 'evaluation_failed';
      row.error = String(error?.message || error).slice(0, 400);
    } finally {
      if (context) await context.close().catch(() => { row.cleanupError = 'context_close_failed'; });
      row.accounting = ledger.summary();
      await persist().catch(() => { row.journalError = 'journal_write_failed'; });
      await saveJson(join(directory, 'batch.json'), batch);
    }
    console.log(JSON.stringify({ run: i + 1, status: row.status, reason: row.reason, taskMs: row.taskMs,
      steps: row.runtime?.steps?.length, jevCalls: row.runtime?.metrics?.jevCalls,
      costUsd: row.accounting?.costUsd ?? null, verification: row.verification?.checks }));
    if (row.status !== 'reached_target') { process.exitCode = 1; break; }
  }
  batch.status = 'finished';
} catch (error) {
  batch.status = 'interrupted'; batch.stopReason = error.code || 'evaluation_failed'; process.exitCode = 1;
} finally {
  batch.finalSourceSha256 = (await fingerprint()).sha256;
  batch.sourceUnchanged = batch.sourceSha256 === batch.finalSourceSha256;
  await saveJson(join(directory, 'batch.json'), batch).catch(() => {});
  if (release) await release();
  process.removeListener('SIGINT', cancel); process.removeListener('SIGTERM', cancel);
}
console.log(JSON.stringify({ batchId, status: batch.status, runs: batch.results.length,
  passed: batch.results.filter(r => r.verifiedSuccess).length }));
