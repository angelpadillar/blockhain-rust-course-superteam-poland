import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { runSearchAndOpen } from './runtime.mjs';

const task = { query: 'lantern', targetText: 'Amber Lantern' }, origin = 'https://runtime.test';
let browser;
test.before(async () => { browser = await chromium.launch({ ...(process.env.JEV_BROWSER_CHANNEL ? { channel: process.env.JEV_BROWSER_CHANNEL } : {}), chromiumSandbox: true }); });
test.after(async () => { await browser?.close(); });
async function fixture(t, html, extra = {}) {
  const context = await browser.newContext({ serviceWorkers: 'block', acceptDownloads: false });
  t.after(() => context.close());
  const requests = [];
  await context.route('**/*', async route => {
    const url = new URL(route.request().url()); requests.push({ path: url.pathname, method: route.request().method() });
    const body = url.pathname === '/search' ? '<title>Results</title><main><a href="/item">Amber Lantern</a></main>'
      : url.pathname === '/item' ? extra.detail || '<title>Item detail</title><main><h1>Amber Lantern</h1></main>' : html;
    await route.fulfill({ contentType: 'text/html; charset=utf-8', body });
  });
  const page = await context.newPage(); await page.goto(origin + '/start');
  return { page, requests };
}
const form = '<title>Search</title><form method="GET" action="/search"><label>Search catalogue <input name="q" type="search"></label><button>Search</button></form>';
const live = (delay = 50, result = '<a href="/item">Amber Lantern</a>') => `<title>Search</title><main><input role="searchbox" aria-label="Search" oninput="setTimeout(()=>document.querySelector('section').innerHTML=${JSON.stringify(result).replaceAll('"', '&quot;')},${delay})"><section></section></main>`;

test('GET search compounds fill and Enter; comparator retains same native operations with measured settling', async t => {
  const traces = [];
  for (const mode of ['fast', 'stepwise']) {
    const { page } = await fixture(t, form);
    const result = await runSearchAndOpen({ page, task, mode });
    assert.equal(result.status, 'opened', JSON.stringify(result));
    assert.equal(result.metrics.fillAttempts, 1); assert.equal(result.metrics.pressAttempts, 1); assert.equal(result.metrics.clickAttempts, 1);
    assert.equal(result.metrics.chooserCalls, 0);
    assert(result.metrics.explicitProtocolCalls > result.metrics.observations);
    if (mode === 'stepwise') assert(result.metrics.settlingMs >= 1390);
    else assert.equal(result.metrics.settlingMs, 0);
    traces.push(result.events.filter(event => event.type === 'action_completed').map(event => event.kind));
  }
  assert.deepEqual(traces[0], traces[1]);
});

test('live ARIA search waits for fresh exact results despite unrelated animation and delayed detail heading', async t => {
  const { page } = await fixture(t, live(220) + '<i aria-hidden="true"></i><script>setInterval(()=>document.querySelector("i").textContent=Date.now(),20)</script>',
    { detail: '<title>Detail loading</title><main><h1 hidden>Amber Lantern</h1></main><script>setTimeout(()=>document.querySelector("h1").hidden=false,350)</script>' });
  const result = await runSearchAndOpen({ page, task });
  assert.equal(result.status, 'opened', JSON.stringify(result));
  assert.equal(result.metrics.pressAttempts, 0);
  assert.equal(result.metrics.nativeActionAttempts, 2);
  assert(result.metrics.observerWakeups > 0);
  assert(result.metrics.conditionWaitMs >= 450);
  assert.equal(await page.locator('h1').isVisible(), true);
});

test('pre-existing exact links are never treated as fresh search results and unknown forms are not submitted', async t => {
  const { page } = await fixture(t, '<input role="searchbox" aria-label="Search"><a href="/item">Amber Lantern</a>');
  const result = await runSearchAndOpen({ page, task, maxMs: 650 });
  assert.equal(result.status, 'incomplete'); assert.equal(result.metrics.pressAttempts, 0); assert.equal(result.metrics.clickAttempts, 0);
});

test('duplicate exact links require context or a chooser; chooser sees compact observed refs only', async t => {
  const links = '<section aria-label="Studio shelf"><a href="/item">Amber Lantern</a></section><section aria-label="Travel shelf"><a href="/other">Amber Lantern</a></section>';
  for (const kind of ['missing', 'context', 'chooser']) {
    const { page } = await fixture(t, live(20, links));
    let chooserCalls = 0;
    const result = await runSearchAndOpen({ page, task: { ...task, ...(kind === 'context' ? { context: 'Studio shelf' } : {}) },
      ...(kind === 'chooser' ? { choose: async request => {
        chooserCalls++;
        assert.equal(request.kind, 'result');
        assert(request.candidates.every(candidate => !('href' in candidate) && !('selector' in candidate)));
        assert(!('text' in request.observation));
        return request.candidates.find(candidate => candidate.where.includes('Studio shelf')).ref;
      } } : {}) });
    assert.equal(result.status, kind === 'missing' ? 'incomplete' : 'opened', JSON.stringify(result));
    if (kind === 'missing') assert.equal(result.reason, 'ambiguous_result');
    assert.equal(chooserCalls, kind === 'chooser' ? 1 : 0);
  }
});

