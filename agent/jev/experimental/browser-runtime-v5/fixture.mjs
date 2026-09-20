// Stateful local fixture for the stepwise runtime. Pages are served per-run
// under /s/{run}/...; bag contents and form submissions live server-side, so
// the verifier checks real end state independently of the page or the model.
// Goal texts, done-when clauses and supplied values are public; expected
// outcomes stay in this file's closures.
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';

const escape = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
const normalize = value => String(value || '').normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase();
const token = value => createHash('sha256').update(value).digest('hex').slice(0, 16);

function html(title, body, script = '') {
  return `<!doctype html><html lang="en"><meta charset="utf-8"><title>${escape(title)}</title>
<style>body{font:18px system-ui;margin:32px;max-width:960px}input,button,select{font:inherit;padding:8px;margin:8px}
article,section{margin:14px 0;padding:14px;border:1px solid #aaa}a{display:inline-block;padding:10px}
.grid{display:grid;grid-template-columns:repeat(4,1fr);gap:10px}[hidden]{display:none!important}
dialog,[role=dialog]{position:fixed;inset:20%;background:#fff;border:2px solid #333;padding:24px;z-index:9}</style>
${body}${script ? `<script>${script}</script>` : ''}</html>`;
}
function searchForm(action, query, label) {
  return `<form role="search" method="GET" action="${escape(action)}"><label>${escape(label)}<input type="search" name="q" value="${escape(query)}" autocomplete="off"></label><button type="submit">Search</button></form>`;
}

