import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
import { createFixtureServer } from './fixture.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const workspace = resolve(here, '../../../..');
const sourceFiles = ['benchmark.mjs', 'fixture.mjs', 'runtime.mjs', 'browser.mjs'];
const normalize = value => String(value || '').normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase();
const round = value => Math.round(value * 1000) / 1000;

// This policy sees only the task and the runtime's observed candidates. It has
// no case identifier, catalogue IDs, answer route or fixture verifier access.
export function createDeterministicChooser() {
  return async ({ kind, candidates, task }) => {
    let choices = candidates;
    if (kind === 'result') {
      choices = choices.filter(candidate => normalize(candidate.what) === normalize(task.targetText));
      if (task.context) {
        // Declared semantic oracle for executor-only runs. Paid chooser runs use
        // the unmodified task phrase and are benchmarked separately.
        const requestedContext = normalize(task.context) === 'the shelf for creative studio work' ? 'studio shelf' : normalize(task.context);
        choices = choices.filter(candidate => (candidate.where || []).some(context => normalize(context) === requestedContext));
      }
    } else if (kind === 'search') {
      choices = choices.filter(candidate => (candidate.supports || []).includes('fill'));
    } else throw new Error('unknown_semantic_choice');
    if (choices.length !== 1) throw new Error('unresolved_semantic_ambiguity');
    return choices[0].ref;
  };
}

function distribution(values) {
  const ordered = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!ordered.length) return { n: 0, median: null, min: null, max: null };
  const middle = Math.floor(ordered.length / 2);
  return { n: ordered.length, median: round(ordered.length % 2 ? ordered[middle] : (ordered[middle - 1] + ordered[middle]) / 2),
    min: round(ordered[0]), max: round(ordered.at(-1)) };
}

export function summarizeAttempts(attempts) {
  const normal = attempts.filter(attempt => attempt.expectation === 'complete');
  const expectedStops = attempts.filter(attempt => attempt.expectation === 'stop');
  const arms = Object.fromEntries(['fast', 'stepwise'].map(mode => {
    const rows = normal.filter(attempt => attempt.mode === mode);
    const complete = rows.filter(attempt => attempt.completed);
    return [mode, { attempted: rows.length, completed: complete.length, failed: rows.length - complete.length,
      allAttemptMs: distribution(rows.map(row => row.timings.totalMs)),
      verifiedCompletionMs: distribution(complete.map(row => row.timings.totalMs)),
      navigationMs: distribution(complete.map(row => row.timings.navigationMs)),
      runtimeMs: distribution(complete.map(row => row.timings.runtimeMs)),
      verificationMs: distribution(complete.map(row => row.timings.verificationMs)) }];
  }));
  const pairs = new Map();
  for (const row of normal) {
    const key = `${row.caseId}:${row.repeat}`;
    if (!pairs.has(key)) pairs.set(key, {});
    pairs.get(key)[row.mode] = row;
  }
  const matched = [...pairs.values()].filter(pair => pair.fast?.completed && pair.stepwise?.completed);
  return { arms, pairs: { attempted: pairs.size, bothCompleted: matched.length,
    stepwiseMinusFastMs: distribution(matched.map(pair => pair.stepwise.timings.totalMs - pair.fast.timings.totalMs)),
    stepwiseOverFastRatio: distribution(matched.map(pair => pair.stepwise.timings.totalMs / pair.fast.timings.totalMs)) },
  expectedStops: Object.fromEntries(['fast', 'stepwise'].map(mode => {
    const rows = expectedStops.filter(attempt => attempt.mode === mode);
    return [mode, { attempted: rows.length, verifiedStops: rows.filter(row => row.expectedStopVerified).length,
      totalMs: distribution(rows.map(row => row.timings.totalMs)) }];
  })) };
}

