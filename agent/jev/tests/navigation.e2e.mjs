import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright-core';
import { runNavigation, startNavigationAtHome, repeatAuthorizedAgeConfirmation, blocksNavigationMutation } from '../src/navigation.mjs';
import { config, response, temp } from './helpers.mjs';
import { createNavigationJournal } from '../src/navigation-journal.mjs';

function navigationResponse(request, choice) {
  return response(choice, { answers: { next_action: { type: 'choice', choice, confidence: 1,
    probabilities: Object.fromEntries(Object.keys(request.questions.next_action.criteria).map(k => [k, k === choice ? 1 : 0])) } } });
}

test('the shared request guard permits product viewing while aborting address and cart writes', async () => {
  const task = JSON.parse(await readFile(new URL('../cases/foczka-navigation.json', import.meta.url)));
  const target = new URL(task.targetUrl);
  const productViewUrl = `https://api.glovoapp.com/v4/stores/123/addresses/456/products/${target.searchParams.get('productId')}/view?productExternalId=${target.searchParams.get('externalProductId')}`;
  const bodyMarker = 'fixture-translation-body-marker';
  const requestBody = JSON.stringify({ editingMode: false, origin: 'OTHER', translation: bodyMarker });
  const browser = await chromium.launch({ ...(process.env.JEV_BROWSER_CHANNEL ? { channel: process.env.JEV_BROWSER_CHANNEL } : {}), chromiumSandbox: true });
  const events = [], requests = [], blocked = [];
  let productReads = 0;
  try {
    const context = await browser.newContext({ serviceWorkers: 'block' });
    await context.route('**/*', async route => {
      const r = route.request();
      if (blocksNavigationMutation(r.method(), r.url(), { task, postData: r.postData() })) {
        blocked.push(new URL(r.url()).pathname.includes('/carts/') ? 'cart' : 'address');
        return route.abort();
      }
      const headers = { 'access-control-allow-origin': 'https://glovoapp.com',
        'access-control-allow-methods': 'POST, OPTIONS', 'access-control-allow-headers': 'content-type' };
      if (r.method() === 'OPTIONS') return route.fulfill({ status: 204, headers });
      if (r.method() === 'POST') {
        assert.equal(r.url(), productViewUrl, 'Only the verified read route may reach a fixture response');
        productReads++;
        return route.fulfill({ contentType: 'application/json', headers, body: JSON.stringify({ name: task.product }) });
      }
      const isStore = new URL(r.url()).pathname.includes('/stores/');
      const html = !isStore
        ? `<p>${config.expectedAddress}</p><a href="${target.pathname}">${task.merchant}</a>`
        : `<div class="ItemTile_itemTile__test"><h3 onclick="openProduct()">${task.product}</h3></div>
<dialog><h1></h1><button>Dodaj 1</button></dialog><script>
async function openProduct() {
  const options = {method:'POST', headers:{'content-type':'application/json'}, body:${JSON.stringify(requestBody)}};
  const attempts = await Promise.allSettled([
    fetch(${JSON.stringify(productViewUrl)}, options).then(r => r.json()),
    fetch('https://api.glovoapp.com/v4/address/456', options),
    fetch('https://api.glovoapp.com/v4/carts/123/items', options)
  ]);
  window.addressAndCartRejected = attempts.slice(1).every(result => result.status === 'rejected');
  if (attempts[0].status === 'fulfilled') {
    history.pushState({},'',${JSON.stringify(task.targetUrl)});
    document.querySelector('h1').textContent = attempts[0].value.name;
    document.querySelector('dialog').showModal();
  }
}
</script>`;
      return route.fulfill({ contentType: 'text/html; charset=utf-8', body: html });
    });
    const page = await context.newPage();
    const result = await runNavigation({ page, task, config, signal: AbortSignal.timeout(15000),
      onEvent: async event => events.push(event), decide: async request => {
        requests.push(request);
        return navigationResponse(request, Object.entries(request.questions.next_action.criteria)
          .find(([, label]) => label.startsWith('Open product:') || label.startsWith('Open link:'))[0]);
      } });
    assert.equal(result.status, 'reached_target', JSON.stringify(result));
    assert.equal(result.verification.passed, true);
    assert.equal(productReads, 1);
    assert.deepEqual(blocked.sort(), ['address', 'cart']);
    assert.equal(await page.evaluate(() => window.addressAndCartRejected), true);
    assert.equal(result.basketActions, 0);
    assert(!JSON.stringify({ events, requests, result }).includes(bodyMarker), 'Request body must not enter journals or model inputs');
  } finally { await browser.close(); }
});

