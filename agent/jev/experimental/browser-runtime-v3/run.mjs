#!/usr/bin/env node
import { mkdir, open, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { chromium } from 'playwright-core';
import { saveJson } from '../../src/storage.mjs';
import { browserEnvironment } from '../../src/glovo.mjs';
import { allowedRequest, allowedUrl } from './browser.mjs';
import { runSearchAndOpen } from './runtime.mjs';
import { createLedger, createOpenRouter, createOpenRouterChooser, createJevChooser, ProviderError } from './providers.mjs';
import { readOpenRouterItem } from './credentials.mjs';
import { planGoal } from './planner.mjs';

const HELP = `Read-only native search and open (experimental).
node experimental/browser-runtime-v3/run.mjs --url=https://example.org/search \\
  --goal='Find a named item and open its details.' --openrouter-item=REFERENCE \\
  --output=/private/path/new-result.json [--guide=openrouter-dom]

Guides: openrouter-dom (default), openrouter-dom-image, jev.
Jev additionally requires --key-stdin (terminal input is hidden; pipes work).
Optional external checks: --expected-url=EXACT_URL --expected-title=EXACT_TITLE.
Without external checks, an opened result is explicitly unverified.
Output must not already exist. See CLI.md for scope, costs and limitations.`;

class CliError extends Error { constructor(code) { super(code); this.code = code; } }
const fail = code => { throw new CliError(code); };
const fields = new Set(['url', 'goal', 'openrouter-item', 'output', 'guide', 'expected-url', 'expected-title']);
export function parseArgs(args) {
  if (args.length === 1 && args[0] === '--help') return { help: true };
  const values = {};
  for (const arg of args) {
    const match = /^--([^=]+)=(.*)$/s.exec(arg);
    const key = arg === '--key-stdin' ? 'key-stdin' : match?.[1];
    if (!key || (key === 'key-stdin' ? arg !== '--key-stdin' : !fields.has(key))) fail('unsupported_argument');
    if (Object.hasOwn(values, key)) fail('duplicate_argument');
    values[key] = key === 'key-stdin' ? true : match[2];
  }
  for (const name of ['url', 'goal', 'openrouter-item', 'output']) if (!values[name]?.trim()) fail('missing_required_argument');
  if (values.goal.length < 4 || values.goal.length > 1500 || /[\x00-\x1f]/.test(values.goal)) fail('invalid_goal');
  if (values['openrouter-item'].length > 250 || /[\x00-\x1f]/.test(values['openrouter-item'])) fail('invalid_secret_reference');
  let url;
  try { url = new URL(values.url); } catch { fail('invalid_start_url'); }
  if (!allowedUrl(url.href, url.origin)) fail('outside_navigation_scope');
  const guide = values.guide || 'openrouter-dom';
  if (!['openrouter-dom', 'openrouter-dom-image', 'jev'].includes(guide)) fail('invalid_guide');
  if ((guide === 'jev') !== Boolean(values['key-stdin'])) fail('jev_requires_key_stdin');
  if (/[\x00-\x1f]/.test(values.output)) fail('invalid_output_path');
  if (values['expected-url'] !== undefined) {
    try {
      const expected = new URL(values['expected-url']);
      if (!['http:', 'https:'].includes(expected.protocol) || expected.username || expected.password) fail('invalid_expected_url');
    } catch { fail('invalid_expected_url'); }
  }
  if (values['expected-title'] !== undefined && (!values['expected-title'] || values['expected-title'].length > 500 || /[\x00-\x1f]/.test(values['expected-title']))) fail('invalid_expected_title');
  return { url: url.href, goal: values.goal, item: values['openrouter-item'], output: resolve(values.output), guide,
    keyStdin: Boolean(values['key-stdin']), expectedUrl: values['expected-url'], expectedTitle: values['expected-title'] };
}

// Only these final observations enter the independent check, never the planner
// or runtime task. Exact means literal equality, including query and fragment.
export function verifyFinal(final, { expectedUrl, expectedTitle }) {
  const requested = expectedUrl !== undefined || expectedTitle !== undefined;
  const urlMatches = expectedUrl === undefined ? null : final.url === expectedUrl;
  const titleMatches = expectedTitle === undefined ? null : final.title === expectedTitle;
  return { requested, urlMatches, titleMatches, passed: requested ? urlMatches !== false && titleMatches !== false : null };
}

export function readHiddenKey({ input = process.stdin, output = process.stderr, signal } = {}) {
  return new Promise((resolveKey, reject) => {
    let value = '', settled = false;
    const wasRaw = input.isRaw;
    const finish = (error, key) => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      input.off('data', data); input.off('end', ended); input.off('error', failed);
      signal?.removeEventListener('abort', aborted);
      if (input.isTTY) {
        try { input.setRawMode(Boolean(wasRaw)); output.write('\n'); }
        catch { error ||= new CliError('stdin_read_failed'); }
      }
      input.pause();
      if (error) reject(error); else resolveKey(key);
    };
    const submit = () => {
      const key = value.trim();
      finish(key.length >= 15 && key.length <= 500 && !/\s/.test(key) ? null : new CliError('invalid_typesafe_key'), key);
    };
    const data = chunk => {
      for (const char of chunk.toString('utf8')) {
        if (char === '\n' || char === '\r') { submit(); return; }
        if (char === '\u0003') { finish(new CliError('cancelled')); return; }
        if (input.isTTY && (char === '\u007f' || char === '\b')) value = value.slice(0, -1);
        else value += char;
        if (value.length > 500 || /[\x00-\x1f]/.test(value)) { finish(new CliError('invalid_typesafe_key')); return; }
      }
    };
    const ended = () => submit(), failed = () => finish(new CliError('stdin_read_failed'));
    const aborted = () => finish(new CliError('cancelled'));
    const timer = setTimeout(() => finish(new CliError('stdin_timeout')), 60000);
    try {
      if (input.isTTY) { input.setRawMode(true); output.write('Enter TypeSafe key (input is hidden), then press Enter: '); }
      input.on('data', data); input.once('end', ended); input.once('error', failed);
      signal?.addEventListener('abort', aborted, { once: true });
      if (signal?.aborted) aborted(); else input.resume();
    } catch { finish(new CliError('stdin_read_failed')); }
  });
}