export function executionSchedule(cases) {
  const schedule = [];
  cases.filter(item => item.expectation === 'complete').forEach((descriptor, caseIndex) => {
    for (let repeat = 1; repeat <= 2; repeat++) {
      const order = (caseIndex + repeat - 1) % 2 ? ['stepwise', 'fast'] : ['fast', 'stepwise'];
      for (const mode of order) schedule.push({ descriptor, repeat, mode });
    }
  });
  for (const descriptor of cases.filter(item => item.expectation === 'stop')) {
    for (const mode of ['fast', 'stepwise']) schedule.push({ descriptor, repeat: 1, mode });
  }
  return schedule;
}

async function sourceHashes() {
  return Object.fromEntries(await Promise.all(sourceFiles.map(async name => [name,
    createHash('sha256').update(await readFile(resolve(here, name))).digest('hex')])));
}

// Zero-model executor benchmark. Runtime receives only a goal and live page;
// fixture verification is called after execution, never as a planning oracle.
export async function runExecutionBenchmark({ seed = 20260917, outputDir = resolve(workspace, 'benchmarks/browser-runtime-v3/results'),
  channel = process.env.JEV_BROWSER_CHANNEL || 'chrome', maxMs = 15000, maxActions = 8, onAttempt } = {}) {
  const [{ chromium }, { runSearchAndOpen }] = await Promise.all([import('playwright-core'), import('./runtime.mjs')]);
  const hashes = await sourceHashes();
  const fixture = await createFixtureServer({ seed });
  const attempts = [];
  let browser;
  const startedAt = new Date().toISOString();
  const artifact = { schemaVersion: 1, benchmarkKind: 'zero_model_execution_benchmark', startedAt, seed,
    protocol: { repeatsPerCompletionCase: 2, pairedModes: ['fast', 'stepwise'], alternatingOrder: true,
      expectedStopRepeatsPerMode: 1, maxMs, maxActions, headless: true, browserChannel: channel,
      attemptTiming: 'Includes initial page navigation, runtime, and independent fixture verification; excludes context setup and browser launch.',
      selectionPolicy: 'Deterministic exact goal/context matching plus declared creative-studio-work → Studio shelf semantic oracle; identical policy in both modes.',
      modelCalls: 0, paidApiCalls: 0, modelSpendUsd: 0, artificialModelLatencyMs: 0,
      scope: 'Local neutral fixtures; measures executor behavior only. No general website or model-latency claim.' },
    sourceHashes: hashes, cases: fixture.cases.map(({ id, expectation }) => ({ id, expectation })), attempts };
  try {
    const launchStarted = performance.now();
    browser = await chromium.launch({ channel, headless: true });
    artifact.browserLaunchMs = round(performance.now() - launchStarted);
    artifact.environment = { browserVersion: browser.version(), nodeVersion: process.version, platform: process.platform, architecture: process.arch };
    for (const { descriptor, repeat, mode } of executionSchedule(fixture.cases)) {
      const setupStarted = performance.now();
      fixture.reset(descriptor.id);
      const context = await browser.newContext({ viewport: { width: 1120, height: 780 }, serviceWorkers: 'block' });
      let blockedRequests = 0;
      await context.route('**/*', async route => {
        const request = route.request();
        let allowed = false;
        try { allowed = new URL(request.url()).origin === fixture.origin && ['GET', 'HEAD', 'OPTIONS'].includes(request.method()); } catch {}
        if (allowed) await route.continue();
        else { blockedRequests++; await route.abort('blockedbyclient'); }
      });
      const page = await context.newPage();
      const attempt = { sequence: attempts.length + 1, caseId: descriptor.id, seed, repeat, mode, expectation: descriptor.expectation,
        completed: false, expectedStopVerified: false, modelCalls: 0, paidApiCalls: 0, chooseCalls: 0,
        timings: { contextSetupMs: round(performance.now() - setupStarted), navigationMs: 0, runtimeMs: 0, verificationMs: 0, totalMs: 0 }, events: [] };
      const started = performance.now();
      const controller = new AbortController();
      const abortTimer = setTimeout(() => controller.abort(new Error('attempt_deadline')), maxMs);
      let phase = 'navigation';
      let phaseStarted = started;
      try {
        await page.goto(descriptor.startUrl, { waitUntil: 'domcontentloaded', timeout: Math.min(5000, maxMs) });
        attempt.timings.navigationMs = round(performance.now() - phaseStarted);
        phase = 'runtime'; phaseStarted = performance.now();
        const choose = createDeterministicChooser();
        const remainingMs = Math.floor(maxMs - (performance.now() - started));
        if (remainingMs < 100) throw new Error('attempt_deadline');
        attempt.runtime = await runSearchAndOpen({ page, task: { ...descriptor.publicTask }, mode,
          maxMs: remainingMs, maxActions, signal: controller.signal,
          choose: async request => { attempt.chooseCalls++; return choose(request); },
          onEvent: async event => { if (attempt.events.length < 100) attempt.events.push(event); } });
        attempt.timings.runtimeMs = round(performance.now() - phaseStarted);
      } catch (error) {
        attempt.timings[`${phase}Ms`] = round(performance.now() - phaseStarted);
        attempt.error = { phase, name: error.name || 'Error', message: String(error.message || error).slice(0, 400) };
      } finally {
        const verificationStarted = performance.now();
        try { attempt.verification = await fixture.verify(page, descriptor); }
        catch (error) { attempt.verification = { passed: false, error: String(error.message || error).slice(0, 200) }; }
        attempt.timings.verificationMs = round(performance.now() - verificationStarted);
        attempt.timings.totalMs = round(performance.now() - started);
        clearTimeout(abortTimer);
        attempt.withinDeadline = attempt.timings.totalMs <= maxMs;
        attempt.completed = descriptor.expectation === 'complete' && attempt.runtime?.status === 'opened'
          && attempt.verification.passed && attempt.withinDeadline && !attempt.error;
        attempt.expectedStopVerified = descriptor.expectation === 'stop' && attempt.runtime?.status === 'incomplete' && attempt.runtime?.reason === 'empty_results'
          && attempt.verification.passed && attempt.withinDeadline && !attempt.error;
        attempt.blockedRequests = blockedRequests;
        attempt.fixtureRequests = fixture.requestCount(descriptor.id);
        attempts.push(attempt);
        await context.close();
      }
      if (onAttempt) await onAttempt({ sequence: attempt.sequence, caseId: attempt.caseId, repeat, mode,
        completed: attempt.completed, expectedStopVerified: attempt.expectedStopVerified, totalMs: attempt.timings.totalMs });
    }
  } catch (error) {
    artifact.harnessError = { name: error.name || 'Error', message: String(error.message || error).slice(0, 400) };
  } finally {
    if (browser) await browser.close();
    await fixture.close();
    artifact.finishedAt = new Date().toISOString();
    artifact.finalSourceHashes = await sourceHashes();
    artifact.sourceUnchanged = JSON.stringify(hashes) === JSON.stringify(artifact.finalSourceHashes);
    artifact.summary = summarizeAttempts(attempts);
    await mkdir(outputDir, { recursive: true });
    const path = resolve(outputDir, `executor-${startedAt.replace(/[:.]/g, '-')}.json`);
    await writeFile(path, JSON.stringify(artifact, null, 2) + '\n', { flag: 'wx' });
    artifact.outputPath = path;
  }
  return artifact;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  let seed = 20260917;
  let outputDir;
  for (let index = 0; index < args.length; index++) {
    if (args[index] === '--seed') seed = Number(args[++index]);
    else if (args[index] === '--output-dir') outputDir = resolve(args[++index]);
    else throw new Error(`unknown_argument:${args[index]}`);
  }
  const result = await runExecutionBenchmark({ seed, outputDir, onAttempt: attempt => process.stdout.write(JSON.stringify(attempt) + '\n') });
  process.stdout.write(JSON.stringify({ outputPath: result.outputPath, sourceUnchanged: result.sourceUnchanged, summary: result.summary,
    ...(result.harnessError ? { harnessError: result.harnessError } : {}) }, null, 2) + '\n');
  if (result.harnessError || !result.sourceUnchanged || result.attempts.some(attempt => !attempt.completed && !attempt.expectedStopVerified)) process.exitCode = 1;
}