test('Playwright traverses homepage, merchant and product with independent target verification and zero basket writes', async () => {
  const task = JSON.parse(await readFile(new URL('../cases/foczka-navigation.json', import.meta.url)));
  const browser = await chromium.launch({ ...(process.env.JEV_BROWSER_CHANNEL ? { channel: process.env.JEV_BROWSER_CHANNEL } : {}), chromiumSandbox: true });
  let writes = 0;
  try {
    const page = await browser.newPage();
    await page.route('**/*', async route => {
      if (route.request().method() !== 'GET') writes++;
      const u = new URL(route.request().url());
      const isStore = u.pathname.includes('/stores/');
      const html = !isStore ? `<p>${config.expectedAddress}</p><input type="search" aria-label="Wyszukaj" oninput="document.querySelector('a').hidden=false"><a hidden href="${new URL(task.targetUrl).pathname}">Foczka Alkohole</a>`
        : `<div style="height:0;overflow:hidden"><div class="StoreMenuItem_listItem__test"><h3>Hidden category</h3></div></div><div class="ItemRow_itemRow__test"><img alt="${task.product}"><p onclick="history.pushState({},'',${JSON.stringify(task.targetUrl).replaceAll('"', '&quot;')});document.querySelector('dialog').showModal()">${task.product}</p><button onclick="fetch('/cart',{method:'POST'})">Increase quantity</button></div><dialog><h1>${task.product}</h1><button>Dodaj 1</button></dialog>`;
      await route.fulfill({ contentType: 'text/html; charset=utf-8', body: html });
    });
    const result = await runNavigation({ page, task, config, signal: AbortSignal.timeout(20000), decide: async request => {
      const choices = Object.entries(request.questions.next_action.criteria);
      assert(!JSON.stringify(choices).includes('Hidden category'));
      return navigationResponse(request, (choices.find(([, d]) => d.startsWith('Open product:')) || choices.find(([, d]) => d.startsWith('Open link:'))
        || choices.find(([, d]) => d.startsWith('Search for')))[0]);
    } });
    assert.equal(result.status, 'reached_target', JSON.stringify(result));
    assert.equal(result.metrics.actions, 3); assert.equal(writes, 0); assert.equal(result.basketActions, 0);
  } finally { await browser.close(); }
});

test('a visible age confirmation stops navigation before any model call', async () => {
  const task = JSON.parse(await readFile(new URL('../cases/foczka-navigation.json', import.meta.url)));
  const browser = await chromium.launch({ ...(process.env.JEV_BROWSER_CHANNEL ? { channel: process.env.JEV_BROWSER_CHANNEL } : {}), chromiumSandbox: true });
  try {
    const page = await browser.newPage();
    await page.route('**/*', route => route.fulfill({ contentType: 'text/html; charset=utf-8', body:
      `<p>${config.expectedAddress}</p><dialog open>Potwierdź pełnoletniość<input type="checkbox"><button>Zaakceptuj</button></dialog>` }));
    const result = await runNavigation({ page, task, config, signal: AbortSignal.timeout(10000),
      decide: () => { throw new Error('Model must not be called at an age gate'); } });
    assert.equal(result.reason, 'age_confirmation_requires_user');
    assert.equal(result.metrics.modelCalls, 0); assert.equal(result.metrics.actions, 0);
  } finally { await browser.close(); }
});

