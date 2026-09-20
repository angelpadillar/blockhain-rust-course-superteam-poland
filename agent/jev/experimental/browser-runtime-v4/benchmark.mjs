import { mkdir, readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { chromium } from 'playwright-core';
import { saveJson } from '../../src/storage.mjs';
import { browserEnvironment } from '../../src/glovo.mjs';
import { createLedger, createJevChooser, createOpenRouter } from '../browser-runtime-v3/providers.mjs';
import { readOpenRouterItem } from '../browser-runtime-v3/credentials.mjs';
import { readHiddenKey } from './session.mjs';
import { compileWorkflow } from './planner.mjs';
import { runWorkflow } from './workflow.mjs';
import { createFixtureServer } from './fixture.mjs';

const normalize = value => String(value || '').normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();
export function parseBenchmarkArgs(args) {
  const seen = new Set();
  for (const arg of args) {
    if (!['--offline', '--structured-only', '--key-stdin'].includes(arg) && !['--openrouter-item=', '--output-dir='].some(prefix => arg.startsWith(prefix))) throw new Error('unsupported_argument');
    const name = arg.split('=')[0];
    if (seen.has(name)) throw new Error('duplicate_argument');
    seen.add(name);
  }
  const offline = args.includes('--offline'), structuredOnly = args.includes('--structured-only'), keyStdin = args.includes('--key-stdin');
  const item = args.find(arg => arg.startsWith('--openrouter-item='))?.slice('--openrouter-item='.length);
  const output = args.find(arg => arg.startsWith('--output-dir='))?.slice('--output-dir='.length);
  if (offline && (structuredOnly || keyStdin || item !== undefined)) throw new Error('offline_mode_has_no_credentials');
  if (structuredOnly && (!keyStdin || item !== undefined)) throw new Error('structured_mode_needs_only_key_stdin');
  if (!offline && !structuredOnly && (!item?.trim() || !keyStdin)) throw new Error('model_mode_needs_openrouter_item_and_key_stdin');
  if (output !== undefined && (!output.trim() || /[\x00-\x1f]/.test(output))) throw new Error('invalid_output_directory');
  return { offline, structuredOnly, item, root: output ? resolve(output)
    : fileURLToPath(new URL('../../../../benchmarks/browser-runtime-v4/results', import.meta.url)) };
}

// Declared semantic oracle for executor-only measurements. It knows the fixture
// context phrase, not a case identifier, destination, route token or verifier.
export async function fixtureOracle({ kind, candidates, task }) {
  let matching = candidates.filter(candidate => kind === 'search' ? candidate.supports?.includes('fill')
    : kind === 'result' && normalize(candidate.what) === normalize(task.targetText));
  if (task.context) {
    const context = normalize(task.context) === 'the shop for creative studio work' ? 'studio district' : normalize(task.context);
    matching = matching.filter(candidate => candidate.where?.some(where => normalize(where) === context));
  }
  return matching.length === 1 ? matching[0].ref : null;
}

export async function runBenchmark(args = process.argv.slice(2)) {
const { offline, structuredOnly, item, root } = parseBenchmarkArgs(args);
let openrouterKey, typesafeKey;
if (!offline) {
  if (!structuredOnly) openrouterKey = await readOpenRouterItem(item);
  typesafeKey = await readHiddenKey();
}

const sources = ['benchmark.mjs', 'fixture.mjs', 'planner.mjs', 'workflow.mjs', 'search.mjs', 'session.mjs',
  '../browser-runtime-v3/browser.mjs', '../browser-runtime-v3/runtime.mjs', '../browser-runtime-v3/providers.mjs',
  '../browser-runtime-v3/planner.mjs', '../browser-runtime-v3/credentials.mjs', '../browser-runtime-v3/run.mjs',
  '../../src/jev.mjs', '../../src/storage.mjs', '../../src/glovo.mjs', '../../src/config.mjs', '../../src/policy.mjs', '../../src/dom.mjs',
  '../../package.json', '../../package-lock.json'];
async function fingerprint() {
  const hashes = {};
  for (const file of sources) hashes[file] = createHash('sha256').update(await readFile(new URL(file, import.meta.url))).digest('hex');
  return { hashes, sha256: createHash('sha256').update(JSON.stringify(hashes)).digest('hex') };
}
const initialFingerprint = await fingerprint();
const batchId = `${offline ? 'executor' : structuredOnly ? 'jev-structured' : 'models'}-${new Date().toISOString().replace(/[:.]/g, '-')}`;
const directory = join(root, batchId);
await mkdir(root, { recursive: true, mode: 0o700 });
await mkdir(directory, { mode: 0o700 });
const report = { batchId, status: 'starting', mode: offline ? 'offline_executor' : structuredOnly ? 'jev_structured_only' : 'prompt_vs_structured',
  seed: 20260919, sourceSha256: initialFingerprint.sha256, sourceHashes: initialFingerprint.hashes, sourceFiles: sources, nodeVersion: process.version,
  methodology: { workload: 'Three private-route synthetic two-operation browsing tasks; no purchases or private accounts.',
    policy: 'Prompt mode sees goal only. Structured mode sees public typed steps. Destination routes are held only by an independent fixture verifier.',
    comparison: offline ? 'Executor-only, fixed public plans plus declared deterministic exact-title/context chooser and creative-studio-work → Studio district oracle; zero paid/model calls.'
      : structuredOnly ? 'Caller-supplied public typed plans with real Jev ambiguity choices. No OpenRouter credential access, planner calls, or natural-language planning claim; no comparison arm.'
      : 'One real OpenRouter workflow plan versus caller-supplied structured steps; same continuous executor and Jev ambiguity guide. This isolates planning overhead, not competing agents.',
    timing: 'totalMs includes initial navigation, overlapping planning, runtime, independent verification, pending provider settlement and the final durable completion write. Initial attempt/batch writes, context setup, cleanup and the final timing-metadata write are separate. taskMs ends before provider settlement and final completion persistence. journalMs measures queued attempt-file write operations, not batch writes; it is reported separately and overlaps totalMs.',
    cost: 'Provider-reported OpenRouter account charge plus Jev estimated input tokens at $0.042/M. All attempted calls retained, unknown usage never zero.',
    limits: 'Max six model calls per task; $0.01/task and $0.10/batch are known-spend stop thresholds, not guaranteed pre-call charge caps. Stop cohort on unknown usage.' }, results: [] };
await saveJson(join(directory, 'batch.json'), report);
let browser, fixture;
try {
  fixture = await createFixtureServer({ seed: 20260919 });
  const launch = performance.now();
  browser = await chromium.launch({ channel: process.env.JEV_BROWSER_CHANNEL || 'chrome', headless: true, chromiumSandbox: true, env: browserEnvironment() });
  report.browserLaunchMs = performance.now() - launch; report.browserVersion = browser.version();
  const sequence = [];
  for (const descriptor of fixture.cases) for (let repeat = 1; repeat <= 2; repeat++) {
    for (const inputMode of offline || structuredOnly ? ['structured'] : repeat % 2 ? ['prompt', 'structured'] : ['structured', 'prompt']) {
      sequence.push({ descriptor, repeat, inputMode });
    }
  }
  report.plannedAttempts = sequence.length;
  for (const [index, { descriptor, repeat, inputMode }] of sequence.entries()) {
    if (report.results.some(r => r.journalError || (r.accounting && (!r.accounting.costComplete || !r.accounting.usageComplete)))
      || report.results.reduce((sum, r) => sum + (r.accounting?.knownCostUsd || 0), 0) >= 0.10) {
      report.stopReason = 'accounting_or_batch_budget'; break;
    }
    fixture.reset(descriptor.id);
    const row = { attempt: index + 1, caseId: descriptor.id, repeat, inputMode, status: 'starting', events: [], journalMs: 0, journalWrites: 0 };
    const path = join(directory, `attempt-${index + 1}.json`); report.results.push(row);
    let tail = Promise.resolve();
    const persist = () => {
      // A failed durable write still fails the awaiting runtime operation. A
      // later finalization write may preserve the failure; no action is replayed.
      tail = tail.catch(() => {}).then(async () => {
        const before = performance.now();
        try { await saveJson(path, structuredClone(row)); }
        catch (error) { row.journalError = 'journal_write_failed'; throw error; }
        finally { row.journalMs += performance.now() - before; row.journalWrites++; }
      });
      return tail;
    };
    const ledger = createLedger({ maxCalls: 6, maxUsd: 0.01, onEvent: async event => {
      row.events.push(event); row.accounting = ledger.summary(); await persist();
    } });
    await persist(); await saveJson(join(directory, 'batch.json'), report);
    let context, page, started;
    const controller = new AbortController(), signal = AbortSignal.any([controller.signal, AbortSignal.timeout(35000)]);
    const pending = new Set();
    const track = operation => args => {
      const p = Promise.resolve().then(() => operation(args)); pending.add(p); p.then(() => pending.delete(p), () => pending.delete(p)); return p;
    };
    const setup = performance.now();
    try {
      context = await browser.newContext({ viewport: { width: 1100, height: 800 }, acceptDownloads: false, serviceWorkers: 'block' });
      row.blockedRequests = 0;
      await context.route('**/*', async route => {
        const request = route.request();
        let allowed = false;
        try { allowed = new URL(request.url()).origin === fixture.origin && ['GET', 'HEAD', 'OPTIONS'].includes(request.method()); } catch {}
        if (allowed) await route.continue();
        else { row.blockedRequests++; await route.abort('blockedbyclient'); }
      });
      page = await context.newPage(); row.contextSetupMs = performance.now() - setup;
      const complete = offline || structuredOnly ? undefined : track(createOpenRouter({ apiKey: openrouterKey, ledger }));
      const choose = offline ? fixtureOracle : track(createJevChooser({ apiKey: typesafeKey, ledger }));
      started = performance.now();
      let plan;
      const outcomes = await Promise.allSettled([
        page.goto(descriptor.startUrl, { waitUntil: 'domcontentloaded', timeout: 10000 }).then(() => { row.navigationMs = performance.now() - started; }),
        (inputMode === 'prompt' ? compileWorkflow({ goal: descriptor.goal, complete, signal }) : Promise.resolve(structuredClone(descriptor.publicPlan)))
          .then(value => { plan = value; row.planningMs = performance.now() - started; }),
      ]);
      const failure = outcomes.find(r => r.status === 'rejected'); if (failure) throw failure.reason;
      row.publicGoal = descriptor.goal; row.plan = plan;
      row.runtime = await runWorkflow({ page, plan, choose, signal, maxMs: 25000, maxActions: 12,
        onEvent: async event => { row.events.push(event); await persist(); } });
      row.reason = row.runtime.reason;
    } catch (error) {
      row.status = 'incomplete'; row.verifiedSuccess = false;
      row.reason = /^[a-z][a-z0-9_]{0,80}$/.test(error.code || '') ? error.code : 'task_error';
    } finally {
      const verificationStarted = performance.now();
      try { row.verification = page ? await fixture.verify(page, descriptor) : { passed: false, reason: 'page_unavailable' }; }
      catch { row.verification = { passed: false, reason: 'verification_failed' }; }
      row.verificationMs = performance.now() - verificationStarted;
      row.verifiedSuccess = row.runtime?.status === 'completed' && row.verification.passed && !row.journalError;
      row.status = row.verifiedSuccess ? 'completed' : 'incomplete';
      row.taskMs = started === undefined ? null : performance.now() - started;
      const finalizationStarted = performance.now();
      try {
        controller.abort();
        const settlementStarted = performance.now();
        while (pending.size) await Promise.allSettled([...pending]);
        row.providerSettlementMs = performance.now() - settlementStarted;
        row.accounting = ledger.summary();
        await persist();
      } catch { row.journalError = 'journal_write_failed'; row.status = 'incomplete'; row.verifiedSuccess = false; }
      finally {
        row.finalizationMs = performance.now() - finalizationStarted;
        row.totalMs = started === undefined ? null : performance.now() - started;
        const cleanupStarted = performance.now();
        if (context) await context.close().catch(() => { row.cleanupError = 'context_close_failed'; });
        row.cleanupMs = performance.now() - cleanupStarted;
        await persist().catch(() => { row.journalError = 'journal_write_failed'; row.status = 'incomplete'; row.verifiedSuccess = false; });
        await saveJson(join(directory, 'batch.json'), report);
      }
    }
    console.log(JSON.stringify({ attempt: row.attempt, caseId: row.caseId, inputMode, status: row.status, reason: row.reason,
      totalMs: row.totalMs, modelCalls: row.accounting.modelCalls, costUsd: row.accounting.costUsd }));
  }
  report.status = report.results.length === report.plannedAttempts ? 'finished' : 'partial';
} catch (error) { report.status = 'interrupted'; report.stopReason = /^[a-z][a-z0-9_]{0,80}$/.test(error.code || '') ? error.code : 'batch_error'; }
finally {
  openrouterKey = null; typesafeKey = null;
  try { await saveJson(join(directory, 'batch.json'), report); }
  finally {
    const cleanupStarted = performance.now();
    if (browser) await browser.close().catch(() => { report.cleanupError = 'browser_close_failed'; });
    if (fixture) await fixture.close().catch(() => { report.fixtureCleanupError = 'fixture_close_failed'; });
    report.cleanupMs = performance.now() - cleanupStarted;
    const finalFingerprint = await fingerprint();
    report.finalSourceHashes = finalFingerprint.hashes;
    report.sourceUnchanged = report.sourceSha256 === finalFingerprint.sha256;
    await saveJson(join(directory, 'batch.json'), report);
  }
}
console.log(JSON.stringify({ batchId, status: report.status, attempts: report.results.length, verified: report.results.filter(r => r.verifiedSuccess).length }));
return { report, directory };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { report } = await runBenchmark();
  if (report.status !== 'finished' || !report.sourceUnchanged || report.results.some(r => !r.verifiedSuccess)) process.exitCode = 1;
}