test('replacement before dispatch refreshes refs once, while invalid chooser outputs cannot act', async t => {
  const { page } = await fixture(t, form.replace('<button>', '<input type="search" aria-label="Search second"><button>'));
  let calls = 0;
  const result = await runSearchAndOpen({ page, task, choose: async request => {
    calls++;
    if (calls === 1) await page.locator('input[name=q]').evaluate(node => node.replaceWith(node.cloneNode(true)));
    return request.candidates.find(candidate => candidate.what.includes('catalogue')).ref;
  } });
  assert.equal(result.status, 'opened', JSON.stringify(result)); assert.equal(result.metrics.staleRefreshes, 1); assert.equal(result.metrics.fillAttempts, 1);
  const invalid = await fixture(t, live(20, '<a href="/item">Amber Lantern</a><a href="/other">Amber Lantern</a>'));
  const stopped = await runSearchAndOpen({ page: invalid.page, task, choose: async () => 'javascript:alert(1)' });
  assert.equal(stopped.reason, 'chooser_invalid_ref'); assert.equal(stopped.metrics.clickAttempts, 0);
});

test('mutation and external requests stop the runtime; destructive links and downloads are not candidates', async t => {
  for (const script of ["fetch('/account',{method:'POST'})", "fetch('https://outside.test/search')"]) {
    const { page, requests } = await fixture(t, `<input role="searchbox" aria-label="Search" oninput="${script}">`);
    const result = await runSearchAndOpen({ page, task, maxMs: 1000 });
    assert.equal(result.status, 'incomplete'); assert.equal(result.reason, 'forbidden_request', JSON.stringify(result));
    assert.equal(result.metrics.blockedRequests, 1); assert.equal(result.metrics.clickAttempts, 0);
    assert.deepEqual(requests, [{ path: '/start', method: 'GET' }]);
  }
  const html = live(10, '<a href="/account">Amber Lantern</a><a href="/item" download>Amber Lantern</a><a href="javascript:void(0)">Amber Lantern</a>');
  const { page } = await fixture(t, html);
  const result = await runSearchAndOpen({ page, task, maxMs: 650 });
  assert.equal(result.status, 'incomplete'); assert.equal(result.metrics.clickAttempts, 0);
});

test('visible empty results are a semantic stop and a hung chooser respects the run deadline', async t => {
  const { page } = await fixture(t, live(20, '<p role="status">No matching items</p>'));
  const result = await runSearchAndOpen({ page, task });
  assert.equal(result.status, 'incomplete'); assert.equal(result.reason, 'empty_results');
  const ambiguous = await fixture(t, form.replace('<button>', '<input type="search" aria-label="Search second"><button>'));
  const before = performance.now();
  const timed = await runSearchAndOpen({ page: ambiguous.page, task, maxMs: 250, choose: async () => new Promise(() => {}) });
  assert.equal(timed.status, 'incomplete'); assert.equal(timed.reason, 'time_limit'); assert.equal(timed.metrics.nativeActionAttempts, 0);
  assert(performance.now() - before < 1200);
});

test('insertion cannot retarget an observed result and uncertain native execution is not retried', async t => {
  const { page } = await fixture(t, live(20, '<a id="target" href="/item">Amber Lantern</a><a href="/other">Amber Lantern</a>'));
  const result = await runSearchAndOpen({ page, task, choose: async request => {
    const selected = request.candidates[0];
    await page.locator('#target').evaluate(node => {
      const inserted = node.cloneNode(true); inserted.id = 'inserted'; inserted.href = '/other'; node.before(inserted);
    });
    return selected.ref;
  } });
  assert.equal(result.status, 'opened', JSON.stringify(result)); assert.equal(result.final.url, origin + '/item');
  const covered = await fixture(t, live(20, '<a href="/item">Amber Lantern</a><div style="position:fixed;inset:0;background:white;z-index:100"></div>'));
  const uncertain = await runSearchAndOpen({ page: covered.page, task });
  assert.equal(uncertain.reason, 'uncertain_execution', JSON.stringify(uncertain));
  assert.equal(uncertain.metrics.clickAttempts, 1); assert.equal(uncertain.metrics.staleRefreshes, 0);
});