test('Glovo platform error is distinct from a changed address and costs no model calls', async () => {
  const task = JSON.parse(await readFile(new URL('../cases/foczka-navigation.json', import.meta.url)));
  const browser = await chromium.launch({ ...(process.env.JEV_BROWSER_CHANNEL ? { channel: process.env.JEV_BROWSER_CHANNEL } : {}), chromiumSandbox: true });
  try {
    const page = await browser.newPage();
    await page.route('**/*', route => route.fulfill({ contentType: 'text/html; charset=utf-8', body:
      `<p>Oh, no!</p><p>It looks like there's a problem, but we're working on it.</p><p>We're always improving our platform, so we'll get this fixed soon!</p>` }));
    const result = await runNavigation({ page, task, config, signal: AbortSignal.timeout(10000),
      decide: () => { throw new Error('Model must not be called on a platform error'); } });
    assert.equal(result.reason, 'merchant_site_unavailable');
    assert.equal(result.metrics.modelCalls, 0);
  } finally { await browser.close(); }
});

test('manual preparation survives homepage navigation in the same live tab', async () => {
  const task = JSON.parse(await readFile(new URL('../cases/foczka-navigation.json', import.meta.url)));
  const browser = await chromium.launch({ ...(process.env.JEV_BROWSER_CHANNEL ? { channel: process.env.JEV_BROWSER_CHANNEL } : {}), chromiumSandbox: true });
  let requests = 0;
  try {
    const page = await browser.newPage();
    await page.route('**/*', route => {
      requests++;
      return route.fulfill({ contentType: 'text/html; charset=utf-8', body: `<p>${config.expectedAddress}</p>
<a href="${task.startUrl}" onclick="event.preventDefault();history.pushState({},'',this.href);document.querySelector('#ready').hidden=false">Przejdź na stronę główną</a>
<button id="prepare" onclick="window.prepared=true;this.remove()">Prepare test session</button>
<div id="ready" hidden><a href="${task.targetUrl.replaceAll('&', '&amp;')}" onclick="event.preventDefault();if(window.prepared){history.pushState({},'',this.href);document.querySelector('dialog').showModal()}">Open fixture product</a></div>
<dialog><h1>${task.product}</h1><button onclick="this.closest('dialog').close()">Zamknij</button></dialog>` });
    });
    await page.goto(new URL(task.targetUrl).origin + new URL(task.targetUrl).pathname);
    await page.getByRole('button', { name: 'Prepare test session', exact: true }).click();
    for (let i = 0; i < 2; i++) {
      const result = await runNavigation({ page, task, config, signal: AbortSignal.timeout(10000),
        startPage: () => startNavigationAtHome(page, task), decide: async request => navigationResponse(request,
          Object.entries(request.questions.next_action.criteria).find(([, d]) => d.includes('Open fixture product'))[0]) });
      assert.equal(result.status, 'reached_target', JSON.stringify(result));
      await page.getByRole('button', { name: 'Zamknij', exact: true }).click();
    }
    assert.equal(requests, 1, 'No document reload may discard the manually prepared live session');
  } finally { await browser.close(); }
});

test('explicitly authorized confirmation is scoped to the approved case, store and exact declaration', async () => {
  const task = JSON.parse(await readFile(new URL('../cases/foczka-navigation.json', import.meta.url)));
  const browser = await chromium.launch({ ...(process.env.JEV_BROWSER_CHANNEL ? { channel: process.env.JEV_BROWSER_CHANNEL } : {}), chromiumSandbox: true });
  try {
    const page = await browser.newPage();
    await page.route('**/*', route => route.fulfill({ contentType: 'text/html; charset=utf-8', body:
      `<dialog open aria-label="Potwierdź pełnoletniość"><p>Potwierdzam, że mam co najmniej 18 lat i akceptuję regulamin sprzedaży napojów alkoholowych.</p><input type="checkbox" onchange="document.querySelector('button').disabled=!this.checked"><button disabled onclick="this.closest('dialog').close()">Zaakceptuj</button></dialog>` }));
    await page.goto(new URL(task.targetUrl).origin + new URL(task.targetUrl).pathname);
    await assert.rejects(repeatAuthorizedAgeConfirmation(page, { ...task, id: 'different-case' }), /not_authorized_for_case/);
    assert.equal(await page.getByRole('checkbox').isChecked(), false);
    await repeatAuthorizedAgeConfirmation(page, task);
    assert.equal(await page.getByRole('dialog').count(), 0);
    await page.reload();
    await page.locator('dialog p').evaluate(e => { e.textContent = 'Different terms'; });
    await assert.rejects(repeatAuthorizedAgeConfirmation(page, task), /unexpected_age_confirmation_terms/);
    assert.equal(await page.getByRole('checkbox').isChecked(), false);
  } finally { await browser.close(); }
});

