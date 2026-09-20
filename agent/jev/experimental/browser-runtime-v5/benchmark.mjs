import { mkdir, readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { chromium } from 'playwright-core';
import { saveJson } from '../../src/storage.mjs';
import { browserEnvironment } from '../../src/glovo.mjs';
import { createLedger } from '../browser-runtime-v3/providers.mjs';
import { runLoop } from './runtime.mjs';
import { createFixtureServer } from './fixture.mjs';
import { createOracle } from './oracle.mjs';
import { createJevDecider } from './jev.mjs';
import { readHiddenKey } from '../browser-runtime-v4/session.mjs';

export function parseBenchmarkArgs(args) {
  const seen = new Set();
  for (const arg of args) {
    if (!['--offline', '--jev', '--key-stdin'].includes(arg) && !arg.startsWith('--output-dir=')) throw new Error('unsupported_argument');
    const name = arg.split('=')[0];
    if (seen.has(name)) throw new Error('duplicate_argument');
    seen.add(name);
  }
  const offline = args.includes('--offline'), jev = args.includes('--jev'), keyStdin = args.includes('--key-stdin');
  const output = args.find(arg => arg.startsWith('--output-dir='))?.slice('--output-dir='.length);
  if (offline && (jev || keyStdin)) throw new Error('offline_mode_has_no_credentials');
  if (jev && !keyStdin) throw new Error('jev_mode_needs_key_stdin');
  if (!offline && !jev) throw new Error('pick_an_arm: --offline or --jev --key-stdin');
  if (output !== undefined && (!output.trim() || /[\x00-\x1f]/.test(output))) throw new Error('invalid_output_directory');
  return { offline, jev, keyStdin, root: output ? resolve(output)
    : fileURLToPath(new URL('../../benchmarks/browser-runtime-v5/results', import.meta.url)) };
}

export async function runBenchmark(args = process.argv.slice(2)) {
  const { offline, jev, keyStdin: _keyStdin, root } = parseBenchmarkArgs(args);
  let typesafeKey;
  if (jev) typesafeKey = await readHiddenKey();

  const sources = ['benchmark.mjs', 'fixture.mjs', 'runtime.mjs', 'session.mjs', 'snapshot.mjs',
    'questions.mjs', 'policy.mjs', 'donewhen.mjs', 'oracle.mjs', 'jev.mjs',
    '../browser-runtime-v3/providers.mjs', '../browser-runtime-v4/session.mjs',
    '../../src/jev.mjs', '../../src/storage.mjs', '../../src/glovo.mjs', '../../src/config.mjs',
    '../../package.json', '../../package-lock.json'];
  async function fingerprint() {
    const hashes = {};
    for (const file of sources) hashes[file] = createHash('sha256').update(await readFile(new URL(file, import.meta.url))).digest('hex');
    return { hashes, sha256: createHash('sha256').update(JSON.stringify(hashes)).digest('hex') };
  }
  const initialFingerprint = await fingerprint();
  const batchId = `${offline ? 'executor' : 'jev'}-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  const directory = join(root, batchId);
  await mkdir(root, { recursive: true, mode: 0o700 });
  await mkdir(directory, { mode: 0o700 });
  const report = { batchId, status: 'starting', mode: offline ? 'offline_executor' : 'jev_stepwise',
    seed: 20260920, sourceSha256: initialFingerprint.sha256, sourceHashes: initialFingerprint.hashes, sourceFiles: sources,
    nodeVersion: process.version,
    methodology: { workload: 'Four synthetic stepwise goals on a stateful local fixture: search-and-open, exact-variant add-to-bag, two-cheapest, and a three-field delivery form.',
      policy: 'One batched typed decision per step: operation plus speculative per-operation targets, supplied-value and done/destructive Nouls in a single request. Done requires deterministic done-when checks evaluated in code.',
      comparison: offline ? 'Executor-only: declared deterministic oracle decider, zero model calls; measures runtime overhead and correctness of the loop, not model accuracy.'
        : 'Real Jev (typesafe) decisions, same loop and fixtures; measures stepwise verified success and per-step timing.',
      timing: 'taskMs covers navigation start through the last durable completion write inside the attempt; context setup, provider settlement and cleanup are reported separately. Per-step snapMs/pickMs/actMs/settleMs are independent component medians.',
      cost: 'Jev estimated at $0.042 per million input tokens, zero output charge; all attempted calls retained, unknown usage never zero.',
      limits: 'Max 30 steps, 40 actions, 40 model calls, $0.05 known-spend per attempt; stop cohort on accounting failure.' },
    results: [] };
  await saveJson(join(directory, 'batch.json'), report);
  let browser, fixture;
  try {
    fixture = await createFixtureServer({ seed: 20260920 });
    const launch = performance.now();
    browser = await chromium.launch({ channel: process.env.JEV_BROWSER_CHANNEL || 'chrome', headless: true, chromiumSandbox: true, env: browserEnvironment() });
    report.browserLaunchMs = performance.now() - launch; report.browserVersion = browser.version();
    const sequence = [];
    for (const descriptor of fixture.cases) for (let repeat = 1; repeat <= 2; repeat++) sequence.push({ descriptor, repeat });
    report.plannedAttempts = sequence.length;
    for (const [index, { descriptor, repeat }] of sequence.entries()) {
      if (report.results.some(r => r.journalError || (r.accounting && (!r.accounting.costComplete || !r.accounting.usageComplete)))
        || report.results.reduce((sum, r) => sum + (r.accounting?.knownCostUsd || 0), 0) >= 0.10) {
        report.stopReason = 'accounting_or_batch_budget'; break;
      }
      const run = fixture.startRun(descriptor.id);
      const row = { attempt: index + 1, caseId: descriptor.id, runId: run.runId, repeat,
        picker: offline ? 'oracle' : 'jev', status: 'starting', events: [], journalMs: 0, journalWrites: 0 };
      const path = join(directory, `attempt-${index + 1}.json`); report.results.push(row);
      let tail = Promise.resolve();
      const persist = () => {
        tail = tail.catch(() => {}).then(async () => {
          const before = performance.now();
          try { await saveJson(path, structuredClone(row)); }
          catch { row.journalError = 'journal_write_failed'; throw new Error('journal_write_failed'); }
          finally { row.journalMs += performance.now() - before; row.journalWrites++; }
        });
        return tail;
      };
      const ledger = createLedger({ maxCalls: 40, maxUsd: 0.05, onEvent: async event => {
        row.events.push(event); row.accounting = ledger.summary(); await persist();
      } });
      await persist(); await saveJson(join(directory, 'batch.json'), report);
      let context, page, started;
      const controller = new AbortController(), signal = AbortSignal.any([controller.signal, AbortSignal.timeout(120000)]);
      try {
        const setup = performance.now();
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
        started = performance.now();
        await page.goto(run.startUrl, { waitUntil: 'domcontentloaded', timeout: 10000 });
        row.navigationMs = performance.now() - started;
        const decide = offline ? createOracle(descriptor.id) : createJevDecider({ apiKey: typesafeKey, ledger });
        row.spec = { goal: run.goal, doneWhen: run.doneWhen, values: run.values };
        row.runtime = await runLoop({ page, spec: { goal: run.goal, doneWhen: run.doneWhen, values: run.values,
          handlers: run.handlers }, decide, signal, maxSteps: 30, maxActions: 40, maxMs: 90000,
          onEvent: async event => { row.events.push(event); await persist(); } });
        row.reason = row.runtime.reason;
      } catch (error) {
        row.status = 'incomplete'; row.verifiedSuccess = false;
        row.reason = /^[a-z][a-z0-9_]{0,80}$/.test(error.code || '') ? error.code : 'task_error';
      } finally {
        const verificationStarted = performance.now();
        try { row.verification = fixture.verify(descriptor.id, run.runId); }
        catch { row.verification = { passed: false, reason: 'verification_failed' }; }
        row.verificationMs = performance.now() - verificationStarted;
        row.verifiedSuccess = row.runtime?.status === 'completed' && row.verification.passed && !row.journalError;
        row.status = row.verifiedSuccess ? 'completed' : 'incomplete';
        row.taskMs = started === undefined ? null : performance.now() - started;
        const finalizationStarted = performance.now();
        try {
          controller.abort();
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
      console.log(JSON.stringify({ attempt: row.attempt, caseId: row.caseId, status: row.status, reason: row.reason,
        taskMs: row.taskMs, steps: row.runtime?.steps?.length, jevCalls: row.runtime?.metrics?.jevCalls,
        costUsd: row.accounting?.costUsd ?? null }));
    }
    report.status = report.results.length === report.plannedAttempts ? 'finished' : 'partial';
  } catch (error) { report.status = 'interrupted'; report.stopReason = /^[a-z][a-z0-9_]{0,80}$/.test(error.code || '') ? error.code : 'batch_error'; }
  finally {
    typesafeKey = null;
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
