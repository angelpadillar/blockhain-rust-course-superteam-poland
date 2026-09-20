import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { browserEnvironment } from '../../src/glovo.mjs';
import { runWorkflow, validatePlan } from './workflow.mjs';
import { createFixtureServer } from './fixture.mjs';

const origin = 'https://workflow.test';
const search = { operation: 'search_and_open', query: 'Amber', targetText: 'Amber Lantern' };
const link = { operation: 'open_link', targetText: 'Care guide' };
const form = '<title>Catalogue</title><main><form method="GET" action="/search"><input type="search" name="q" aria-label="Search catalogue"><button>Search</button></form></main>';
let browser;

test('strict bounded plans accept no expected answers, unknown operations or extra fields', () => {
  assert.deepEqual(validatePlan({ steps: [{ ...search, query: ' Amber ' }, link] }), { steps: [search, link] });
  assert.equal(validatePlan({ steps: [link, link, link, link] }).steps.length, 4);
  for (const steps of [[], Array(5).fill(link)]) assert.throws(() => validatePlan({ steps }), /step_limit/);
  for (const field of ['expectedUrl', 'expectedTitle', 'productId', 'url', 'selector', 'script', 'ref']) {
    assert.throws(() => validatePlan({ steps: [{ ...link, [field]: 'not accepted' }] }), /unsupported_step_field/);
  }
  assert.throws(() => validatePlan({ steps: [{ ...link, query: '' }] }), /unsupported_step_field/);
  assert.throws(() => validatePlan({ steps: [link], expectedUrl: 'not accepted' }), /invalid_plan/);
  for (const operation of ['purchase', 'add_to_cart', 'click', 'javascript']) {
    assert.throws(() => validatePlan({ steps: [{ operation, targetText: 'Thing' }] }), /unsupported_operation/);
  }
  for (const targetText of ['', null, 'a'.repeat(241), 'bad\nlabel']) assert.throws(() => validatePlan({ steps: [{ ...link, targetText }] }), /invalid_step/);
});

async function launch() {
  browser ||= await chromium.launch({ channel: process.env.JEV_BROWSER_CHANNEL || 'chrome', headless: true,
    chromiumSandbox: true, env: browserEnvironment() });
  return browser;
}
test.after(async () => { await browser?.close(); });
async function fixture(t, html = form, pages = {}) {
  const context = await (await launch()).newContext({ serviceWorkers: 'block', acceptDownloads: false });
  t.after(() => context.close());
  const requests = [];
  const routes = { '/start': html, '/search': '<title>Results</title><main><a href="/item">Amber Lantern</a></main>',
    '/item': '<title>Amber Lantern</title><main><h1>Amber Lantern</h1><a href="/guide">Care guide</a></main>',
    '/guide': '<title>Care guide</title><main><h1>Care guide</h1></main>', ...pages };
  await context.route('**/*', async route => {
    const path = new URL(route.request().url()).pathname;
    requests.push({ path, method: route.request().method() });
    await route.fulfill({ contentType: 'text/html; charset=utf-8', body: routes[path] || '<h1>Unknown route</h1>' });
  });
  const page = await context.newPage(); await page.goto(origin + '/start');
  return { page, requests };
}

test('two-step search/open then fresh link completes without a chooser or inter-step roundtrip', async t => {
  const { page } = await fixture(t);
  let chooserCalls = 0;
  const result = await runWorkflow({ page, plan: { steps: [search, link] }, choose: () => { chooserCalls++; assert.fail('deterministic path'); } });
  assert.equal(result.status, 'completed', JSON.stringify(result));
  assert.equal(result.independentlyVerified, false); assert.equal(result.escalation, null);
  assert.equal(chooserCalls, 0); assert.equal(result.metrics.nativeActionAttempts, 4);
  assert.equal(result.metrics.clickAttempts, 2); assert.equal(result.metrics.settlingMs, 0);
  assert(result.steps.every(step => step.evidence.urlChanged && step.evidence.visibleExactHeading && step.evidence.originPreserved));
  const starts = result.events.filter(event => event.type === 'step_started').map(event => event.step);
  assert.deepEqual(starts, [1, 2]);
});