test('closed-store viewing succeeds with a saved decision before each action and no order scheduling', async t => {
  const task = JSON.parse(await readFile(new URL('../cases/foczka-navigation.json', import.meta.url)));
  const journal = await createNavigationJournal(await temp(t), { task, config, environment: 'fixture', batchId: 'test', run: 1 });
  const browser = await chromium.launch({ ...(process.env.JEV_BROWSER_CHANNEL ? { channel: process.env.JEV_BROWSER_CHANNEL } : {}), chromiumSandbox: true });
  try {
    const page = await browser.newPage();
    await page.route('**/*', route => {
      const isStore = new URL(route.request().url()).pathname.includes('/stores/');
      return route.fulfill({ contentType: 'text/html; charset=utf-8', body: !isStore
        ? `<p>${config.expectedAddress}</p><a href="${new URL(task.targetUrl).pathname}">${task.merchant}</a>`
        : `<dialog open id="closed"><h1>Foczka Alkohole teraz nie pracuje. Następne otwarcie: 16:00</h1><button onclick="this.closest('dialog').close()">Zamknij</button><button onclick="window.scheduled=true">Zaplanuj zamówienie</button></dialog>
<div class="ItemRow_itemRow__test"><img alt="${task.product}"><p onclick="history.pushState({},'',${JSON.stringify(task.targetUrl).replaceAll('"', '&quot;')});document.querySelector('#product').showModal()">${task.product}</p></div><dialog id="product"><h1>${task.product}</h1><button>Dodaj 1</button></dialog>` });
    });
    const result = await runNavigation({ page, task, config, signal: AbortSignal.timeout(20000),
      onEvent: event => journal.record(event), decide: async request => {
        const saved = JSON.parse(await readFile(journal.path));
        assert.equal(saved.events.at(-1).type, 'model_request_planned');
        assert(!JSON.stringify(request).includes('Zaplanuj'));
        const choice = Object.entries(request.questions.next_action.criteria).find(([id]) => id !== 'unavailable')[0];
        return navigationResponse(request, choice);
      } });
    await journal.finish(result);
    assert.equal(result.status, 'reached_target', JSON.stringify(result));
    assert.equal(result.metrics.policyActions, 1); assert.equal(result.metrics.modelCalls, 2);
    assert.equal(await page.evaluate(() => Boolean(window.scheduled)), false);
    const saved = JSON.parse(await readFile(journal.path));
    for (const event of saved.events.filter(e => e.type === 'action_executed')) {
      const planned = saved.events.find(e => e.type === 'action_planned' && e.step === event.step);
      assert(planned && planned.sequence < event.sequence);
    }
    assert.equal(saved.status, 'reached_target');
    assert(saved.events.some(e => e.type === 'completion_verified'));
    assert(!JSON.stringify(saved).includes(config.expectedAddress));
  } finally { await browser.close(); }
});

test('a failed pre-action journal write prevents the browser action', async () => {
  const task = JSON.parse(await readFile(new URL('../cases/foczka-navigation.json', import.meta.url)));
  const browser = await chromium.launch({ ...(process.env.JEV_BROWSER_CHANNEL ? { channel: process.env.JEV_BROWSER_CHANNEL } : {}), chromiumSandbox: true });
  try {
    const page = await browser.newPage();
    await page.route('**/*', route => route.fulfill({ contentType: 'text/html; charset=utf-8', body:
      `<p>${config.expectedAddress}</p><a href="${new URL(task.targetUrl).pathname}" onclick="window.clicked=true;event.preventDefault()">${task.merchant}</a>` }));
    const result = await runNavigation({ page, task, config, signal: AbortSignal.timeout(10000),
      onEvent: async event => { if (event.type === 'action_planned') throw new Error('disk full'); },
      decide: async request => navigationResponse(request, 'a0') });
    assert.equal(result.reason, 'navigation_journal_failed');
    assert.equal(result.metrics.actions, 0);
    assert.equal(await page.evaluate(() => Boolean(window.clicked)), false);
  } finally { await browser.close(); }
});

