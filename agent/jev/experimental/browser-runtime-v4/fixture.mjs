import { createServer } from 'node:http';
import { createHash } from 'node:crypto';

const escape = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
const normalize = value => String(value || '').normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase();
const token = value => createHash('sha256').update(value).digest('hex').slice(0, 20);
const freezePlan = steps => Object.freeze({ steps: Object.freeze(steps.map(step => Object.freeze(step))) });

function html(title, body, script = '') {
  return `<!doctype html><html lang="en"><meta charset="utf-8"><title>${escape(title)}</title>
<style>body{font:18px system-ui;margin:32px;max-width:900px}input,button{font:inherit;padding:8px;margin:8px}section{margin:20px 0;padding:16px;border:1px solid #aaa}a{display:inline-block;padding:12px}[hidden]{display:none!important}</style>
${body}${script ? `<script>${script}</script>` : ''}</html>`;
}

function searchForm(action, query, label) {
  return `<form role="search" method="GET" action="${escape(action)}"><label>${escape(label)}<input type="search" name="q" value="${escape(query)}" autocomplete="off"></label><button type="submit">Search</button></form>`;
}

// Public tasks/plans contain semantic goals only. Seeded route identities and
// correct merchant/item membership stay inside the fixture verifier closure.
export async function createFixtureServer({ seed = 20260917 } = {}) {
  if (!Number.isSafeInteger(seed)) throw new Error('invalid_fixture_seed');
  const definitions = new Map([
    { id: 'merchant-then-item', merchant: 'Paper Harbor', item: 'Copper Finch Notebook', district: 'Reference district' },
    { id: 'contextual-merchant', merchant: 'Paper Harbor', item: 'Moss Trail Sketchbook', district: 'Studio district', duplicate: true },
    { id: 'direct-link-delayed-heading', merchant: 'Cedar Workshop', item: 'Harbor Grid Planner', district: 'Studio district', duplicate: true, direct: true, delayed: true },
  ].map(definition => {
    const def = { ...definition, requests: 0, generation: 0 };
    def.shops = [
      { id: token(`${seed}:${def.id}:correct-shop`), name: def.merchant, district: def.district, correct: true },
      { id: token(`${seed}:${def.id}:other-shop`), name: def.duplicate ? def.merchant : 'Willow Stationery', district: 'Travel district', correct: false },
    ];
    for (const shop of def.shops) {
      // Wrong duplicate shops also contain the same visible item title. A title
      // alone therefore cannot satisfy the final independent verifier.
      shop.items = [
        { id: token(`${seed}:${def.id}:${shop.correct ? 'correct' : 'wrong'}:requested-item`), title: def.item },
        { id: token(`${seed}:${def.id}:${shop.correct ? 'correct' : 'wrong'}:other-item`), title: 'Linen Pocket Notes' },
      ];
    }
    const context = def.duplicate ? { context: 'the shop for creative studio work' } : {};
    const first = def.direct ? { operation: 'open_link', targetText: def.merchant, ...context }
      : { operation: 'search_and_open', query: def.merchant, targetText: def.merchant, ...context };
    def.publicPlan = freezePlan([first, { operation: 'search_and_open', query: def.item, targetText: def.item }]);
    def.goal = `${def.direct ? 'Open' : 'Search for and open'} "${def.merchant}"${def.duplicate ? ' in the district for creative studio work' : ''}, then search within that shop for "${def.item}" and open its details.`;
    return [def.id, def];
  }));
  const shops = new Map([...definitions.values()].flatMap(def => def.shops.map(shop => [shop.id, { def, shop }])));
  const entries = new Map([...definitions.values()].flatMap(def => def.shops.flatMap(shop => shop.items.map(item => [item.id, { def, shop, item }]))));
  let origin;

  function merchantLinks(def, query) {
    const candidates = [...def.shops].reverse().filter(shop => normalize(shop.name).includes(normalize(query)));
    if (!candidates.length) return '<p role="status">No matching items</p>';
    return candidates.map(shop => `<section aria-label="${escape(shop.district)}"><h2>${escape(shop.district)}</h2><a href="/shop/${shop.id}">${escape(shop.name)}</a></section>`).join('');
  }
  function shopPage(def, shop, query, searched) {
    const matches = searched ? shop.items.filter(item => normalize(item.title).includes(normalize(query))) : [];
    const results = !searched ? '<p role="status">Search this shop for a title.</p>' : !matches.length ? '<p role="status">No matching items</p>'
      : `<section aria-label="Paper collection"><h2>Paper collection</h2>${matches.map(item => `<article><a href="/entry/${item.id}">${escape(item.title)}</a><p>Catalogue details</p></article>`).join('')}</section>`;
    return html(shop.name, `<main><h1>${escape(shop.name)}</h1><p data-field="district">${escape(shop.district)}</p>
${searchForm(`/shop/${shop.id}/search`, query, 'Search this shop')}${results}</main>`);
  }
  const server = createServer((request, response) => {
    const headers = { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' };
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method)) { response.writeHead(405, headers); response.end('Read-only fixture'); return; }
    if (request.method === 'OPTIONS') { response.writeHead(204, headers); response.end(); return; }
    const url = new URL(request.url, origin);
    const landing = url.pathname.match(/^\/cases\/([a-z-]+)(\/search)?$/);
    const shopMatch = url.pathname.match(/^\/shop\/([a-f0-9]{20})(\/search)?$/);
    const entryMatch = url.pathname.match(/^\/entry\/([a-f0-9]{20})$/);
    let document;
    if (landing && definitions.has(landing[1])) {
      const def = definitions.get(landing[1]); def.requests++;
      const query = url.searchParams.get('q') || '';
      const shown = def.direct || landing[2];
      document = html('Independent Paper Market', `<main><h1>Independent Paper Market</h1>
${def.direct ? '<p>Choose a shop to browse its catalogue.</p>' : searchForm(`/cases/${def.id}/search`, query, 'Search shops')}
${shown ? merchantLinks(def, query) : '<p role="status">Search for a shop.</p>'}</main>`);
    } else if (shopMatch && shops.has(shopMatch[1])) {
      const { def, shop } = shops.get(shopMatch[1]); def.requests++;
      document = shopPage(def, shop, url.searchParams.get('q') || '', Boolean(shopMatch[2]));
    } else if (entryMatch && entries.has(entryMatch[1])) {
      const { def, shop, item } = entries.get(entryMatch[1]); def.requests++;
      document = html(def.delayed ? 'Loading catalogue entry' : item.title,
        `<main><h1${def.delayed ? ' hidden' : ''}>${escape(item.title)}</h1><p data-field="merchant">${escape(shop.name)}</p><p data-field="district">${escape(shop.district)}</p><p>A neutral stationery catalogue entry.</p></main>`,
        def.delayed ? `setTimeout(()=>{document.querySelector('h1').hidden=false;document.title=${JSON.stringify(item.title)}},650);` : '');
    } else { response.writeHead(404, headers); response.end('Unknown fixture route'); return; }
    response.writeHead(200, headers); response.end(request.method === 'HEAD' ? '' : document);
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  origin = `http://127.0.0.1:${server.address().port}`;
  const cases = [...definitions.values()].map(def => Object.freeze({ id: def.id, expectation: 'complete',
    startUrl: `${origin}/cases/${def.id}`, goal: def.goal, publicPlan: def.publicPlan }));

  async function verify(page, descriptor) {
    const def = definitions.get(descriptor?.id);
    if (!def) throw new Error('unknown_fixture_case');
    const expectedShop = def.shops.find(shop => shop.correct);
    const expectedItem = expectedShop.items[0];
    const url = new URL(page.url());
    const rendered = await page.evaluate(() => {
      const visible = element => Boolean(element.getClientRects().length) && getComputedStyle(element).display !== 'none'
        && getComputedStyle(element).visibility !== 'hidden';
      const texts = selector => [...document.querySelectorAll(selector)].filter(visible).map(element => element.innerText.trim());
      return { headings: texts('main h1'), merchants: texts('main [data-field="merchant"]'), districts: texts('main [data-field="district"]') };
    });
    const checks = { localOrigin: url.origin === origin,
      exactDetailRoute: url.pathname === `/entry/${expectedItem.id}` && !url.search && !url.hash,
      visibleExactTitle: rendered.headings.some(title => normalize(title) === normalize(expectedItem.title)),
      correctMerchant: rendered.merchants.some(name => normalize(name) === normalize(expectedShop.name)),
      correctDistrict: rendered.districts.some(name => normalize(name) === normalize(expectedShop.district)) };
    return { expectation: 'complete', passed: Object.values(checks).every(Boolean), checks };
  }
  return { origin, seed, cases, verify,
    reset(caseId) {
      const def = definitions.get(caseId); if (!def) throw new Error('unknown_fixture_case');
      def.requests = 0; def.generation++; return { caseId, generation: def.generation };
    },
    requestCount(caseId) { return definitions.get(caseId)?.requests || 0; },
    async close() { server.closeIdleConnections(); await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())); },
  };
}