test('first-step failure halts later steps and exposes bounded permitted context without stale refs or URLs', async t => {
  const { page, requests } = await fixture(t, '<title>Missing item</title><a href="/guide">Care guide</a><a href="/account">Account</a>');
  const result = await runWorkflow({ page, plan: { steps: [{ operation: 'open_link', targetText: 'Missing item' }, link] } });
  assert.equal(result.status, 'incomplete'); assert.equal(result.reason, 'no_exact_link'); assert.equal(result.failedStep, 1);
  assert.equal(result.steps.length, 1); assert.equal(result.metrics.nativeActionAttempts, 0);
  assert.equal(requests.some(request => request.path === '/guide'), false);
  assert.equal(result.escalation.automaticRetryAllowed, false);
  assert.equal(result.escalation.permittedContext.controls.length, 1);
  for (const control of result.escalation.permittedContext.controls) {
    assert.deepEqual(Object.keys(control).sort(), ['role', 'supports', 'what', 'where']);
  }
});

test('inserted nodes do not retarget the selected actual node, and later steps observe a new document', async t => {
  const { page, requests } = await fixture(t, '<main><a href="/item">Amber Lantern</a></main>');
  let inserted = false;
  const result = await runWorkflow({ page, plan: { steps: [{ operation: 'open_link', targetText: 'Amber Lantern' }, link] },
    onEvent: async event => {
      if (event.type === 'action_planned' && event.step === 1 && !inserted) {
        inserted = true;
        await page.locator('main').evaluate(node => node.insertAdjacentHTML('afterbegin', '<a href="/wrong">Decoy</a>'));
      }
    } });
  assert.equal(result.status, 'completed', JSON.stringify(result));
  assert.equal(result.metrics.staleRefreshes, 0); assert.equal(result.metrics.clickAttempts, 2);
  assert.equal(requests.some(request => request.path === '/wrong'), false);
});

test('replacement before dispatch refreshes safely; a forbidden href change never executes', async t => {
  for (const forbidden of [false, true]) {
    const { page, requests } = await fixture(t, '<main><a href="/guide">Care guide</a></main>');
    let changed = false;
    const result = await runWorkflow({ page, plan: { steps: [link] }, onEvent: async event => {
      if (event.type === 'action_planned' && !changed) {
        changed = true;
        await page.locator('a').evaluate((node, forbidden) => {
          if (forbidden) node.href = '/payment'; else node.replaceWith(node.cloneNode(true));
        }, forbidden);
      }
    } });
    assert.equal(result.status, forbidden ? 'incomplete' : 'completed', JSON.stringify(result));
    assert.equal(result.metrics.staleRefreshes, 1);
    assert.equal(result.metrics.clickAttempts, forbidden ? 0 : 1);
    assert.equal(requests.some(request => request.path === '/payment'), false);
  }
});

test('all steps share one action budget; journal failure prevents the first native dispatch', async t => {
  const budget = await fixture(t);
  const limited = await runWorkflow({ page: budget.page, plan: { steps: [search, link] }, maxActions: 3 });
  assert.equal(limited.reason, 'action_limit'); assert.equal(limited.failedStep, 2);
  assert.equal(limited.metrics.nativeActionAttempts, 3); assert.equal(limited.steps[0].status, 'completed');
  const journal = await fixture(t, '<a href="/guide">Care guide</a>');
  const stopped = await runWorkflow({ page: journal.page, plan: { steps: [link] }, onEvent: event => {
    if (event.type === 'action_planned') throw new Error('private journal failure');
  } });
  assert.equal(stopped.reason, 'event_sink_failed'); assert.equal(stopped.metrics.nativeActionAttempts, 0);
  assert.equal(stopped.escalation.reason, 'event_sink_failed');
});

test('exact heading without navigation fails the step; mutation requests stop the workflow', async t => {
  const unchanged = await fixture(t, '<a href="/guide" onclick="event.preventDefault();document.body.insertAdjacentHTML(\'beforeend\',\'<h1>Care guide</h1>\')">Care guide</a>');
  const noNavigation = await runWorkflow({ page: unchanged.page, plan: { steps: [link, search] }, maxMs: 1000 });
  assert.equal(noNavigation.status, 'incomplete'); assert(['postcondition_failed', 'time_limit'].includes(noNavigation.reason));
  assert.equal(noNavigation.steps.length, 1); assert.equal(noNavigation.steps[0].evidence.urlChanged, false);
  const mutation = await fixture(t, '<a href="/guide" onclick="event.preventDefault();fetch(\'/mutate\',{method:\'POST\'})">Care guide</a>');
  const blocked = await runWorkflow({ page: mutation.page, plan: { steps: [link] }, maxMs: 1000 });
  assert.equal(blocked.status, 'incomplete'); assert.equal(blocked.reason, 'forbidden_request');
  assert.equal(mutation.requests.some(request => request.method === 'POST'), false);
});