test('a product URL and stable modal shell wait for the independently verified visible title', async () => {
  const task = JSON.parse(await readFile(new URL('../cases/foczka-navigation.json', import.meta.url)));
  const browser = await chromium.launch({ ...(process.env.JEV_BROWSER_CHANNEL ? { channel: process.env.JEV_BROWSER_CHANNEL } : {}), chromiumSandbox: true });
  try {
    const page = await browser.newPage();
    await page.route('**/*', route => route.fulfill({ contentType: 'text/html; charset=utf-8', body:
      `<p>${config.expectedAddress}</p><a href="${task.targetUrl.replaceAll('&', '&amp;')}" onclick="event.preventDefault();history.pushState({},'',this.href);document.querySelector('dialog').showModal();setTimeout(()=>{document.querySelector('h1').hidden=false;window.titleVisibleAt=performance.now()},1600)">${task.merchant}</a>
<dialog><button>Zamknij</button><h1 hidden>${task.product}</h1><button>Dodaj 1</button></dialog>` }));
    const result = await runNavigation({ page, task, config, signal: AbortSignal.timeout(15000),
      decide: async request => navigationResponse(request, 'a0') });
    assert.equal(result.status, 'reached_target', JSON.stringify(result));
    assert.equal(result.metrics.modelCalls, 1);
    assert.equal(result.verification.checks.visibleProduct, true);
    assert(result.metrics.totalMs >= 1600);
    assert.equal(result.steps.at(-1).outcome, 'completion_verified');
    assert(await page.evaluate(() => performance.now() - window.titleVisibleAt) < 650,
      'Already verified product details must not incur another 700 ms stability wait');
  } finally { await browser.close(); }
});

function productRollbackFixture(task, recoverOnRetry, urlDelayMs = 0) {
  const storeUrl = new URL(task.targetUrl).origin + new URL(task.targetUrl).pathname;
  return `<p>${config.expectedAddress}</p>
<a href="${storeUrl}" onclick="event.preventDefault();history.pushState({},'',this.href);this.hidden=true;document.querySelector('#catalogue').hidden=false">${task.merchant}</a>
<section id="catalogue" hidden><div class="ItemTile_itemTile__test"><h3 onclick="openProduct()">${task.product}</h3>
<button onclick="fetch('/cart',{method:'POST'})">Increase quantity</button></div></section>
<dialog><button>Zamknij</button><h1 hidden>${task.product}</h1><button>Dodaj 1</button></dialog>
<script>
window.productClicks = 0;
function openProduct() {
  window.productClicks++;
  if (${urlDelayMs}) setTimeout(enterProduct, ${urlDelayMs});
  else enterProduct();
}
function enterProduct() {
  history.pushState({}, '', ${JSON.stringify(task.targetUrl)});
  document.querySelector('dialog').showModal();
  if (${JSON.stringify(recoverOnRetry)} && window.productClicks === 2) {
    setTimeout(() => { document.querySelector('h1').hidden = false; window.titleVisibleAt = performance.now(); }, 1200);
  } else {
    setTimeout(() => {
      document.querySelector('dialog').close();
      history.pushState({}, '', ${JSON.stringify(storeUrl)});
      const unrelated = document.createElement('button');
      unrelated.textContent = 'Unrelated control ' + window.productClicks;
      document.querySelector('h3').before(unrelated);
    }, ${urlDelayMs ? 400 : 250});
  }
}
</script>`;
}