const knownErrors = new Set(['cancelled', 'cancelled_or_timed_out', 'provider_network_error', 'invalid_provider_json',
  'invalid_provider_envelope', 'provider_usage_or_cost_missing', 'incomplete_model_output', 'invalid_model_content',
  'invalid_model_json', 'invalid_model_reference', 'model_call_budget', 'model_cost_budget', 'previous_usage_incomplete',
  'invalid_search_task', 'invalid_goal', 'secret_item_unavailable', 'invalid_secret_reference', 'invalid_secret_value',
  'invalid_typesafe_key', 'stdin_read_failed', 'stdin_timeout', 'journal_write_failed', 'forbidden_request',
  'download_blocked', 'popup_blocked', 'time_limit', 'initial_navigation_failed', 'browser_launch_failed', 'context_setup_failed']);
function safeError(error) {
  if (error instanceof CliError) return error.code;
  if (knownErrors.has(error?.code)) return error.code;
  if (error instanceof ProviderError && /^provider_http_[1-5][0-9]{2}$/.test(error.code)) return error.code;
  return 'task_error';
}
const sourceFiles = ['run.mjs', 'browser.mjs', 'runtime.mjs', 'providers.mjs', 'planner.mjs', 'credentials.mjs',
  '../../src/jev.mjs', '../../src/storage.mjs', '../../src/glovo.mjs', '../../src/config.mjs', '../../src/policy.mjs', '../../src/dom.mjs',
  '../../package.json', '../../package-lock.json'];
async function fingerprint() {
  const hash = createHash('sha256');
  for (const file of sourceFiles) hash.update(file).update(await readFile(new URL(file, import.meta.url)));
  return hash.digest('hex');
}

