import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { chromium } from 'playwright-core';
import { executeRun } from './session.mjs';
import { runSearchAndOpen } from './search.mjs';

async function options() {
  const directory = await mkdtemp(join(tmpdir(), 'v4-session-test-'));
  return { url: 'https://fixture.test/start', goal: 'Find Lantern', item: 'unused', output: join(directory, 'receipt.json'),
    guide: 'openrouter-dom', keyStdin: false };
}
function fakeBrowser(onClose = async () => {}) {
  const page = new EventEmitter();
  page.goto = async () => {}; page.url = () => 'https://fixture.test/result'; page.title = async () => 'Lantern';
  const context = new EventEmitter();
  context.newPage = async () => page; context.route = async () => {}; context.close = onClose;
  return { launch: async () => ({ newContext: async () => context, version: () => 'local-fake', close: async () => {} }) };
}
const noModel = { readOpenRouterItem: async () => null, createOpenRouter: () => () => { assert.fail('no model call'); },
  createOpenRouterChooser: () => undefined, planGoal: async () => ({ query: 'Lantern', targetText: 'Lantern' }) };

test('v4 reports its actual limits, keeps absent chooser absent, and journals outcome before cleanup', async () => {
  const config = await options(); let beforeClose;
  const result = await executeRun(config, { ...noModel, chromium: fakeBrowser(async () => {
    beforeClose = JSON.parse(await readFile(config.output, 'utf8'));
  }), runSearchAndOpen: async args => {
    assert.equal(args.choose, undefined); assert.equal(args.maxActions, 12); assert.equal(args.maxMs, 30000);
    return { status: 'incomplete', reason: 'context_unresolved' };
  } });
  assert.equal(beforeClose.status, 'incomplete'); assert.equal(beforeClose.reason, 'context_unresolved');
  assert.equal(beforeClose.cleanupStatus, 'pending'); assert.equal(beforeClose.accounting.modelCalls, 0);
  assert.equal(result.cleanupStatus, 'completed'); assert.equal(result.limits.maxActions, 12);
});

test('late provider accounting drains after abort before final receipt', async () => {
  const config = await options(); let choiceStarted;
  const started = new Promise(resolve => { choiceStarted = resolve; });
  const result = await executeRun(config, { ...noModel, chromium: fakeBrowser(),
    createOpenRouter: ({ ledger }) => async ({ signal }) => {
      const call = await ledger.begin({ provider: 'openrouter', model: 'test-only', purpose: 'choose' });
      choiceStarted();
      await new Promise(resolve => signal.addEventListener('abort', () => setTimeout(resolve, 20), { once: true }));
      await ledger.finish(call, { status: 'failed', usageComplete: false, costUsd: null, reason: 'cancelled' });
      throw new Error('test cancellation');
    }, createOpenRouterChooser: ({ complete }) => args => complete(args),
    runSearchAndOpen: async args => {
      void args.choose({ signal: args.signal }).catch(() => {});
      await started; return { status: 'incomplete', reason: 'time_limit' };
    } });
  assert.equal(result.accounting.calls[0].status, 'failed'); assert.equal(result.accounting.costComplete, false);
  const receipt = JSON.parse(await readFile(config.output, 'utf8'));
  assert.equal(receipt.accounting.calls[0].status, 'failed'); assert.equal(receipt.cleanupStatus, 'completed');
});

test('blocked submit plus cleanup cancellation leaves no orphaned event rejection', async t => {
  const config = await options(), rejected = [];
  const onRejected = error => rejected.push(error);
  process.on('unhandledRejection', onRejected);
  t.after(() => process.off('unhandledRejection', onRejected));
  let lateEvents = 0;
  const localChromium = { launch: async launchOptions => {
    const browser = await chromium.launch({ ...launchOptions, channel: process.env.JEV_BROWSER_CHANNEL || 'chrome' });
    const original = browser.newContext.bind(browser);
    browser.newContext = async contextOptions => {
      const context = await original(contextOptions);
      await context.route('**/*', route => route.fulfill({ contentType: 'text/html', body:
        '<form action="/search" onsubmit="event.preventDefault();fetch(\'/mutation?private_token=do-not-log\',{method:\'POST\'})"><input name="q" type="search" aria-label="Search"><button>Search</button></form>' }));
      return context;
    };
    return browser;
  } };
  const result = await executeRun(config, { ...noModel, chromium: localChromium,
    runSearchAndOpen: args => runSearchAndOpen({ ...args, onEvent: event => {
      if (event.type === 'action_completed' && event.kind === 'press') {
        lateEvents++;
        return new Promise((resolve, reject) => {
          const timer = setTimeout(resolve, 100);
          args.signal.addEventListener('abort', () => { clearTimeout(timer); reject(args.signal.reason); }, { once: true });
        });
      }
      return args.onEvent(event);
    } }) });
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(result.status, 'incomplete'); assert.equal(result.reason, 'forbidden_request');
  assert.equal(lateEvents, 0); assert.deepEqual(rejected, []);
  const receipt = JSON.parse(await readFile(config.output, 'utf8'));
  assert.equal(receipt.status, 'incomplete'); assert.equal(receipt.cleanupStatus, 'completed');
  assert.equal(receipt.accounting.modelCalls, 0);
  assert.equal(receipt.guard.observedForbiddenRequests, 1);
  assert.deepEqual(receipt.guard.requestObservations, [{ method: 'POST', resourceType: 'fetch', navigation: false,
    origin: 'https://fixture.test', pathname: '/mutation' }]);
  assert.equal(JSON.stringify(receipt).includes('do-not-log'), false);
});
