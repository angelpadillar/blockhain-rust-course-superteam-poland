import { createServer } from 'node:http';
import { createHash } from 'node:crypto';

const normalize = value => String(value || '').normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase();
const escape = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
const token = value => createHash('sha256').update(value).digest('hex').slice(0, 20);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const deepCopy = value => structuredClone(value);
const defaultPreferences = () => ({ theme: 'Light', textSize: 'Medium', pageNumbers: true });
const specifications = [
  { id: 'simple-quantity', kind: 'cart', title: 'Copper Finch Notebook', category: 'Paper goods', size: 'Standard', color: 'Natural', quantity: 2,
    goal: 'Search for "Copper Finch Notebook", open its details, and add exactly 2 of the Standard version in Natural color to the cart. Leave every other item out of the cart. Check the cart, then stop. Do not enter checkout.' },
  { id: 'duplicate-variants', kind: 'cart', title: 'Trail Bottle', category: 'Hiking equipment', size: '750 ml', color: 'Forest', quantity: 3, duplicate: true,
    goal: 'Search for "Trail Bottle" in Hiking equipment and open its details. Select size "750 ml" and color "Forest", then add exactly 3 to the cart. Leave every other item out of the cart. Check the cart, then stop. Do not enter checkout.' },
  { id: 'delayed-results', kind: 'cart', title: 'Cedar Arc Planner', category: 'Paper goods', size: 'Standard', color: 'Natural', quantity: 1, live: true, resultsDelayMs: 600, addResponseDelayMs: 350,
    goal: 'Search for "Cedar Arc Planner", open its details, and add exactly 1 of the Standard version in Natural color to the cart. Leave every other item out of the cart. Check the cart, then stop. Do not enter checkout.' },
  { id: 'empty-result', kind: 'expected_stop', title: 'Orchid Archive Binder', category: 'Paper goods', absent: true,
    goal: 'Search for "Orchid Archive Binder". If it is unavailable, report that it is unavailable and leave the cart empty. Do not substitute another item or enter checkout.' },
  { id: 'reading-preferences', kind: 'setting',
    goal: 'Set the reading theme to "Sepia" and text size to "Large", save the preferences, and stop. Keep page numbers enabled and do not change any other preference.' },
];