test('two product rollbacks stop even when unrelated DOM changes reset the old state fingerprint', async () => {
  const task = JSON.parse(await readFile(new URL('../cases/foczka-navigation.json', import.meta.url)));
  const browser = await chromium.launch({ ...(process.env.JEV_BROWSER_CHANNEL ? { channel: process.env.JEV_BROWSER_CHANNEL } : {}), chromiumSandbox: true });
  let writes = 0, sawRollbackHistory = false;
  const events = [];
  try {
    const page = await browser.newPage();
    await page.route('**/*', route => {
      if (route.request().method() !== 'GET') writes++;
      return route.fulfill({ contentType: 'text/html; charset=utf-8', body: productRollbackFixture(task, false) });
    });
    const result = await runNavigation({ page, task, config, signal: AbortSignal.timeout(15000),
      onEvent: async event => events.push(event), decide: async request => {
        const history = JSON.parse(request.state).history;
        if (history.at(-1)?.outcome === 'product_open_rolled_back') {
          sawRollbackHistory = true;
          assert.equal(history.at(-1).productTransition.targetIdsAfterExecute, true);
          assert.equal(history.at(-1).productTransition.targetIdsAfterWait, false);
        }
        const choice = Object.entries(request.questions.next_action.criteria)
          .find(([, label]) => label.startsWith('Open product:') || label.startsWith('Open link:'))[0];
        return navigationResponse(request, choice);
      } });
    assert.equal(result.status, 'incomplete');
    assert.equal(result.reason, 'product_open_rollback_limit');
    assert.equal(result.metrics.modelCalls, 3);
    assert.equal(result.metrics.productOpenRollbacks, 2);
    assert.equal(await page.evaluate(() => window.productClicks), 2);
    assert.equal(result.verification.passed, false);
    assert.equal(result.verification.checks.productId, false);
    assert.deepEqual(result.steps.filter(s => s.outcome === 'product_open_rolled_back').map(s => s.productRollbackCount), [1, 2]);
    const productControls = events.filter(e => e.type === 'action_planned' && e.control?.purpose === 'product');
    assert.equal(productControls.length, 2);
    assert.notEqual(productControls[0].control.index, productControls[1].control.index);
    assert(sawRollbackHistory);
    assert(events.some(e => e.type === 'run_stopped' && e.reason === 'product_open_rollback_limit'));
    assert.equal(writes, 0);
    assert.equal(result.basketActions, 0);
  } finally { await browser.close(); }
});

test('one product rollback permits a retry that waits for delayed verified details', async () => {
  const task = JSON.parse(await readFile(new URL('../cases/foczka-navigation.json', import.meta.url)));
  const browser = await chromium.launch({ ...(process.env.JEV_BROWSER_CHANNEL ? { channel: process.env.JEV_BROWSER_CHANNEL } : {}), chromiumSandbox: true });
  try {
    const page = await browser.newPage();
    await page.route('**/*', route => route.fulfill({ contentType: 'text/html; charset=utf-8', body: productRollbackFixture(task, true) }));
    const result = await runNavigation({ page, task, config, signal: AbortSignal.timeout(15000),
      decide: async request => navigationResponse(request, Object.entries(request.questions.next_action.criteria)
        .find(([, label]) => label.startsWith('Open product:') || label.startsWith('Open link:'))[0]) });
    assert.equal(result.status, 'reached_target', JSON.stringify(result));
    assert.equal(result.metrics.modelCalls, 3);
    assert.equal(result.metrics.productOpenRollbacks, 1);
    assert.equal(await page.evaluate(() => window.productClicks), 2);
    assert.equal(result.steps.at(-1).outcome, 'completion_verified');
    assert.equal(result.verification.passed, true);
    assert(result.steps.at(-1).actionAndWaitMs >= 1200, 'The product URL alone cannot complete the retry');
    assert(await page.evaluate(() => performance.now() - window.titleVisibleAt) < 650,
      'Verified delayed details should complete without another stability wait');
  } finally { await browser.close(); }
});

