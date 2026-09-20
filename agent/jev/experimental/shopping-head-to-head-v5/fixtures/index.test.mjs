import test from 'node:test';
import assert from 'node:assert/strict';
import { startFixture } from './index.mjs';

async function withFixture(fn) { const fixture = await startFixture({ seed: 71 }); try { await fn(fixture); } finally { await fixture.close(); } }
const taskFor = (fixture, id) => fixture.tasks.find(task => task.id === id);
async function observedProduct(fixture, task, query, category) {
  const html = await (await fetch(`${task.agent.startURL}/search?q=${encodeURIComponent(query)}`)).text();
  const sections = [...html.matchAll(/<section aria-label="([^"]+)">([\s\S]*?)<\/section>/g)];
  const section = category ? sections.find(match => match[1] === category) : sections[0];
  const href = section?.[2].match(/href="([^"]*\/product\/([a-f0-9]{20}))"/);
  assert.ok(href, 'observed product link');
  await fetch(fixture.origin + href[1]);
  return href[2];
}
async function add(task, productId, { size = 'Standard', color = 'Natural', quantity = 1 } = {}) {
  return fetch(`${task.agent.startURL}/cart/add`, { method: 'POST', redirect: 'manual',
    body: new URLSearchParams({ productId, size, color, quantity: String(quantity) }) });
}

test('public agent inputs omit evaluator answers; reset restores independent case state', async () => withFixture(async fixture => {
  assert.equal(fixture.tasks.length, 5);
  for (const task of fixture.tasks) {
    assert.deepEqual(Object.keys(task.agent).sort(), ['goal', 'startURL']);
    assert.match(task.agent.startURL, /^http:\/\/127\.0\.0\.1:\d+\/s\/[a-f0-9]{20}$/);
    assert.ok(Object.isFrozen(task.agent));
    assert.equal(fixture.verify(task.id).passed, false);
    for (const item of fixture.expected(task.id).cart) assert.ok(!JSON.stringify(task.agent).includes(item.productId));
    for (const route of ['/state', '/expected', '/reset']) assert.equal((await fetch(task.agent.startURL + route)).status, 404);
    const copy = fixture.state(task.id); copy.cart.push({ forged: true });
    assert.deepEqual(fixture.state(task.id).cart, []);
    fixture.reset(task.id);
    assert.deepEqual(fixture.state(task.id).events, []);
  }
}));

test('quantity task requires search, detail, exact quantity and subsequent cart view; repeated add fails', async () => withFixture(async fixture => {
  const task = taskFor(fixture, 'simple-quantity');
  const id = await observedProduct(fixture, task, 'Copper Finch Notebook');
  const response = await add(task, id, { quantity: 2 });
  assert.equal(response.status, 303);
  assert.equal(fixture.verify(task.id).checks.cartViewedAfterAddition, false);
  const cart = await (await fetch(new URL(response.headers.get('location'), fixture.origin))).text();
  assert.match(cart, /Copper Finch Notebook/);
  assert.equal(fixture.verify(task.id).passed, true);
  await add(task, id, { quantity: 2 });
  await fetch(task.agent.startURL + '/cart');
  assert.equal(fixture.verify(task.id).checks.exactCart, false);
  fixture.reset(task.id);
  assert.deepEqual(fixture.state(task.id).cart, []);
  assert.equal(fixture.verify(task.id).passed, false);
}));

test('duplicate labels and wrong variants cannot satisfy independent cart identity', async () => withFixture(async fixture => {
  const task = taskFor(fixture, 'duplicate-variants');
  for (const [category, size, color, passed] of [
    ['Desk accessories', '750 ml', 'Forest', false],
    ['Hiking equipment', '350 ml', 'Silver', false],
    ['Hiking equipment', '750 ml', 'Forest', true],
  ]) {
    fixture.reset(task.id);
    const id = await observedProduct(fixture, task, 'Trail Bottle', category);
    await add(task, id, { size, color, quantity: 3 });
    await fetch(task.agent.startURL + '/cart');
    assert.equal(fixture.verify(task.id).passed, passed);
  }
}));

test('delayed results and acknowledgement preserve exactly one addition', async () => withFixture(async fixture => {
  const task = taskFor(fixture, 'delayed-results');
  const before = performance.now();
  const id = await observedProduct(fixture, task, 'Cedar Arc Planner');
  assert.ok(performance.now() - before >= 550);
  const addStarted = performance.now();
  const response = await add(task, id);
  assert.ok(performance.now() - addStarted >= 300);
  await fetch(new URL(response.headers.get('location'), fixture.origin));
  assert.equal(fixture.verify(task.id).passed, true);
  assert.equal(fixture.state(task.id).events.filter(event => event.type === 'cart_added').length, 1);
}));

test('empty case requires observed exact empty search and no substitute; checkout can never place an order', async () => withFixture(async fixture => {
  const task = taskFor(fixture, 'empty-result');
  await fetch(task.agent.startURL);
  assert.equal(fixture.verify(task.id).passed, false);
  const response = await fetch(`${task.agent.startURL}/search?q=Orchid%20Archive%20Binder`);
  assert.match(await response.text(), /No matching products/);
  assert.deepEqual(fixture.verify(task.id), { kind: 'expected_stop', passed: true, checks: {
    noCheckoutOrForbiddenRequests: true, exactCart: true, exactPreferences: true, requestedSearchReturnedEmpty: true, noCartMutation: true,
  } });
  assert.equal((await fetch(task.agent.startURL + '/checkout')).status, 403);
  assert.equal(fixture.verify(task.id).passed, false);
  assert.deepEqual(fixture.state(task.id).orders, []);
}));

test('preference task checks saved values and unchanged page-number setting', async () => withFixture(async fixture => {
  const task = taskFor(fixture, 'reading-preferences');
  await fetch(task.agent.startURL);
  const save = async pageNumbers => fetch(task.agent.startURL + '/preferences', { method: 'POST',
    body: new URLSearchParams({ theme: 'Sepia', textSize: 'Large', ...(pageNumbers ? { pageNumbers: 'on' } : {}) }) });
  await save(false);
  assert.equal(fixture.verify(task.id).passed, false);
  fixture.reset(task.id);
  await save(true);
  assert.equal(fixture.verify(task.id).passed, true);
  fixture.reset(task.id);
  assert.deepEqual(fixture.state(task.id).preferences, { theme: 'Light', textSize: 'Medium', pageNumbers: true });
}));
