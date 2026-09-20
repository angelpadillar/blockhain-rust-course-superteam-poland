import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { createCandidateIO, CandidateStaleError } from '../src/navigation-candidate-io.mjs';
import { readNavigationDom, navigationActions, blocksNavigationMutation, navigationUrl, verifyNavigation } from '../src/navigation.mjs';

const task = { id: 'candidate-fixture-task', merchant: 'Test shop', product: 'Test juice bottle',
  startUrl: 'https://glovoapp.com/pl/pl/krakow',
  targetUrl: 'https://glovoapp.com/pl/pl/krakow/stores/test-shop?productId=123&externalProductId=12345678-1234-1234-1234-123456789abc',
  maxSteps: 12, maxRunMs: 20000, maxModelUsd: .05 };
const storeUrl = new URL(task.targetUrl).origin + new URL(task.targetUrl).pathname;
const link = `<a id="target" href="${task.startUrl}" onclick="event.preventDefault();document.querySelector('output').value='original'">Home</a>`;
let browser;
test.before(async () => {
  browser = await chromium.launch({ ...(process.env.JEV_BROWSER_CHANNEL ? { channel: process.env.JEV_BROWSER_CHANNEL } : {}), chromiumSandbox: true });
});
test.after(async () => { await browser?.close(); });

async function fixture(t, html) {
  const context = await browser.newContext({ serviceWorkers: 'block' });
  t.after(() => context.close());
  await context.route('**/*', async route => {
    const request = route.request();
    if (blocksNavigationMutation(request.method(), request.url(), { task, postData: request.postData() })
      || (request.isNavigationRequest() && !navigationUrl(request.url()))) return route.abort();
    return route.fulfill({ contentType: 'text/html; charset=utf-8', body: html });
  });
  const page = await context.newPage();
  await page.goto(storeUrl);
  const io = createCandidateIO(page, task);
  t.after(() => io.dispose());
  return { page, io };
}

test('atomic candidate reader exactly matches approved reader including clipping, footer and modal scope', async t => {
  const { page, io } = await fixture(t, `<main><h1>Catalogue</h1>${link}<input type="search" aria-label="Search">
    <button disabled>Disabled</button><a aria-disabled="true" href="${task.startUrl}">Disabled link</a>
    <div style="height:0;overflow:hidden"><a href="${task.startUrl}">Clipped</a></div>
    <div class="ItemTile_itemTile_fixture"><h3>${task.product}</h3></div>
    <div class="ItemRow_itemRow_fixture"><img alt="${task.product}"><p>${task.product}</p><p>Unrelated</p></div>
    <div class="StoreMenuItem_listItem_fixture"><h3>Category</h3></div></main>
    <footer><a href="${task.startUrl}">Footer</a></footer><dialog><h1>${task.product}</h1><button>Dodaj 1</button></dialog>`);
  for (const modal of [false, true]) {
    if (modal) await page.locator('dialog').evaluate(dialog => dialog.showModal());
    const approved = { ...await page.locator('body').evaluate(readNavigationDom), url: page.url() };
    assert.deepEqual(await io.observe(), approved);
    if (modal) assert.equal(navigationActions(approved, task).length, 0);
  }
});

test('an inserted matching node cannot retarget a snapshot reference', async t => {
  const { page, io } = await fixture(t, `<main>${link}<output></output></main>`);
  const observation = await io.observe(), [action] = io.bind(observation, navigationActions(observation, task));
  assert.equal(action.ref, 's1:e0');
  await page.locator('#target').evaluate(target => {
    const added = target.cloneNode(true);
    added.id = 'inserted';
    added.setAttribute('onclick', "event.preventDefault();document.querySelector('output').value='wrong-node'");
    target.before(added);
  });
  await io.execute(observation, action);
  assert.equal(await page.locator('output').textContent(), 'original');
  await assert.rejects(io.execute(observation, action), CandidateStaleError);
});

test('identical replacement after model selection is stale and a fresh observation can recover', async t => {
  const { page, io } = await fixture(t, `<main>${link}<output></output></main>`);
  const observation = await io.observe(), [action] = io.bind(observation);
  await page.locator('#target').evaluate(target => target.replaceWith(target.cloneNode(true)));
  await assert.rejects(io.execute(observation, action), error => error instanceof CandidateStaleError && error.retryable === true);
  assert.equal(await page.locator('output').textContent(), '');
  const next = await io.observe(), [nextAction] = io.bind(next);
  assert.equal(nextAction.ref, 's2:e0');
  await assert.rejects(io.execute(next, action), CandidateStaleError);
  await io.execute(next, nextAction);
  assert.equal(await page.locator('output').textContent(), 'original');
});