test('asynchronous product URL entry and rollback stop on the second attempt despite DOM churn', async () => {
  const task = JSON.parse(await readFile(new URL('../cases/foczka-navigation.json', import.meta.url)));
  const browser = await chromium.launch({ ...(process.env.JEV_BROWSER_CHANNEL ? { channel: process.env.JEV_BROWSER_CHANNEL } : {}), chromiumSandbox: true });
  const events = [];
  let sawDelayedRollbackHistory = false;
  try {
    const page = await browser.newPage();
    await page.route('**/*', route => route.fulfill({ contentType: 'text/html; charset=utf-8',
      body: productRollbackFixture(task, false, 450) }));
    const result = await runNavigation({ page, task, config, signal: AbortSignal.timeout(15000),
      onEvent: async event => events.push(event), decide: async request => {
        const previous = JSON.parse(request.state).history.at(-1);
        if (previous?.outcome === 'product_open_rolled_back') {
          sawDelayedRollbackHistory = true;
          assert.equal(previous.productTransition.targetIdsAfterExecute, false);
          assert.equal(previous.productTransition.targetIdsObservedDuringWait, true);
        }
        return navigationResponse(request, Object.entries(request.questions.next_action.criteria)
          .find(([, label]) => label.startsWith('Open product:') || label.startsWith('Open link:'))[0]);
      } });
    assert.equal(result.status, 'incomplete');
    assert.equal(result.reason, 'product_open_rollback_limit');
    assert.equal(result.metrics.modelCalls, 3);
    assert.equal(result.metrics.productOpenRollbacks, 2);
    assert.equal(await page.evaluate(() => window.productClicks), 2);
    assert.equal(result.verification.passed, false);
    const failed = result.steps.filter(s => s.outcome === 'product_open_rolled_back');
    assert.deepEqual(failed.map(s => s.productRollbackCount), [1, 2]);
    for (const step of failed) {
      assert.deepEqual(step.productTransition, { targetIdsAfterExecute: false,
        targetIdsObservedDuringWait: true, targetIdsObservedInNavigation: true,
        targetIdsAfterWait: false, visibleExactTitleAfterWait: false });
    }
    const productControls = events.filter(e => e.type === 'action_planned' && e.control?.purpose === 'product');
    assert.notEqual(productControls[0].control.index, productControls[1].control.index);
    assert(sawDelayedRollbackHistory);
  } finally { await browser.close(); }
});

test('product URL round-trips during journal writes are counted and navigation listeners are always removed', async () => {
  const task = JSON.parse(await readFile(new URL('../cases/foczka-navigation.json', import.meta.url)));
  const browser = await chromium.launch({ ...(process.env.JEV_BROWSER_CHANNEL ? { channel: process.env.JEV_BROWSER_CHANNEL } : {}), chromiumSandbox: true });
  try {
    for (const failJournal of [false, true]) {
      const page = await browser.newPage();
      await page.route('**/*', route => route.fulfill({ contentType: 'text/html; charset=utf-8',
        body: productRollbackFixture(task, false, 450) }));
      const initialListeners = page.listenerCount('framenavigated');
      const result = await runNavigation({ page, task, config, signal: AbortSignal.timeout(15000),
        onEvent: async event => {
          if (event.type === 'action_executed' && event.action.startsWith('Open product:')) {
            // The async target URL enters at 450 ms and rolls back at 850 ms,
            // entirely before observeReady gets its first post-action sample.
            await new Promise(resolve => setTimeout(resolve, 1000));
            if (failJournal) throw new Error('Fixture journal failure');
          }
        },
        decide: async request => navigationResponse(request, Object.entries(request.questions.next_action.criteria)
          .find(([, label]) => label.startsWith('Open product:') || label.startsWith('Open link:'))[0]) });
      assert.equal(page.listenerCount('framenavigated'), initialListeners, 'Per-action listener must be removed on success and error paths');
      assert.equal(result.status, 'incomplete');
      assert.equal(result.reason, failJournal ? 'navigation_journal_failed' : 'product_open_rollback_limit');
      if (!failJournal) {
        assert.equal(result.metrics.productOpenRollbacks, 2);
        const failed = result.steps.filter(s => s.outcome === 'product_open_rolled_back');
        assert.deepEqual(failed.map(s => s.productRollbackCount), [1, 2]);
        for (const step of failed) {
          assert.deepEqual(step.productTransition, { targetIdsAfterExecute: false,
            targetIdsObservedDuringWait: false, targetIdsObservedInNavigation: true,
            targetIdsAfterWait: false, visibleExactTitleAfterWait: false });
        }
      }
      await page.close();
    }
  } finally { await browser.close(); }
});