export async function createFixtureServer({ seed = 20260920 } = {}) {
  if (!Number.isSafeInteger(seed)) throw new Error('invalid_fixture_seed');
  const runs = new Map();
  let origin;

  // ---- domain definitions -------------------------------------------------
  const shops = [
    { id: token(`${seed}:shop:paper`), name: 'Paper Harbor', district: 'Reference district', correct: true },
    { id: token(`${seed}:shop:willow`), name: 'Paper Harbor', district: 'Travel district', correct: false },
  ];
  const items = {
    [shops[0].id]: [
      { id: token(`${seed}:item:notebook`), title: 'Copper Finch Notebook' },
      { id: token(`${seed}:item:linen`), title: 'Linen Pocket Notes' },
    ],
    [shops[1].id]: [
      { id: token(`${seed}:item:sketch`), title: 'Moss Trail Sketchbook' },
      { id: token(`${seed}:item:linen2`), title: 'Linen Pocket Notes' },
    ],
  };
  const catalog = [
    { id: token(`${seed}:prod:kw22`), name: 'KALLAX white 2x2', price: 29 },
    { id: token(`${seed}:prod:kb22`), name: 'KALLAX black-brown 2x2', price: 29 },
    { id: token(`${seed}:prod:kw24`), name: 'KALLAX white 2x4', price: 49 },
    { id: token(`${seed}:prod:kw14`), name: 'KALLAX white 1x4', price: 39 },
    { id: token(`${seed}:prod:billy`), name: 'BILLY birch bookcase', price: 59 },
    { id: token(`${seed}:prod:linmon`), name: 'LINNMON table', price: 25 },
    { id: token(`${seed}:prod:pencil`), name: 'HB pencil pack', price: 3 },
    { id: token(`${seed}:prod:eraser`), name: 'Dust-free eraser', price: 2 },
    { id: token(`${seed}:prod:ruler`), name: 'Steel ruler 30cm', price: 4 },
    { id: token(`${seed}:prod:tape`), name: 'Masking tape', price: 6 },
    { id: token(`${seed}:prod:glue`), name: 'Craft glue', price: 5 },
    { id: token(`${seed}:prod:clips`), name: 'Binder clips x12', price: 4 },
    { id: token(`${seed}:prod:folder`), name: 'Kraft folder', price: 7 },
    { id: token(`${seed}:prod:stapler`), name: 'Desk stapler', price: 12 },
    { id: token(`${seed}:prod:lamp`), name: 'Reading lamp', price: 35 },
    { id: token(`${seed}:prod:chair`), name: 'Swivel chair', price: 89 },
  ];
  const cheapestTwo = [...catalog].sort((a, b) => a.price - b.price).slice(0, 2).map(item => item.id);

  // ---- page renderers -----------------------------------------------------
  function consentDialog() {
    return `<div role="dialog" aria-label="Cookie consent"><p>This shop uses cookies for the demo.</p><button type="button" onclick="this.closest('[role=dialog]').hidden=true">Accept cookies</button></div>`;
  }
  function landing(run) {
    return html('Independent Paper Market', `<main><h1>Independent Paper Market</h1>
${searchForm(`/s/${run}/shops/search`, '', 'Search shops')}
<p role="status">Search for a shop to browse its catalogue.</p></main>`);
  }
  function shopResults(run, query) {
    const matches = shops.filter(shop => normalize(shop.name).includes(normalize(query)));
    return html('Shop results', `<main><h1>Shop results</h1>
${searchForm(`/s/${run}/shops/search`, query, 'Search shops')}
${matches.length ? matches.map(shop => `<section aria-label="${escape(shop.district)}"><h2>${escape(shop.district)}</h2><a href="/s/${run}/shop/${shop.id}">${escape(shop.name)}</a></section>`).join('')
      : '<p role="status">No matching items</p>'}</main>`);
  }
  function shopPage(run, shop, query, searched) {
    const matches = searched ? (items[shop.id] || []).filter(item => normalize(item.title).includes(normalize(query))) : [];
    return html(shop.name, `<main><h1>${escape(shop.name)}</h1><p data-field="district">${escape(shop.district)}</p>
${searchForm(`/s/${run}/shop/${shop.id}/search`, query, 'Search this shop')}
${!searched ? '<p role="status">Search this shop for a title.</p>'
      : !matches.length ? '<p role="status">No matching items</p>'
      : `<section aria-label="Paper collection"><h2>Paper collection</h2>${matches.map(item => `<article><a href="/s/${run}/entry/${item.id}">${escape(item.title)}</a><p>Catalogue details</p></article>`).join('')}</section>`}</main>`);
  }
  function entryPage(run, shop, item) {
    return html(item.title, `<main><h1>${escape(item.title)}</h1><p data-field="merchant">${escape(shop.name)}</p>
<p data-field="district">${escape(shop.district)}</p><p>A neutral stationery catalogue entry.</p></main>`);
  }
  function listing(run, added) {
    const state = runs.get(run);
    return html('Stationery listing', `${consentDialog()}<main><h1>Stationery listing</h1>
<nav><a href="/s/${run}/bag">View bag (${state.bag.size})</a></nav>
${added ? `<p role="status">Added to bag.</p>` : ''}
<div class="grid">${catalog.map(item => `<article aria-label="${escape(item.name)}"><h3>${escape(item.name)}</h3><p>${item.price} PLN</p><a href="/s/${run}/add/${item.id}">Add to bag</a></article>`).join('')}</div></main>`);
  }
  function bagPage(run) {
    const state = runs.get(run);
    const rows = [...state.bag].map(id => catalog.find(item => item.id === id)).filter(Boolean);
    return html('Your bag', `<main><h1>Your bag</h1>
${rows.length ? `<section aria-label="Bag contents">${rows.map(item => `<article aria-label="${escape(item.name)}"><h3>${escape(item.name)}</h3><p>${item.price} PLN</p></article>`).join('')}</section>`
      : '<p role="status">Your bag is empty.</p>'}
<p><a href="/s/${run}/review">Continue to review</a></p>
<p><a href="/s/${run}/listing">Back to listing</a></p></main>`);
  }
  function reviewPage(run) {
    return html('Delivery details', `<main><h1>Delivery details</h1>
<form method="GET" action="/s/${run}/confirm">
<label>Full name<input type="text" name="fullname" autocomplete="off"></label>
<label>Street address<input type="text" name="street" autocomplete="off"></label>
<label>City<input type="text" name="town" autocomplete="off"></label>
<label>Shipping<select name="shipping"><option value="">Choose…</option><option value="standard">Standard courier</option><option value="express">Express courier</option></select></label>
<button type="submit">Save and review</button></form></main>`);
  }
  function confirmPage(params) {
    return html('Review order', `<main><h1>Review order</h1>
<section aria-label="Delivery"><p data-field="fullname">${escape(params.get('fullname') || '')}</p>
<p data-field="street">${escape(params.get('street') || '')}</p><p data-field="town">${escape(params.get('town') || '')}</p>
<p data-field="shipping">${escape(params.get('shipping') || '')}</p></section>
<p><button type="button">Pay now</button></p></main>`);
  }

  // ---- routes ---------------------------------------------------------------
  const server = createServer((request, response) => {
    const headers = { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' };
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method)) { response.writeHead(405, headers); response.end('Read-only fixture'); return; }
    if (request.method === 'OPTIONS') { response.writeHead(204, headers); response.end(); return; }
    const url = new URL(request.url, origin);
    const m = url.pathname.match(/^\/s\/(run-[a-z0-9]+)\/(.*)$/);
    if (!m || !runs.has(m[1])) { response.writeHead(404, headers); response.end('Unknown run'); return; }
    const [, run, rest] = m;
    const state = runs.get(run); state.requests++;
    const shopMatch = rest.match(/^shop\/([a-f0-9]{16})(\/search)?$/);
    const entryMatch = rest.match(/^entry\/([a-f0-9]{16})$/);
    const addMatch = rest.match(/^add\/([a-f0-9]{16})$/);
    let document;
    if (rest === 'home') document = landing(run);
    else if (rest === 'shops/search') document = shopResults(run, url.searchParams.get('q') || '');
    else if (shopMatch && shops.some(s => s.id === shopMatch[1])) {
      const shop = shops.find(s => s.id === shopMatch[1]);
      document = shopPage(run, shop, url.searchParams.get('q') || '', Boolean(shopMatch[2]));
    } else if (entryMatch) {
      const found = Object.entries(items).flatMap(([shopId, list]) => list.map(item => ({ shopId, item }))).find(row => row.item.id === entryMatch[1]);
      if (!found) { response.writeHead(404, headers); response.end('Unknown entry'); return; }
      const shop = shops.find(s => s.id === found.shopId);
      state.lastEntry = found.item.id; state.lastEntryShop = found.shopId;
      document = entryPage(run, shop, found.item);
    } else if (rest === 'listing') document = listing(run, url.searchParams.get('added'));
    else if (addMatch && catalog.some(item => item.id === addMatch[1])) {
      state.bag.add(addMatch[1]);
      response.writeHead(302, { ...headers, location: `/s/${run}/listing?added=${addMatch[1]}` });
      response.end(); return;
    } else if (rest === 'bag') document = bagPage(run);
    else if (rest === 'review') document = reviewPage(run);
    else if (rest === 'confirm') {
      state.submission = { fullname: url.searchParams.get('fullname') || '', street: url.searchParams.get('street') || '',
        town: url.searchParams.get('town') || '', shipping: url.searchParams.get('shipping') || '' };
      document = confirmPage(url.searchParams);
    } else { response.writeHead(404, headers); response.end('Unknown fixture route'); return; }
    response.writeHead(200, headers); response.end(request.method === 'HEAD' ? '' : document);
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  origin = `http://127.0.0.1:${server.address().port}`;

  // ---- cases ---------------------------------------------------------------
  const consentDismiss = { name: 'consent_dismiss',
    when: data => data.dialogOpen,
    act: async ({ session, snapshot }) => {
      const accept = snapshot.data.controls.find(c => /accept/i.test(c.what));
      if (!accept) return false;
      await session.execute(snapshot, { ref: `s${snapshot.id}:e${accept.nodeIndex}` }, 'click', '', 3000);
      return true;
    } };
  // Deterministic comparative-selection tool: ranks the observed card
  // excerpts by price in code. Global ranking is a structured-data problem,
  // not a model pick (the sightkick "cheapest_flight" pattern).
  const cheapestAdds = () => {
    const clicked = new Set();
    return { name: 'cheapest_adds',
      when: data => data.controls.some(c => /view bag \(\d+\)/i.test(c.what))
        && data.controls.some(c => /add to bag/i.test(c.what) && c.component?.text),
      act: async ({ session, snapshot }) => {
        const bag = snapshot.data.controls.find(c => /view bag \((\d+)\)/i.test(c.what));
        const count = Number(bag?.what.match(/\((\d+)\)/)?.[1] || 0);
        const target = count >= 2 ? bag
          : snapshot.data.controls
            .filter(c => /add to bag/i.test(c.what) && c.component?.text && !clicked.has(c.href))
            .map(c => ({ c, price: Number(c.component.text.match(/(\d+)\s*pln/i)?.[1] || Infinity) }))
            .sort((a, b) => a.price - b.price)[0]?.c;
        if (!target) return false;
        clicked.add(target.href || target.nodeIndex);
        await session.execute(snapshot, { ref: `s${snapshot.id}:e${target.nodeIndex}` }, 'click', '', 3000);
        return true;
      } };
  };
  const cases = [
    { id: 'merchant-item',
      goal: 'Search for and open the shop "Paper Harbor" listed in the Reference district, then search within that shop for "Copper Finch Notebook" and open its details.',
      doneWhen: ['heading=Copper Finch Notebook'],
      values: { shop_query: { text: 'Paper Harbor', reveal: true }, item_query: { text: 'Copper Finch Notebook', reveal: true } },
      verify(runId) {
        const run = runs.get(runId);
        return { expectation: 'complete', passed: run.lastEntry === items[shops[0].id][0].id && run.lastEntryShop === shops[0].id,
          detail: { lastEntry: run.lastEntry, lastEntryShop: run.lastEntryShop } };
      } },
    { id: 'variant-bag',
      goal: 'Put the "KALLAX white 2x2" in the shopping bag, then open the bag.',
      doneWhen: ['url=/bag', 'text_count=1:KALLAX white 2x2'],
      handlers: [consentDismiss],
      verify(runId) {
        const run = runs.get(runId);
        const wanted = token(`${seed}:prod:kw22`);
        return { expectation: 'complete', passed: run.bag.size === 1 && run.bag.has(wanted),
          detail: { bag: [...run.bag], wanted } };
      } },
    { id: 'two-cheapest',
      goal: 'Put the two cheapest stationery items in the shopping bag, then open the bag.',
      doneWhen: ['url=/bag'],
      handlers: () => [consentDismiss, cheapestAdds()],
      verify(runId) {
        const run = runs.get(runId);
        return { expectation: 'complete', passed: run.bag.size === 2 && cheapestTwo.every(id => run.bag.has(id)),
          detail: { bag: [...run.bag], wanted: cheapestTwo } };
      } },
    { id: 'delivery-form',
      goal: 'Fill the delivery form with your details (full name "Ada Byron", street address "12 Analytical Lane", city "Warsaw"), choose standard shipping, and continue to the review.',
      doneWhen: ['heading=Review order'],
      values: { fullname: { text: 'Ada Byron', reveal: true }, street: { text: '12 Analytical Lane', reveal: true }, town: { text: 'Warsaw', reveal: true } },
      verify(runId) {
        const run = runs.get(runId);
        const s = run.submission || {};
        return { expectation: 'complete',
          passed: normalize(s.fullname) === normalize('Ada Byron') && normalize(s.street) === normalize('12 Analytical Lane')
            && normalize(s.town) === normalize('Warsaw') && s.shipping === 'standard',
          detail: { submission: s } };
      } },
  ];

  function startRun(caseId) {
    const descriptor = cases.find(c => c.id === caseId);
    if (!descriptor) throw new Error('unknown_fixture_case');
    const runId = `run-${token(`${seed}:${caseId}:${Date.now()}:${Math.random()}`).slice(0, 10)}`;
    runs.set(runId, { caseId, bag: new Set(), submission: null, requests: 0, lastEntry: null, lastEntryShop: null });
    const start = { 'merchant-item': 'home', 'variant-bag': 'listing', 'two-cheapest': 'listing', 'delivery-form': 'review' }[caseId];
    const handlers = typeof descriptor.handlers === 'function' ? descriptor.handlers() : (descriptor.handlers || []);
    return { runId, startUrl: `${origin}/s/${runId}/${start}`, goal: descriptor.goal,
      doneWhen: descriptor.doneWhen, values: descriptor.values || {}, handlers };
  }

  return { origin, seed, cases: cases.map(c => ({ id: c.id, goal: c.goal, doneWhen: c.doneWhen })), startRun,
    verify(caseId, runId) {
      const descriptor = cases.find(c => c.id === caseId);
      if (!descriptor || !runs.has(runId)) return { passed: false, reason: 'unknown_run' };
      return descriptor.verify(runId);
    },
    requestCount(runId) { return runs.get(runId)?.requests || 0; },
    async close() { server.closeIdleConnections(); await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())); },
  };
}