// Dependency injection supports offline CLI lifecycle checks without APIs or a
// live browser. Production entrypoint always uses the imports above.
export async function executeRun(options, overrides = {}) {
  const deps = { chromium, readOpenRouterItem, readHiddenKey, createOpenRouter, createOpenRouterChooser,
    createJevChooser, planGoal, runSearchAndOpen, saveJson, ...overrides };
  const report = { version: 3, startedAt: new Date().toISOString(), status: 'starting', reason: null, guide: options.guide,
    goal: options.goal, startUrl: options.url, events: [], guard: { blockedRequests: 0 }, verifiedSuccess: false,
    verification: { requested: options.expectedUrl !== undefined || options.expectedTitle !== undefined, passed: null },
    limits: { maxCalls: 6, maxUsd: 0.01, maxRuntimeMs: 15000, maxActions: 8, maxAttemptMs: 45000 },
    scope: 'Native search followed by a newly observed exact result link. Opened is not independently verified unless external checks pass.',
    timingScope: 'Task total overlaps planning and initial navigation; browser/context setup, credential access and cleanup are separate. Nested runtime times may overlap.',
    costScope: 'OpenRouter account charge plus estimated Jev tokens; excludes browser infrastructure and unreported upstream charges.' };
  await mkdir(dirname(options.output), { recursive: true, mode: 0o700 });
  let initial;
  try { initial = await open(options.output, 'wx', 0o600); }
  catch (error) { throw new CliError(error.code === 'EEXIST' ? 'output_already_exists' : 'output_create_failed'); }
  try { await initial.writeFile(JSON.stringify(report, null, 2)); await initial.sync(); }
  catch { throw new CliError('journal_write_failed'); }
  finally { await initial.close(); }

  const controller = new AbortController();
  let signal = controller.signal, browser, context, page, closePromise, journalFailure, tail = Promise.resolve(), started;
  let openrouterKey, typesafeKey, interrupted = false;
  const pending = new Set();
  const tracked = operation => (...args) => {
    const promise = Promise.resolve().then(() => { args[0]?.signal?.throwIfAborted(); return operation(...args); });
    pending.add(promise);
    promise.then(() => pending.delete(promise), () => pending.delete(promise));
    return promise;
  };
  const stop = code => { if (!controller.signal.aborted) controller.abort(new CliError(code)); };
  const persist = () => {
    if (journalFailure) return Promise.reject(journalFailure);
    const snapshot = structuredClone(report);
    const next = tail.then(() => deps.saveJson(options.output, snapshot));
    tail = next.catch(() => { journalFailure = new CliError('journal_write_failed'); stop(journalFailure.code); });
    return next.catch(() => { throw journalFailure || new CliError('journal_write_failed'); });
  };
  const ledger = createLedger({ maxCalls: 6, maxUsd: 0.01, onEvent: async event => {
    report.events.push(event); report.accounting = ledger.summary(); await persist();
  } });
  const interrupt = () => { interrupted = true; stop('cancelled'); };
  process.on('SIGINT', interrupt); process.on('SIGTERM', interrupt);
  const closeContext = () => {
    if (context && !closePromise) closePromise = context.close().catch(() => { report.cleanupError = 'context_close_failed'; });
    return closePromise;
  };
  controller.signal.addEventListener('abort', closeContext);
  try {
    report.sourceSha256 = await fingerprint(); report.sourceFiles = sourceFiles;
    await persist();
    openrouterKey = await deps.readOpenRouterItem(options.item);
    controller.signal.throwIfAborted();
    if (options.keyStdin) typesafeKey = await deps.readHiddenKey({ signal: controller.signal });
    controller.signal.throwIfAborted();
    const channel = process.env.JEV_BROWSER_CHANNEL || 'chrome';
    if (!/^[a-z-]{1,30}$/.test(channel)) fail('invalid_browser_channel');
    const launch = performance.now();
    try { browser = await deps.chromium.launch({ channel, headless: true, chromiumSandbox: true, env: browserEnvironment(),
      handleSIGINT: false, handleSIGTERM: false, handleSIGHUP: false, timeout: 20000 }); }
    catch { fail('browser_launch_failed'); }
    report.browserLaunchMs = performance.now() - launch; report.browserVersion = browser.version();
    controller.signal.throwIfAborted();
    const setup = performance.now();
    try {
      context = await browser.newContext({ viewport: { width: 1100, height: 800 }, acceptDownloads: false, serviceWorkers: 'block' });
      page = await context.newPage();
      controller.signal.throwIfAborted();
      const origin = new URL(options.url).origin;
      await context.route('**/*', async route => {
        const request = route.request();
        if (!controller.signal.aborted && allowedRequest({ url: request.url(), method: request.method(),
          navigation: request.isNavigationRequest(), resourceType: request.resourceType() }, origin)) {
          try { await route.fallback(); } catch { if (!controller.signal.aborted) stop('request_guard_failed'); }
          return;
        }
        if (!controller.signal.aborted) {
          report.guard.blockedRequests++; stop('forbidden_request');
          void persist().catch(() => {});
        }
        await route.abort('blockedbyclient').catch(() => {});
      });
      context.on('page', popup => { if (popup !== page) { stop('popup_blocked'); void popup.close().catch(() => {}); } });
      page.on('download', download => { stop('download_blocked'); void download.cancel().catch(() => {}); });
      page.on('dialog', dialog => { void dialog.dismiss().catch(() => {}); });
    } catch { if (controller.signal.aborted) throw controller.signal.reason; fail('context_setup_failed'); }
    report.contextSetupMs = performance.now() - setup;
    signal = AbortSignal.any([controller.signal, AbortSignal.timeout(report.limits.maxAttemptMs)]);
    signal.addEventListener('abort', closeContext, { once: true });
    signal.throwIfAborted();
    started = performance.now(); report.status = 'running';
    const complete = tracked(deps.createOpenRouter({ apiKey: openrouterKey, ledger }));
    const choose = tracked(options.guide === 'jev' ? deps.createJevChooser({ apiKey: typesafeKey, ledger })
      : deps.createOpenRouterChooser({ complete, ...(options.guide === 'openrouter-dom-image'
        ? { screenshot: () => page.screenshot({ type: 'png', timeout: 5000 }) } : {}) }));
    await persist();
    const abortOnFailure = promise => promise.catch(error => { stop(safeError(error)); throw error; });
    // Expected answers deliberately stay in CLI options, outside both calls.
    const outcomes = await Promise.allSettled([
      abortOnFailure(page.goto(options.url, { waitUntil: 'domcontentloaded', timeout: 15000 })
        .then(() => { report.initialNavigationMs = performance.now() - started; })
        .catch(() => { throw controller.signal.aborted ? controller.signal.reason : new CliError('initial_navigation_failed'); })),
      abortOnFailure(deps.planGoal({ goal: options.goal, complete, signal })
        .then(task => { report.compiledTask = task; report.planningMs = performance.now() - started; })),
    ]);
    const failure = outcomes.find(outcome => outcome.status === 'rejected');
    if (failure) throw failure.reason;
    signal.throwIfAborted(); await persist();
    report.runtime = await deps.runSearchAndOpen({ page, task: report.compiledTask, choose, signal,
      mode: 'fast', maxMs: report.limits.maxRuntimeMs, maxActions: report.limits.maxActions,
      onEvent: async event => { report.events.push(event); await persist(); } });
    signal.throwIfAborted();
    // Read again after runtime; do not trust its cached final title for checks.
    report.final = { url: page.url(), title: await page.title() };
    report.verification = verifyFinal(report.final, options);
    report.verifiedSuccess = report.runtime.status === 'opened' && report.verification.passed === true;
    report.status = report.verifiedSuccess ? 'verified' : report.runtime.status === 'opened'
      ? report.verification.requested ? 'verification_failed' : 'opened_unverified' : 'incomplete';
    report.reason = report.status === 'verification_failed' ? 'external_verification_failed' : report.runtime.reason;
  } catch (error) {
    report.status = 'incomplete';
    report.reason = journalFailure ? 'journal_write_failed' : interrupted ? 'cancelled'
      : controller.signal.aborted ? safeError(controller.signal.reason) : signal.aborted ? 'time_limit' : safeError(error);
  } finally {
    report.totalMs = started === undefined ? null : performance.now() - started;
    stop('cancelled');
    const cleanup = performance.now();
    await closeContext();
    // Runtime can stop racing an aborted chooser before its usage journal has
    // settled. Drain those bounded requests before declaring final accounting.
    while (pending.size) await Promise.allSettled([...pending]);
    report.accounting = ledger.summary();
    if (browser) await browser.close().catch(() => { report.cleanupError = 'browser_close_failed'; });
    report.cleanupMs = performance.now() - cleanup;
    openrouterKey = null; typesafeKey = null;
    controller.signal.removeEventListener('abort', closeContext); signal.removeEventListener('abort', closeContext);
    process.off('SIGINT', interrupt); process.off('SIGTERM', interrupt);
    try { report.sourceUnchanged = report.sourceSha256 === await fingerprint(); } catch { report.sourceUnchanged = false; }
    if (report.sourceUnchanged === false && !report.reason) { report.status = 'incomplete'; report.reason = 'source_changed'; }
    await tail;
    try { await persist(); } catch { report.status = 'incomplete'; report.reason = 'journal_write_failed'; }
  }
  return report;
}

export async function main(args = process.argv.slice(2)) {
  try {
    const options = parseArgs(args);
    if (options.help) { console.log(HELP); return 0; }
    const report = await executeRun(options);
    console.log(JSON.stringify({ status: report.status, reason: report.reason, verifiedSuccess: report.verifiedSuccess,
      totalMs: report.totalMs, browserLaunchMs: report.browserLaunchMs, modelCalls: report.accounting.modelCalls,
      costUsd: report.accounting.costUsd, costComplete: report.accounting.costComplete }));
    return ['verified', 'opened_unverified'].includes(report.status) && !report.cleanupError ? 0 : 1;
  } catch (error) { console.error(JSON.stringify({ status: 'incomplete', reason: safeError(error) })); return 1; }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) process.exitCode = await main();
