import { readFile, mkdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
import { createInterface } from 'node:readline';
import { chromium } from 'playwright-core';
import { saveJson } from '../../src/storage.mjs';
import { browserEnvironment } from '../../src/glovo.mjs';
import { createFixtureServer } from './fixture.mjs';
import { runSearchAndOpen } from './runtime.mjs';
import { createLedger, createJevChooser, createOpenRouter, createOpenRouterChooser } from './providers.mjs';
import { readOpenRouterItem } from './credentials.mjs';
import { planGoal } from './planner.mjs';

const args = process.argv.slice(2);
if (args.some(a => !['--key-stdin'].includes(a) && !['--openrouter-item=', '--output-dir='].some(p => a.startsWith(p)))) throw new Error('unsupported_argument');
const item = args.find(a => a.startsWith('--openrouter-item='))?.slice('--openrouter-item='.length);
const root = resolve(args.find(a => a.startsWith('--output-dir='))?.slice('--output-dir='.length) || '../../benchmarks/browser-runtime-v3/results');
if (!item || !args.includes('--key-stdin')) throw new Error('Use --openrouter-item=REFERENCE --key-stdin; hide terminal input.');
const openrouterKey = await readOpenRouterItem(item);
console.log('Ready for Typesafe key on stdin; input must be hidden by the caller.');
const lines = createInterface({ input: process.stdin, terminal: false });
let typesafeKey = await new Promise(resolve => lines.once('line', resolve));
lines.close(); process.stdin.pause();
if (typesafeKey.length < 15) throw new Error('missing_typesafe_key');

const sources = ['browser.mjs', 'runtime.mjs', 'providers.mjs', 'planner.mjs', 'credentials.mjs', 'fixture.mjs', 'paid-benchmark.mjs',
  '../../src/jev.mjs', '../../src/storage.mjs', '../../src/glovo.mjs', '../../src/config.mjs', '../../src/policy.mjs', '../../src/dom.mjs',
  '../../package.json', '../../package-lock.json'];
async function fingerprint() {
  const hash = createHash('sha256');
  for (const file of sources) hash.update(file).update(await readFile(new URL(file, import.meta.url)));
  return hash.digest('hex');
}
const batchId = new Date().toISOString().replace(/[:.]/g, '-');
const directory = join(root, `paid-${batchId}`);
await mkdir(directory, { recursive: true, mode: 0o700 });
const sequence = [];
for (const caseId of ['enter-form', 'live-search', 'delayed-title', 'semantic-context']) {
  for (let repeat = 1; repeat <= 2; repeat++) {
    for (const mode of repeat % 2 ? ['stepwise', 'fast'] : ['fast', 'stepwise']) {
      sequence.push({ suite: 'goal_pipeline', caseId, repeat, mode, guide: 'jev', planner: 'openrouter' });
    }
  }
}
for (let repeat = 1; repeat <= 3; repeat++) {
  const order = ['jev', 'openrouter-dom', 'openrouter-dom-image'];
  for (const guide of [...order.slice(repeat - 1), ...order.slice(0, repeat - 1)]) {
    sequence.push({ suite: 'semantic_guidance', caseId: 'semantic-context', repeat, mode: 'fast', guide, planner: 'none_fixed_task' });
  }
}
const report = { batchId, sourceSha256: await fingerprint(), sourceFiles: sources, nodeVersion: process.version, status: 'starting', planned: sequence,
  methodology: { scope: 'Real model APIs on isolated, public synthetic catalogue pages; not Glovo or a broad unseen-site benchmark.',
    planning: 'Pipeline uses natural-language goals and a real OpenRouter planner, concurrently with initial navigation; same planner in both arms.',
    guidance: 'Fixed public semantic task isolates Jev versus OpenRouter DOM versus OpenRouter DOM plus screenshot. No answer URL or ID enters the policy.',
    comparison: 'Stepwise is the SAME new executor with extra 700 ms nonterminal waits; it is not the old deployed Glovo baseline.',
    timing: 'Total includes navigation, planning, runtime, journals and independent verification; browser/context setup and final result write excluded and recorded separately.',
    cost: 'OpenRouter reported account charge plus estimated Jev tokens at $0.042/M input, zero output. Separate BYOK fields retained if present; infrastructure excluded.',
    limits: '25 scheduled task attempts, six model calls/$0.01 per attempt; stop before further attempts on unknown usage/cost or $0.10 known batch cost.' }, results: [] };
await saveJson(join(directory, 'batch.json'), report);
let browser, fixture;
try {
  fixture = await createFixtureServer({ seed: 20260918 });
  const launch = performance.now();
  browser = await chromium.launch({ channel: process.env.JEV_BROWSER_CHANNEL || 'chrome', headless: true,
    chromiumSandbox: true, env: browserEnvironment() });
  report.browserLaunchMs = performance.now() - launch;
  report.browserVersion = browser.version();
  for (const [index, spec] of sequence.entries()) {
    const recorded = report.results.map(row => row.accounting).filter(Boolean);
    if (recorded.some(a => !a.usageComplete || !a.costComplete) || recorded.reduce((n, a) => n + a.knownCostUsd, 0) >= 0.10) {
      report.stopReason = 'accounting_or_batch_budget'; break;
    }
    const descriptor = fixture.cases.find(c => c.id === spec.caseId);
    if (!descriptor) throw new Error('missing_fixture_case');
    fixture.reset(spec.caseId);
    const row = { attempt: index + 1, ...spec, status: 'starting', events: [] };
    report.results.push(row);
    const path = join(directory, `attempt-${index + 1}.json`);
    const ledger = createLedger({ maxCalls: 6, maxUsd: 0.01, onEvent: async event => {
      row.events.push(event); row.accounting = ledger.summary(); await saveJson(path, row);
    } });
    await saveJson(path, row); await saveJson(join(directory, 'batch.json'), report);
    const setup = performance.now();
    let context, started;
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(30000)]);
    try {
      context = await browser.newContext({ viewport: { width: 1100, height: 800 }, acceptDownloads: false, serviceWorkers: 'block' });
      const page = await context.newPage();
      row.contextSetupMs = performance.now() - setup;
      started = performance.now();
      const complete = createOpenRouter({ apiKey: openrouterKey, ledger });
      let task;
      const goal = `Find ${descriptor.publicTask.targetText}${descriptor.publicTask.context ? ' from ' + descriptor.publicTask.context : ''} and open its details.`;
      const planning = performance.now();
      const outcomes = await Promise.allSettled([
        page.goto(descriptor.startUrl, { waitUntil: 'domcontentloaded', timeout: 10000 }).then(() => { row.navigationMs = performance.now() - started; }),
        (spec.planner === 'openrouter' ? planGoal({ goal, complete, signal }) : Promise.resolve(structuredClone(descriptor.publicTask)))
          .then(value => { task = value; row.planningMs = performance.now() - planning; }),
      ]);
      const failed = outcomes.find(outcome => outcome.status === 'rejected');
      if (failed) throw failed.reason;
      row.goal = goal; row.compiledTask = task;
      const choose = spec.guide === 'jev' ? createJevChooser({ apiKey: typesafeKey, ledger })
        : createOpenRouterChooser({ complete, ...(spec.guide === 'openrouter-dom-image' ? { screenshot: () => page.screenshot({ type: 'png', timeout: 5000 }) } : {}) });
      row.runtime = await runSearchAndOpen({ page, task, choose, signal, mode: spec.mode, maxMs: 18000,
        onEvent: async event => { row.events.push(event); await saveJson(path, row); } });
      row.verification = await fixture.verify(page, descriptor);
      row.verifiedSuccess = row.runtime.status === 'opened' && row.verification.passed;
      row.status = row.verifiedSuccess ? 'completed' : 'incomplete';
      row.reason = row.runtime.reason;
    } catch (error) {
      row.status = 'incomplete'; row.reason = typeof error.code === 'string' ? error.code : 'task_error'; row.verifiedSuccess = false;
    } finally {
      row.totalMs = started === undefined ? null : performance.now() - started;
      if (started === undefined) row.contextSetupMs = performance.now() - setup;
      controller.abort();
      row.accounting = ledger.summary();
      await saveJson(path, row);
      if (context) await context.close().catch(() => { row.cleanupError = 'context_close_failed'; });
      await saveJson(path, row); await saveJson(join(directory, 'batch.json'), report);
    }
    console.log(JSON.stringify({ attempt: row.attempt, suite: row.suite, caseId: row.caseId, mode: row.mode, guide: row.guide,
      status: row.status, reason: row.reason, totalMs: row.totalMs, modelCalls: row.accounting.modelCalls,
      chooserCalls: row.runtime?.metrics.chooserCalls, screenshotCalls: row.accounting.screenshotCalls, costUsd: row.accounting.costUsd }));
  }
  report.status = report.results.length === sequence.length ? 'finished' : 'partial';
} catch (error) { report.status = 'interrupted'; report.stopReason = typeof error.code === 'string' ? error.code : 'batch_error'; }
finally {
  typesafeKey = null;
  await saveJson(join(directory, 'batch.json'), report);
  if (browser) await browser.close().catch(() => { report.browserCleanupError = 'browser_close_failed'; });
  if (fixture) await fixture.close().catch(() => { report.fixtureCleanupError = 'fixture_close_failed'; });
  try { report.sourceUnchanged = report.sourceSha256 === await fingerprint(); }
  catch { report.sourceUnchanged = false; report.fingerprintError = 'source_unreadable'; }
  await saveJson(join(directory, 'batch.json'), report);
}
console.log(JSON.stringify({ batchId, status: report.status, attempts: report.results.length,
  verified: report.results.filter(r => r.verifiedSuccess).length, sourceUnchanged: report.sourceUnchanged }));
if (report.status !== 'finished' || !report.sourceUnchanged || report.results.some(row => !row.verifiedSuccess)) process.exitCode = 1;