test('a heading rendered before asynchronous pushState waits for navigation without scanning in a loop', async t => {
  const { page } = await fixture(t, '<a href="/guide" onclick="event.preventDefault();document.body.insertAdjacentHTML(\'beforeend\',\'<h1>Care guide</h1>\');setTimeout(()=>history.pushState({},\'\',\'/guide\'),100)">Care guide</a>');
  const result = await runWorkflow({ page, plan: { steps: [link] }, maxMs: 1500 });
  assert.equal(result.status, 'completed', JSON.stringify(result));
  assert.equal(result.steps[0].evidence.urlChanged, true);
  assert(result.metrics.conditionWaitMs >= 60);
  assert(result.metrics.observations < 10);
});

test('an explicit unmatched context requires semantic choice even for one exact link', async t => {
  const { page } = await fixture(t, '<section aria-label="Travel shelf"><a href="/guide">Care guide</a></section>');
  const plan = { steps: [{ ...link, context: 'Studio shelf' }] };
  const noChooser = await runWorkflow({ page, plan });
  assert.equal(noChooser.reason, 'context_unresolved'); assert.equal(noChooser.metrics.clickAttempts, 0);
  let called = false;
  const abstained = await runWorkflow({ page, plan, choose: ({ candidates }) => { called = true; assert.equal(candidates.length, 1); return null; } });
  assert.equal(called, true); assert.equal(abstained.reason, 'chooser_invalid_ref'); assert.equal(abstained.metrics.clickAttempts, 0);
});

test('uncertain native dispatch is never retried, and hung chooser respects the workflow deadline', async t => {
  const overlay = await fixture(t, '<a href="/guide">Care guide</a><div style="position:fixed;inset:0;z-index:5"></div>');
  const uncertain = await runWorkflow({ page: overlay.page, plan: { steps: [link, search] }, maxMs: 450 });
  assert.equal(uncertain.reason, 'uncertain_execution'); assert.equal(uncertain.metrics.clickAttempts, 1);
  assert.equal(uncertain.metrics.staleRefreshes, 0); assert.equal(uncertain.steps.length, 1);
  assert.equal(uncertain.escalation.uncertainAction, true);
  const duplicate = await fixture(t, '<a href="/guide">Care guide</a><a href="/other">Care guide</a>');
  const hung = await runWorkflow({ page: duplicate.page, plan: { steps: [link] }, choose: () => new Promise(() => {}), maxMs: 250 });
  assert.equal(hung.reason, 'time_limit'); assert.equal(hung.metrics.clickAttempts, 0);
  assert(hung.metrics.totalMs < 1500);
});

test('independent merchant/item fixtures verify all three compiled workflows', async t => {
  const server = await createFixtureServer({ seed: 4242 });
  t.after(() => server.close());
  for (const descriptor of server.cases) {
    const context = await (await launch()).newContext({ serviceWorkers: 'block', acceptDownloads: false });
    t.after(() => context.close());
    const page = await context.newPage();
    await page.goto(descriptor.startUrl);
    const result = await runWorkflow({ page, plan: descriptor.publicPlan, choose: request => {
      // Declared synthetic oracle for fixture semantics, not runtime policy.
      const chosen = request.candidates.find(candidate => candidate.where.includes('Studio district'));
      assert(chosen, 'only the fixture semantic ambiguity should need a chooser');
      return chosen.ref;
    } });
    assert.equal(result.status, 'completed', JSON.stringify({ id: descriptor.id, result }));
    assert.equal(result.independentlyVerified, false);
    const verification = await server.verify(page, descriptor);
    assert.equal(verification.passed, true, JSON.stringify({ id: descriptor.id, verification }));
  }
});
