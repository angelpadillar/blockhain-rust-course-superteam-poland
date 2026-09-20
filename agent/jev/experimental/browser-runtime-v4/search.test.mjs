import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { browserEnvironment } from '../../src/glovo.mjs';
import { runSearchAndOpen } from './search.mjs';

const origin = 'https://search-context.test';
const task = { query: 'Amber', targetText: 'Amber Lantern', context: 'Studio shelf' };
let browser;
test.before(async () => {
  browser = await chromium.launch({ channel: process.env.JEV_BROWSER_CHANNEL || 'chrome',
    headless: true, chromiumSandbox: true, env: browserEnvironment() });
});
test.after(async () => { await browser?.close(); });

async function fixture(t, region = 'Travel shelf') {
  const context = await browser.newContext({ serviceWorkers: 'block', acceptDownloads: false });
  t.after(() => context.close());
  const requests = [];
  await context.route('**/*', async route => {
    const path = new URL(route.request().url()).pathname;
    requests.push(path);
    const body = path === '/search'
      ? `<title>Results</title><main><section aria-label="${region}"><a href="/item">Amber Lantern</a></section></main>`
      : path === '/item'
        ? '<title>Amber Lantern</title><main><h1>Amber Lantern</h1></main>'
        : '<title>Catalogue</title><main><form method="GET" action="/search"><input name="q" type="search" aria-label="Search catalogue"><button>Search</button></form></main>';
    await route.fulfill({ contentType: 'text/html; charset=utf-8', body });
  });
  const page = await context.newPage();
  await page.goto(origin + '/start');
  return { page, requests };
}

test('a sole title under the wrong context requires a guide, without gating the unique search field', async t => {
  const { page, requests } = await fixture(t);
  const result = await runSearchAndOpen({ page, task });
  assert.equal(result.status, 'incomplete');
  assert.equal(result.reason, 'context_unresolved');
  assert.equal(result.metrics.fillAttempts, 1);
  assert.equal(result.metrics.pressAttempts, 1);
  assert.equal(result.metrics.clickAttempts, 0);
  assert.equal(result.metrics.chooserCalls, 0);
  assert(!requests.includes('/item'));
});

test('semantic abstention on a sole wrong-context result never dispatches its click', async t => {
  const { page, requests } = await fixture(t);
  let calls = 0;
  const result = await runSearchAndOpen({ page, task, choose: async request => {
    calls++;
    assert.equal(request.kind, 'result');
    assert.equal(request.task.context, 'Studio shelf');
    assert.equal(request.candidates.length, 1);
    assert(request.candidates[0].where.includes('Travel shelf'));
    assert(!('href' in request.candidates[0]));
    return null;
  } });
  assert.equal(result.status, 'incomplete');
  assert.equal(result.reason, 'chooser_invalid_ref');
  assert.equal(calls, 1);
  assert.equal(result.metrics.clickAttempts, 0);
  assert(!requests.includes('/item'));
});

test('a semantically matching sole result can be selected by its fresh observed reference', async t => {
  const { page, requests } = await fixture(t, 'Studio shelf');
  let calls = 0;
  const result = await runSearchAndOpen({ page, task: { ...task, context: 'the shelf for creative studio work' },
    choose: async request => {
      calls++;
      assert.equal(request.kind, 'result');
      assert.equal(request.candidates.length, 1);
      assert(request.candidates[0].where.includes('Studio shelf'));
      return request.candidates[0].ref;
    } });
  assert.equal(result.status, 'opened', JSON.stringify(result));
  assert.equal(calls, 1);
  assert.equal(result.metrics.clickAttempts, 1);
  assert(requests.includes('/item'));
});

test('an exact unique context match remains deterministic with zero guide calls', async t => {
  const { page } = await fixture(t, 'Studio shelf');
  const result = await runSearchAndOpen({ page, task, choose: () => assert.fail('Exact context needs no model') });
  assert.equal(result.status, 'opened', JSON.stringify(result));
  assert.equal(result.metrics.chooserCalls, 0);
  assert.equal(result.metrics.nativeActionAttempts, 3);
});

test('an already aborted run never invokes an event callback that would reject', async t => {
  const { page } = await fixture(t);
  const controller = new AbortController();
  controller.abort();
  let events = 0;
  const result = await runSearchAndOpen({ page, task, signal: controller.signal,
    onEvent: async () => { events++; throw new Error('Must not start after abort'); } });
  assert.equal(result.status, 'incomplete');
  assert.equal(result.reason, 'aborted');
  assert.equal(result.metrics.nativeActionAttempts, 0);
  assert.equal(events, 0);
});
