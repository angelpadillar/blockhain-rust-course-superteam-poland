import { createServer } from 'node:http';
import { createHash } from 'node:crypto';

const layouts = [
  ['enter-form', 'complete'], ['live-search', 'complete'], ['delayed-results', 'complete'],
  ['delayed-title', 'complete'], ['duplicate-labels', 'complete'], ['node-replacement', 'complete'],
  ['unrelated-animation', 'complete'], ['accessible-cards', 'complete'], ['semantic-context', 'complete'], ['empty-result', 'stop'],
];
const names = ['Copper Finch Notebook', 'Moss Trail Sketchbook', 'Harbor Grid Planner', 'Cedar Arc Journal'];
const escape = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
const normalize = value => String(value || '').normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase();
const tokenFor = value => createHash('sha256').update(value).digest('hex').slice(0, 20);

function documentHtml(title, body, script = '') {
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(title)}</title>
<style>body{font:18px system-ui;margin:32px;max-width:900px}form,label,input,button{font:inherit}input{margin:12px;padding:8px}button{padding:8px 16px}section{margin:24px 0;padding:16px;border:1px solid #aaa}a{display:inline-block;padding:12px}article{margin:12px 0}aside{height:28px;color:#888} [hidden]{display:none!important}</style>
${body}${script ? `<script>${script}</script>` : ''}</html>`;
}

// Ground truth remains in this server closure. The public case descriptor never
// contains detail routes, item IDs, verifier selectors or an expected answer.
export async function createFixtureServer({ seed = 20260917 } = {}) {
  if (!Number.isSafeInteger(seed)) throw new Error('invalid_fixture_seed');
  const definitions = new Map(layouts.map(([id, expectation], index) => {
    const targetText = names[index % names.length];
    const duplicated = ['duplicate-labels', 'semantic-context'].includes(id);
    const context = duplicated ? 'Studio shelf' : 'Reference shelf';
    const targetToken = tokenFor(`${seed}:${id}:target`);
    const items = [{ token: targetToken, title: targetText, context },
      ...names.filter(name => name !== targetText).map((title, i) => ({ token: tokenFor(`${seed}:${id}:other:${i}`), title, context: 'Reference shelf' }))];
    if (duplicated) items.unshift({ token: tokenFor(`${seed}:${id}:duplicate`), title: targetText, context: 'Travel shelf' });
    return [id, { id, expectation, targetText, targetToken, context, items,
      publicTask: { query: targetText.split(' ').slice(0, 2).join(' '), targetText,
        ...(duplicated ? { context: id === 'semantic-context' ? 'the shelf for creative studio work' : context } : {}) }, generation: 0, requests: 0 }];
  }));
  const byToken = new Map([...definitions.values()].flatMap(def => def.items.map(item => [item.token, { def, item }])));
  let origin;

  function resultsHtml(def, query) {
    const items = def.id === 'empty-result' ? [] : def.items.filter(item => normalize(item.title).includes(normalize(query)));
    if (!items.length) return '<p role="status">No matching items</p>';
    const grouped = new Map();
    for (const item of items) {
      if (!grouped.has(item.context)) grouped.set(item.context, []);
      grouped.get(item.context).push(item);
    }
    return [...grouped].map(([context, itemsInGroup]) => `<section aria-label="${escape(context)}"><h2>${escape(context)}</h2>`
      + (def.id === 'accessible-cards' ? '<ul>' : '')
      + itemsInGroup.map(item => def.id === 'accessible-cards'
        ? `<li><a href="/items/${item.token}">${escape(item.title)}</a></li>`
        : `<article><a href="/items/${item.token}">${escape(item.title)}</a><p>Open the catalogue entry.</p></article>`).join('')
      + (def.id === 'accessible-cards' ? '</ul>' : '') + '</section>').join('');
  }

  function catalogueHtml(def, query, submitted) {
    const form = ['enter-form', 'accessible-cards'].includes(def.id);
    const textField = def.id === 'accessible-cards';
    const input = `<label for="catalogue-search">Search catalogue</label><input id="catalogue-search" ${textField ? 'type="text" role="searchbox"' : 'type="search"'} name="q" value="${escape(query)}" autocomplete="off">`;
    const search = form ? `<form role="search" method="GET" action="/cases/${def.id}/search">${input}<button type="submit">Search</button></form>` : `<div role="search">${input}</div>`;
    const initial = submitted ? resultsHtml(def, query) : '<p role="status">Enter a title to search.</p>';
    const liveScript = form ? '' : `
let queryVersion=0;
document.querySelector('#catalogue-search').addEventListener('input', async event => {
  const version=++queryVersion, query=event.target.value;
  document.querySelector('#search-status').textContent='Searching…';
  const response=await fetch('/catalogue/${def.id}?q='+encodeURIComponent(query),{method:'GET'});
  const html=await response.text();
  if(version!==queryVersion)return;
  document.querySelector('#results').innerHTML=html;
  document.querySelector('#search-status').textContent='Search finished';
  ${def.id === 'node-replacement' ? `const old=document.querySelector('#results a');if(old){old.replaceWith(old.cloneNode(true));setTimeout(()=>{const a=document.querySelector('#results a');if(a)a.replaceWith(a.cloneNode(true))},90);}` : ''}
});`;
    const animation = def.id === 'unrelated-animation' ? `let frame=0;setInterval(()=>{document.querySelector('#decoration').textContent='Display update '+(++frame)},30);` : '';
    return documentHtml('Paper and Pencil Library', `<header><h1>Paper and Pencil Library</h1></header><main>${search}
<p id="search-status" role="status"></p><div id="results" aria-live="polite">${initial}</div></main>
${def.id === 'unrelated-animation' ? '<aside id="decoration" aria-hidden="true">Display update 0</aside>' : ''}`, liveScript + animation);
  }

  const server = createServer(async (request, response) => {
    const headers = { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' };
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method)) { response.writeHead(405, headers); response.end('Read-only fixture'); return; }
    if (request.method === 'OPTIONS') { response.writeHead(204, headers); response.end(); return; }
    const url = new URL(request.url, origin);
    const caseMatch = url.pathname.match(/^\/cases\/([a-z-]+)(\/search)?$/);
    const searchMatch = url.pathname.match(/^\/catalogue\/([a-z-]+)$/);
    const itemMatch = url.pathname.match(/^\/items\/([a-f0-9]{20})$/);
    let html;
    if (caseMatch && definitions.has(caseMatch[1])) {
      const def = definitions.get(caseMatch[1]); def.requests++;
      html = catalogueHtml(def, url.searchParams.get('q') || '', Boolean(caseMatch[2]));
    } else if (searchMatch && definitions.has(searchMatch[1])) {
      const def = definitions.get(searchMatch[1]); def.requests++;
      if (def.id === 'delayed-results') await new Promise(resolve => setTimeout(resolve, 650));
      html = resultsHtml(def, url.searchParams.get('q') || '');
    } else if (itemMatch && byToken.has(itemMatch[1])) {
      const { def, item } = byToken.get(itemMatch[1]); def.requests++;
      const delayed = def.id === 'delayed-title';
      html = documentHtml(delayed ? 'Loading catalogue entry' : item.title,
        `<main><h1${delayed ? ' hidden' : ''}>${escape(item.title)}</h1><p data-label="collection">${escape(item.context)}</p><p>A neutral paper catalogue entry.</p></main>`,
        delayed ? `setTimeout(()=>{document.querySelector('h1').hidden=false;document.title=${JSON.stringify(item.title)}},650);` : '');
    } else { response.writeHead(404, headers); response.end('Unknown fixture route'); return; }
    response.writeHead(200, headers); response.end(request.method === 'HEAD' ? '' : html);
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  origin = `http://127.0.0.1:${server.address().port}`;
  const cases = [...definitions.values()].map(def => Object.freeze({ id: def.id, expectation: def.expectation,
    startUrl: `${origin}/cases/${def.id}`, publicTask: Object.freeze({ ...def.publicTask }) }));

  async function verify(page, caseDescriptor) {
    const def = definitions.get(caseDescriptor?.id);
    if (!def) throw new Error('unknown_fixture_case');
    // The descriptor and runtime result are untrusted for verification; expected
    // values come from the closed fixture definition and rendered page evidence.
    const current = new URL(page.url());
    const rendered = await page.evaluate(() => {
      const visible = element => Boolean(element.getClientRects().length)
        && getComputedStyle(element).visibility !== 'hidden' && getComputedStyle(element).display !== 'none';
      return {
        headings: [...document.querySelectorAll('main h1')].filter(visible).map(element => element.innerText.trim()),
        collections: [...document.querySelectorAll('main [data-label="collection"]')].filter(visible).map(element => element.innerText.trim()),
        empty: [...document.querySelectorAll('[role="status"]')].filter(visible).some(element => element.innerText.trim() === 'No matching items'),
      };
    });
    if (def.expectation === 'stop') {
      const checks = { localOrigin: current.origin === origin, cataloguePage: current.pathname === `/cases/${def.id}`
        || current.pathname === `/cases/${def.id}/search`, visibleEmptyResult: rendered.empty === true,
      noDetailTitle: !rendered.headings.some(title => normalize(title) === normalize(def.targetText)) };
      return { expectation: 'stop', passed: Object.values(checks).every(Boolean), checks };
    }
    const checks = { localOrigin: current.origin === origin, exactDetailRoute: current.pathname === `/items/${def.targetToken}`
      && !current.search && !current.hash,
    visibleExactTitle: rendered.headings.some(title => normalize(title) === normalize(def.targetText)),
    exactCollection: rendered.collections.some(context => normalize(context) === normalize(def.context)) };
    return { expectation: 'complete', passed: Object.values(checks).every(Boolean), checks };
  }

  return { origin, seed, cases, verify,
    reset(caseId) {
      const def = definitions.get(caseId); if (!def) throw new Error('unknown_fixture_case');
      def.generation++; def.requests = 0;
      return { caseId, generation: def.generation };
    },
    requestCount(caseId) { return definitions.get(caseId)?.requests || 0; },
    async close() {
      server.closeIdleConnections();
      await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    },
  };
}