test('changed forbidden labels, hrefs, visibility and page URL prevent dispatch', async t => {
  for (const change of ['label', 'href', 'visibility', 'url', 'navigation']) {
    await t.test(change, async subtest => {
      const { page, io } = await fixture(subtest, `<main>${link}<output></output></main>`);
      const observation = await io.observe(), [action] = io.bind(observation);
      if (change === 'navigation') await page.goto(`${storeUrl}?content=fixture`);
      else await page.locator('#target').evaluate((target, change) => {
        if (change === 'label') target.textContent = 'Checkout payment';
        if (change === 'href') target.href = '/pl/pl/krakow/order-summary';
        if (change === 'visibility') target.hidden = true;
        if (change === 'url') history.pushState({}, '', '/pl/pl/krakow/search');
      }, change);
      await assert.rejects(io.execute(observation, action), CandidateStaleError);
      assert.equal(await page.locator('output').textContent(), '');
    });
  }
});

test('descriptors expose fixed semantic context and only supported approved actions', async t => {
  const secret = 'PRIVATE_ANCESTOR_ACCOUNT_DATA';
  const { page, io } = await fixture(t, `<main aria-label="${secret}"><nav><p>${secret}</p>${link}</nav>
    <section role="search" aria-label="${secret}"><input id="search" type="search" aria-label="Search"></section>
    <div class="ItemTile_itemTile_fixture" aria-label="${secret}"><h3>${task.product}</h3></div>
    <div class="StoreMenuItem_listItem_fixture"><h3>Juice</h3></div><output></output></main>`);
  const observation = await io.observe(), actions = io.bind(observation);
  assert(!JSON.stringify(actions).includes(secret));
  const home = actions.find(action => action.control.tag === 'a');
  assert.deepEqual(home.where, ['main', 'nav']);
  assert.equal(home.role, 'link');
  assert.deepEqual(home.supports, ['click']);
  assert.deepEqual(actions.find(action => action.control.purpose === 'product').where, ['main', 'product']);
  assert.deepEqual(actions.find(action => action.control.purpose === 'category').where, ['main', 'category']);
  const fill = actions.find(action => action.kind === 'fill' && action.value === task.product);
  assert.deepEqual(fill.where, ['main', 'search']);
  assert.equal(fill.role, 'searchbox');
  assert.deepEqual(fill.supports, ['fill']);
  await io.execute(observation, fill);
  assert.equal(await page.locator('#search').inputValue(), task.product);
  const next = await io.observe(), nextActions = io.bind(next);
  assert.deepEqual(nextActions.find(action => action.kind === 'press').supports, ['fill', 'press']);
  await io.execute(next, nextActions.find(action => action.kind === 'press'));
});

test('original closed-notice actions work and old generations are invalidated', async t => {
  const { page, io } = await fixture(t, `<dialog open><p>teraz nie pracuje. Następne otwarcie:</p>
    <button onclick="this.closest('dialog').close()">Zamknij</button></dialog>`);
  const old = await io.observe(), oldAction = navigationActions(old, task)[0];
  const observation = await io.observe();
  await assert.rejects(io.execute(old, oldAction), CandidateStaleError);
  await io.execute(observation, navigationActions(observation, task)[0]);
  assert.equal(await page.locator('dialog').isVisible(), false);
});

test('native dispatch failures remain non-retryable even when no click can be confirmed', async t => {
  const { page, io } = await fixture(t, `${link}<output></output><div style="position:fixed;inset:0;z-index:9999;background:white"></div>`);
  const observation = await io.observe(), [action] = io.bind(observation);
  await assert.rejects(io.execute(observation, action), error => !(error instanceof CandidateStaleError) && error.retryable !== true);
  assert.equal(await page.locator('output').textContent(), '');
});

test('candidate uses approved product controls and unchanged independent verifier', async t => {
  const target = task.targetUrl.replaceAll('&', '&amp;');
  const { io } = await fixture(t, `<main><div class="ItemTile_itemTile_fixture"><h3 onclick="history.pushState({},'',this.dataset.url);document.querySelector('dialog').showModal()" data-url="${target}">${task.product}</h3></div>
    <button>Increase quantity</button><dialog><h1>${task.product}</h1><button>Dodaj 1</button></dialog></main>`);
  const observation = await io.observe(), actions = io.bind(observation);
  assert.equal(actions.length, 1);
  await io.execute(observation, actions[0]);
  const settled = await io.observe();
  assert.equal(verifyNavigation(settled, task).passed, true);
  assert.deepEqual(navigationActions(settled, task), []);
});