function documentHtml(title, body, script = '') {
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(title)}</title>
<style>body{font:18px system-ui;margin:28px;max-width:950px}nav{display:flex;gap:20px;margin-bottom:24px}a{display:inline-block;padding:8px}button,input{font:inherit;margin:8px;padding:8px}section,article,fieldset{margin:16px 0;padding:16px;border:1px solid #bbb}label{display:inline-block;margin-right:12px}table{border-collapse:collapse}td,th{padding:12px;border:1px solid #bbb}[hidden]{display:none!important}</style>
${body}${script ? `<script>${script}</script>` : ''}</html>`;
}

function radios(name, title, options, selected) {
  return `<fieldset><legend>${escape(title)}</legend>${options.map(value => `<label><input type="radio" name="${name}" value="${escape(value)}"${value === selected ? ' checked' : ''}>${escape(value)}</label>`).join('')}</fieldset>`;
}

// All evaluator state stays in this process. The HTTP site has no reset, state,
// expected-answer or verifier route. Agents receive only each task.agent object.
export async function startFixture({ seed = 20260920 } = {}) {
  if (!Number.isSafeInteger(seed)) throw new Error('invalid_seed');
  const cases = new Map(specifications.map(specification => {
    const spec = { ...specification };
    const sessionId = token(`${seed}:${spec.id}:session`);
    const products = spec.kind === 'setting' ? [] : [
      ...(!spec.absent ? [{ id: token(`${seed}:${spec.id}:primary`), title: spec.title, category: spec.category,
        sizes: spec.duplicate ? ['350 ml', '750 ml'] : ['Standard'], colors: spec.duplicate ? ['Silver', 'Forest'] : ['Natural'] }] : []),
      { id: token(`${seed}:${spec.id}:other`), title: spec.duplicate ? spec.title : 'Linen Pocket Notes',
        category: spec.duplicate ? 'Desk accessories' : 'Paper goods', sizes: ['350 ml', '750 ml'], colors: ['Silver', 'Forest'] },
    ];
    return [spec.id, { spec, sessionId, products, generation: 0, cart: [], preferences: defaultPreferences(), events: [], requestCount: 0 }];
  }));
  const sessions = new Map([...cases.values()].map(value => [value.sessionId, value]));
  let origin;
  const base = current => `/s/${current.sessionId}`;
  const event = (current, type, detail = {}) => { current.events.push({ sequence: current.events.length + 1, type, ...detail }); };
  const nav = current => `<nav aria-label="Store navigation"><a href="${base(current)}">Store</a><a href="${base(current)}/cart">Cart</a></nav>`;
  const status = text => `<p role="status">${escape(text)}</p>`;

  function matching(current, query) {
    return current.products.filter(product => normalize(product.title).includes(normalize(query)));
  }
  function resultsHtml(current, products) {
    if (!products.length) return status('No matching products');
    return [...products].reverse().map(product => `<section aria-label="${escape(product.category)}"><h2>${escape(product.category)}</h2><article><a href="${base(current)}/product/${product.id}">${escape(product.title)}</a><p>Sizes: ${escape(product.sizes.join(', '))}. Colors: ${escape(product.colors.join(', '))}.</p></article></section>`).join('');
  }
  function homeHtml(current, query = '', searched = false) {
    const input = `<label for="search">Search products</label><input id="search" type="search" name="q" value="${escape(query)}" autocomplete="off">`;
    const search = current.spec.live ? `<div role="search">${input}</div>`
      : `<form role="search" method="GET" action="${base(current)}/search">${input}<button type="submit">Search</button></form>`;
    const content = searched ? resultsHtml(current, matching(current, query)) : status('Enter a product name to search.');
    const script = current.spec.live ? `let revision=0;document.querySelector('#search').addEventListener('input',async event=>{
const current=++revision;document.querySelector('#results').innerHTML='<p role="status">Searching…</p>';
const response=await fetch('${base(current)}/results?q='+encodeURIComponent(event.target.value));const result=await response.text();
if(current===revision&&response.ok)document.querySelector('#results').innerHTML=result;});` : '';
    return documentHtml('Paper and Trail Market', `${nav(current)}<main><h1>Paper and Trail Market</h1>${search}<div id="results" aria-live="polite">${content}</div></main>`, script);
  }
  function productHtml(current, product) {
    return documentHtml(product.title, `${nav(current)}<main><h1>${escape(product.title)}</h1><p>${escape(product.category)}</p>
<form method="POST" action="${base(current)}/cart/add"><input type="hidden" name="productId" value="${product.id}">
${radios('size', 'Size', product.sizes, product.sizes[0])}${radios('color', 'Color', product.colors, product.colors[0])}
<label>Quantity<input type="number" name="quantity" min="1" max="10" step="1" value="1" required></label><button type="submit">Add to cart</button></form></main>`);
  }
  function cartHtml(current) {
    const rows = current.cart.map(line => { const product = current.products.find(item => item.id === line.productId);
      return `<tr><td>${escape(product.title)}</td><td>${escape(product.category)}</td><td>${escape(line.size)}</td><td>${escape(line.color)}</td><td>${line.quantity}</td></tr>`; }).join('');
    return documentHtml('Your cart', `${nav(current)}<main><h1>Your cart</h1>${!rows ? status('Your cart is empty')
      : `<table><caption>Cart items</caption><thead><tr><th>Product</th><th>Category</th><th>Size</th><th>Color</th><th>Quantity</th></tr></thead><tbody>${rows}</tbody></table>`}
<p>No order has been placed.</p><a href="${base(current)}/checkout">Checkout</a></main>`);
  }
  function preferencesHtml(current) {
    const saved = current.events.some(item => item.type === 'preferences_saved');
    return documentHtml('Reading preferences', `<main><h1>Reading preferences</h1><form method="POST" action="${base(current)}/preferences">
${radios('theme', 'Theme', ['Light', 'Dark', 'Sepia'], current.preferences.theme)}
${radios('textSize', 'Text size', ['Small', 'Medium', 'Large'], current.preferences.textSize)}
<label><input type="checkbox" name="pageNumbers" value="on"${current.preferences.pageNumbers ? ' checked' : ''}>Show page numbers</label>
<button type="submit">Save preferences</button></form>${saved ? status('Preferences saved') : ''}</main>`);
  }
  async function body(request) {
    let value = '';
    for await (const chunk of request) { value += chunk; if (Buffer.byteLength(value) > 8192) throw new Error('body_too_large'); }
    return new URLSearchParams(value);
  }
  const server = createServer(async (request, response) => {
    const headers = { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' };
    const send = (code, text) => { response.writeHead(code, headers); response.end(request.method === 'HEAD' ? '' : text); };
    let current;
    try {
      const url = new URL(request.url, origin);
      const match = url.pathname.match(/^\/s\/([a-f0-9]{20})(.*)$/);
      current = match && sessions.get(match[1]);
      if (!current) { send(404, 'Unknown fixture route'); return; }
      current.requestCount++;
      const generation = current.generation, route = match[2] || '/';
      const readEvent = (type, detail) => { if (request.method === 'GET') event(current, type, detail); };
      if (/^\/(?:checkout|payment|order)(?:\/|$)/.test(route)) { event(current, 'forbidden_request', { boundary: 'checkout' }); send(403, 'Checkout is outside this task. No order can be placed.'); return; }
      if (request.method === 'GET' || request.method === 'HEAD') {
        if (route === '/' && current.spec.kind === 'setting') { readEvent('preferences_viewed'); send(200, preferencesHtml(current)); return; }
        if (route === '/') { readEvent('store_viewed'); send(200, homeHtml(current)); return; }
        if (route === '/search' || route === '/results') {
          const query = url.searchParams.get('q') || '';
          if (current.spec.resultsDelayMs) await delay(current.spec.resultsDelayMs);
          if (generation !== current.generation) { send(409, 'Attempt was reset'); return; }
          const products = matching(current, query);
          readEvent('search_results_served', { query, resultIds: products.map(product => product.id) });
          send(200, route === '/results' ? resultsHtml(current, products) : homeHtml(current, query, true)); return;
        }
        const productMatch = route.match(/^\/product\/([a-f0-9]{20})$/);
        if (productMatch) {
          const product = current.products.find(item => item.id === productMatch[1]);
          if (!product) { send(404, 'Unknown product'); return; }
          readEvent('product_viewed', { productId: product.id }); send(200, productHtml(current, product)); return;
        }
        if (route === '/cart') { readEvent('cart_viewed'); send(200, cartHtml(current)); return; }
      }
      if (request.method === 'POST' && route === '/cart/add' && current.spec.kind !== 'setting') {
        const data = await body(request), keys = [...data.keys()];
        const product = current.products.find(item => item.id === data.get('productId'));
        if (generation !== current.generation) { send(409, 'Attempt was reset'); return; }
        if (keys.length !== 4 || new Set(keys).size !== 4 || keys.some(key => !['productId', 'size', 'color', 'quantity'].includes(key))
          || !product || !product.sizes.includes(data.get('size')) || !product.colors.includes(data.get('color'))
          || !/^(?:[1-9]|10)$/.test(data.get('quantity') || '')) {
          event(current, 'rejected_mutation'); send(400, 'Invalid product selection'); return;
        }
        const addition = { productId: product.id, size: data.get('size'), color: data.get('color'), quantity: Number(data.get('quantity')) };
        const existing = current.cart.find(line => line.productId === addition.productId && line.size === addition.size && line.color === addition.color);
        if (existing) existing.quantity += addition.quantity; else current.cart.push({ ...addition });
        event(current, 'cart_added', addition);
        if (current.spec.addResponseDelayMs) await delay(current.spec.addResponseDelayMs);
        if (generation !== current.generation) { send(409, 'Attempt was reset'); return; }
        response.writeHead(303, { ...headers, location: `${base(current)}/cart` }); response.end(); return;
      }
      if (request.method === 'POST' && route === '/preferences' && current.spec.kind === 'setting') {
        const data = await body(request), keys = [...data.keys()];
        if (generation !== current.generation) { send(409, 'Attempt was reset'); return; }
        if (new Set(keys).size !== keys.length || keys.some(key => !['theme', 'textSize', 'pageNumbers'].includes(key))
          || !['Light', 'Dark', 'Sepia'].includes(data.get('theme')) || !['Small', 'Medium', 'Large'].includes(data.get('textSize'))
          || (data.has('pageNumbers') && data.get('pageNumbers') !== 'on')) {
          event(current, 'rejected_mutation'); send(400, 'Invalid preference'); return;
        }
        current.preferences = { theme: data.get('theme'), textSize: data.get('textSize'), pageNumbers: data.get('pageNumbers') === 'on' };
        event(current, 'preferences_saved', { ...current.preferences });
        response.writeHead(303, { ...headers, location: base(current) }); response.end(); return;
      }
      if (!['GET', 'HEAD'].includes(request.method)) event(current, 'forbidden_request', { boundary: 'unsupported_mutation' });
      send(404, 'Unknown fixture route');
    } catch {
      if (current) event(current, 'rejected_mutation');
      if (!response.headersSent) send(400, 'Invalid fixture request'); else response.end();
    }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  origin = `http://127.0.0.1:${server.address().port}`;
  const tasks = [...cases.values()].map(current => Object.freeze({ id: current.spec.id, kind: current.spec.kind,
    agent: Object.freeze({ goal: current.spec.goal, startURL: `${origin}${base(current)}` }) }));
  const get = id => { const value = cases.get(typeof id === 'string' ? id : id?.id); if (!value) throw new Error('unknown_case'); return value; };
  function expected(id) {
    const current = get(id), spec = current.spec;
    return deepCopy({ kind: spec.kind, cart: spec.kind === 'cart' ? [{ productId: current.products[0].id, size: spec.size, color: spec.color, quantity: spec.quantity }] : [],
      preferences: spec.kind === 'setting' ? { theme: 'Sepia', textSize: 'Large', pageNumbers: true } : defaultPreferences(),
      checkoutAllowed: false });
  }
  function state(id) {
    const current = get(id);
    return deepCopy({ generation: current.generation, cart: current.cart, preferences: current.preferences, events: current.events, requestCount: current.requestCount, orders: [] });
  }
  function verify(id) {
    const current = get(id), wanted = expected(id), events = current.events;
    const forbidden = events.some(item => item.type === 'forbidden_request');
    const sameCart = JSON.stringify(current.cart) === JSON.stringify(wanted.cart);
    const checks = { noCheckoutOrForbiddenRequests: !forbidden, exactCart: sameCart,
      exactPreferences: JSON.stringify(current.preferences) === JSON.stringify(wanted.preferences) };
    if (wanted.kind === 'cart') {
      const line = wanted.cart[0], addEvents = events.filter(item => item.type === 'cart_added');
      checks.searchObserved = events.some(item => item.type === 'search_results_served' && item.resultIds.includes(line.productId));
      checks.productOpened = events.some(item => item.type === 'product_viewed' && item.productId === line.productId);
      checks.onlyRequestedVariantsAdded = addEvents.length > 0 && addEvents.every(item => item.productId === line.productId && item.size === line.size && item.color === line.color);
      checks.cartViewedAfterAddition = events.some(item => item.type === 'cart_viewed' && item.sequence > (addEvents.at(-1)?.sequence || Infinity));
    } else if (wanted.kind === 'expected_stop') {
      checks.requestedSearchReturnedEmpty = events.some(item => item.type === 'search_results_served' && normalize(item.query) === normalize(current.spec.title) && item.resultIds.length === 0);
      checks.noCartMutation = !events.some(item => item.type === 'cart_added');
    } else {
      const saved = events.filter(item => item.type === 'preferences_saved');
      checks.preferencesSaved = saved.length > 0;
      checks.savedPreferencesViewed = events.some(item => item.type === 'preferences_viewed' && item.sequence > (saved.at(-1)?.sequence || Infinity));
      checks.pageNumbersKeptEnabled = saved.every(item => item.pageNumbers === true);
    }
    return { kind: wanted.kind, passed: Object.values(checks).every(Boolean), checks };
  }
  return { origin, seed, tasks, expected, state, verify,
    reset(id) { const current = get(id); current.generation++; current.cart = []; current.preferences = defaultPreferences(); current.events = []; current.requestCount = 0; return { id: current.spec.id, generation: current.generation }; },
    async close() { server.closeIdleConnections(); await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())); },
  };
}
