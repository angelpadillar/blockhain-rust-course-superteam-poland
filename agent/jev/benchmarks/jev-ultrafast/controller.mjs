// Private benchmark controller. Launches the owned profile and independently checks actions/results.
import { chromium } from '/app/node_modules/playwright-core/index.mjs';
import { createServer } from 'node:http';
import { createServer as tcpServer, connect } from 'node:net';
import { readFile } from 'node:fs/promises';
import { loadSettings, normalize, assert } from '/app/src/config.mjs';
import { acquireProfileLock } from '/app/src/storage.mjs';
import { browserEnvironment } from '/app/src/glovo.mjs';
import { navigationUrl, navigationActions, navigationSelector, blocksNavigationMutation,
  readNavigationDom, verifyNavigation, repeatAuthorizedAgeConfirmation } from '/app/src/navigation.mjs';

const settings = await loadSettings();
const task = JSON.parse(await readFile('/app/cases/foczka-navigation.json', 'utf8'));
const release = await acquireProfileLock(settings.dataDir);
let context, server, proxy, blockedMutations = 0, ageConfirmations = 0;
const secrets = [settings.config.expectedAddress, settings.config.expectedAccountLabel,
  ...settings.config.privateValues].filter(Boolean);
const patterns = secrets.map(s => new RegExp(s.split(/[\s,]+/).map(v => v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[\\s,]*'), 'gi'));
function redact(value) {
  if (typeof value === 'string') {
    for (const pattern of patterns) value = value.replace(pattern, '[private]');
    return value.replace(/[\w.+-]+@[\w.-]+\.[a-z]{2,}/gi, '[email]');
  }
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redact(v)]));
  return value;
}
async function page() {
  const pages = context.pages().filter(p => navigationUrl(p.url()));
  assert(pages.length === 1, 'expected_one_test_page');
  return pages[0];
}
async function observation(p) { return { ...await p.locator('body').evaluate(readNavigationDom), url: p.url() }; }
async function checkpoint() {
  const p = await page();
  let o = await observation(p), ageRepeated = false;
  if (o.ageConfirmationRequired) {
    assert(ageConfirmations < 1, 'repeated_age_prompt');
    await repeatAuthorizedAgeConfirmation(p, task); ageConfirmations++; ageRepeated = true;
    o = await observation(p);
  }
  // Only wait for a product render when its URL has arrived; included in wall time.
  const until = Date.now() + 8000;
  while (new URL(o.url).searchParams.has('productId') && !o.dialogTitles.length && Date.now() < until) {
    await new Promise(r => setTimeout(r, 150)); o = await observation(p);
  }
  const destinationVerified = normalize(o.text).replace(/,/g, '').includes(normalize(settings.config.expectedAddress).replace(/,/g, ''));
  return redact({ url: o.url, headings: o.headings, dialogTitles: o.dialogTitles,
    siteUnavailable: o.siteUnavailable, destinationVerified, ageRepeated, ageConfirmations,
    verification: verifyNavigation(o, task), blockedMutations });
}
async function guard(body) {
  const p = await page(), o = await observation(p);
  if (['wait', 'scroll'].includes(body.kind)) return { allowed: true };
  assert(Number.isSafeInteger(body.node), 'invalid_node');
  const index = await p.evaluate(({ node, selector }) => {
    const e = window.__jevFast?.nodes.get(node);
    return [...document.querySelectorAll(selector)].indexOf(e);
  }, { node: body.node, selector: navigationSelector });
  const valid = navigationActions(o, task).some(a => a.control.index === index && a.kind === body.kind);
  return { allowed: valid, reason: valid ? null : 'outside_navigation_only_controls' };
}
async function stop() {
  server?.close(); proxy?.close();
  try { await context?.close(); } finally { await release(); }
  process.exit(0);
}
try {
  context = await chromium.launchPersistentContext(settings.dataDir + '/profile', {
    headless: true, chromiumSandbox: true, env: browserEnvironment(), acceptDownloads: false,
    serviceWorkers: 'block', locale: 'pl-PL', timezoneId: 'Europe/Warsaw', viewport: { width: 1120, height: 780 },
    args: ['--remote-debugging-port=9222'],
  });
  await context.route('**/*', route => {
    const r = route.request();
    if (blocksNavigationMutation(r.method(), r.url())) { blockedMutations++; return route.abort(); }
    if (r.isNavigationRequest() && !navigationUrl(r.url())) return route.abort();
    return route.continue();
  });
  context.on('page', p => { p.on('dialog', d => void d.dismiss()); });
  // Exposed only on Docker's private network. No host/public port mappings.
  proxy = tcpServer(client => {
    const remote = connect(9222, '127.0.0.1'); client.pipe(remote); remote.pipe(client);
    client.on('error', () => remote.destroy()); remote.on('error', () => client.destroy());
  }).listen(9229, '0.0.0.0');
  server = createServer(async (req, res) => {
    try {
      let body = ''; for await (const part of req) { body += part; assert(body.length < 2e6, 'body_too_large'); }
      const data = body ? JSON.parse(body) : {};
      let result;
      if (req.url === '/status' && req.method === 'GET') {
        const info = await (await fetch('http://127.0.0.1:9222/json/version')).json();
        result = { ready: true, websocket: info.webSocketDebuggerUrl.replace('127.0.0.1:9222', '127.0.0.1:9229') };
      } else if (req.url === '/checkpoint' && req.method === 'POST') result = await checkpoint();
      else if (req.url === '/guard' && req.method === 'POST') result = await guard(data);
      else if (req.url === '/redact' && req.method === 'POST') result = redact(data);
      else { res.writeHead(404); return res.end(); }
      res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(result));
    } catch (e) { res.writeHead(409, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: e.code || e.name })); }
  }).listen(9230, '0.0.0.0');
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  console.log('Owned benchmark browser ready; no model credentials in browser environment.');
} catch (error) {
  await context?.close(); await release(); throw error;
}
