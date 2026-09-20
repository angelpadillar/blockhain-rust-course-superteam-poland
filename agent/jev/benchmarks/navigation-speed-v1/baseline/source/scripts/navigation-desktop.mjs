import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { createInterface } from 'node:readline';
import { readFile, mkdir } from 'node:fs/promises';
import { randomBytes, createHash } from 'node:crypto';
import { join } from 'node:path';
import { onboard } from '../src/onboard.mjs';
import { saveJson } from '../src/storage.mjs';
import { createNavigationJournal, recoverNavigationJournals } from '../src/navigation-journal.mjs';
import { createJev } from '../src/jev.mjs';
import { assert } from '../src/config.mjs';
import { setupErrorMessage, escapeHtml } from '../src/setup.mjs';
import { readNavigationDom, navigationUrl, navigationActions,
  executeNavigation, blocksNavigationMutation, runNavigation, startNavigationAtHome } from '../src/navigation.mjs';

// Manual preparation and evaluation deliberately share the same live browser tab.
// The user alone handles any age/terms prompt; no consent or cookie state is fabricated.
process.env.DISPLAY = ':99';
const children = []; let setup, server, stopping = false, running = false;
async function stop(code = 0) {
  if (stopping) return; stopping = true; server?.close();
  await setup?.session.close().catch(() => {}); await setup?.release();
  for (const child of children) child.kill('SIGTERM');
  process.exit(code);
}
function start(command, args) {
  const child = spawn(command, args, { stdio: 'ignore' }); children.push(child);
  child.on('error', () => void stop(1)); child.on('exit', () => { if (!stopping) void stop(1); });
}
const task = JSON.parse(await readFile('cases/foczka-navigation.json', 'utf8'));
const sourceSha256 = createHash('sha256').update(await readFile('src/navigation.mjs')).digest('hex');
console.log('Ready for Typesafe key on stdin; input must be hidden by the caller.');
const lines = createInterface({ input: process.stdin, terminal: false });
let key = await new Promise(resolve => lines.once('line', resolve)); lines.close(); process.stdin.pause();
const decide = createJev({ apiKey: key, model: 'jev-latest' }); key = null;
try {
  start('Xvfb', [':99', '-screen', '0', '1440x1000x24', '-nolisten', 'tcp']);
  await new Promise(resolve => setTimeout(resolve, 700));
  start('fluxbox', []);
  start('x11vnc', ['-display', ':99', '-localhost', '-forever', '-shared', '-nopw', '-rfbport', '5900']);
  start('websockify', ['--web=/usr/share/novnc', '6080', '127.0.0.1:5900']);
  setup = await onboard({ desktop: true });
  await recoverNavigationJournals(setup.settings.dataDir);
  const { page, context } = setup.session;
  let blockedMutations = 0;
  // Unlike general account onboarding, this desktop permits only navigation.
  await context.route('**/*', async route => {
    const r = route.request();
    if (blocksNavigationMutation(r.method(), r.url(), { task, postData: r.postData() })) { blockedMutations++; return route.abort(); }
    if (r.isNavigationRequest() && !navigationUrl(r.url())) return route.abort();
    return route.continue();
  });
  context.on('page', popup => { if (popup !== page) void popup.close(); });
  const target = new URL(task.targetUrl);
  await page.goto(target.origin + target.pathname, { waitUntil: 'domcontentloaded', timeout: 30000 });
  try {
    const until = Date.now() + 10000;
    while (Date.now() < until) {
      const obs = { ...await page.locator('body').evaluate(readNavigationDom), url: page.url() };
      if (obs.ageConfirmationRequired) break;
      const category = navigationActions(obs, task).find(a => a.control.purpose === 'category' && a.control.label === 'Rum i gin');
      if (category) { await executeNavigation(page, obs, category, task); break; }
      await new Promise(resolve => setTimeout(resolve, 200));
    }
  } catch (error) { console.log(JSON.stringify({ preparation: 'manual_navigation_needed', reason: error.code || error.name })); }

  const nonce = randomBytes(24).toString('hex');
  const html = error => `<!doctype html><html lang="en"><meta charset="utf-8"><title>Start Glovo navigation test</title><main>
<h1>Start the navigation test</h1><p>Target: ${escapeHtml(task.product)} at ${escapeHtml(task.merchant)}.</p>
<p>Complete any age/terms confirmation yourself in the server browser. Then use the button below. This keeps that browser and tab open for the test.</p>
<p>The test returns to the Kraków homepage and attempts three navigation runs. It will not add products or buy anything. Leave the server browser untouched while the test runs.</p>
${error ? `<p role="alert">${escapeHtml(error)}</p>` : ''}
<form method="POST" action="/start?token=${nonce}"><button ${running ? 'disabled' : ''}>${running ? 'Test running' : 'Start three navigation runs'}</button></form></main></html>`;

  async function evaluate() {
    const batchId = new Date().toISOString().replace(/[:.]/g, '-'), results = [];
    await mkdir(join(setup.settings.dataDir, 'navigation'), { recursive: true, mode: 0o700 });
    let journal;
    try {
      for (let i = 0; i < 3; i++) {
        journal = await createNavigationJournal(setup.settings.dataDir, { task, config: setup.settings.config,
          environment: 'Hetzner VPS; headed Playwright; same manually prepared tab', batchId, run: i + 1 });
        // Reset only a verified product dialog; leave all other dialogs for the account holder.
        const before = await page.locator('body').evaluate(readNavigationDom);
        if (before.dialogTitles.includes(task.product)) {
          await journal.record({ type: 'preparation_dialog_close_planned', product: task.product });
          await page.getByRole('dialog').getByRole('button', { name: 'Zamknij', exact: true }).click();
        }
        const result = await runNavigation({ page, task, config: setup.settings.config, decide,
          signal: AbortSignal.timeout(task.maxRunMs), onEvent: event => journal.record(event), onStep: step => console.log(JSON.stringify({ run: i + 1, ...step })),
          startPage: () => startNavigationAtHome(page, task) });
        await journal.finish({ run: i + 1, blockedMutations, ...result });
        results.push({ run: i + 1, journalId: journal.id, ...result });
        journal = null;
        const report = { batchId, capturedAt: new Date().toISOString(), task, sourceSha256,
          environment: 'Hetzner VPS; headed Playwright Chromium; manual preparation and three attempts share one live browser and tab',
          setup: 'Manual age confirmation, merchant/category preparation and browser launch excluded. Each measured run follows the homepage link before Jev acts.',
          pricing: { inputUsdPerMillion: setup.settings.config.inputUsdPerMillion, outputUsdPerMillion: setup.settings.config.outputUsdPerMillion,
            scope: 'Estimated model API cost only; excludes VPS, setup and operator time.' }, blockedMutations, results };
        await saveJson(join(setup.settings.dataDir, 'navigation', `${batchId}.json`), report);
        console.log(JSON.stringify({ run: i + 1, status: result.status, reason: result.reason, metrics: result.metrics, verification: result.verification }));
        if (result.status !== 'reached_target') break;
      }
      console.log(JSON.stringify({ batchId, completedRuns: results.length, passed: results.filter(r => r.status === 'reached_target').length, blockedMutations }));
      if (results.length === 3 && results.every(r => r.status === 'reached_target')) await stop();
    } catch (error) {
      if (journal) await journal.finish({ status: 'incomplete', reason: error.code || error.name, completionVerified: false });
      throw error;
    } finally {
      // Keep the user's confirmed tab available after an incomplete attempt.
      running = false;
    }
  }

  server = createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store'); res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Content-Security-Policy', "default-src 'none'; form-action 'self'; frame-ancestors 'none'");
    if (req.method === 'GET' && req.url === '/status') {
      res.setHeader('Content-Type', 'application/json');
      if (running) return res.end(JSON.stringify({ running: true }));
      try {
        const current = await page.locator('body').evaluate(readNavigationDom);
        return res.end(JSON.stringify({ running: false, ageConfirmationRequired: current.ageConfirmationRequired,
          siteUnavailable: current.siteUnavailable, dialogTitles: current.dialogTitles, url: page.url() }));
      } catch { res.statusCode = 503; return res.end(JSON.stringify({ error: 'browser_unavailable' })); }
    }
    if (req.method === 'GET' && req.url === '/') return res.end(html());
    if (req.method === 'POST' && req.url === `/start?token=${nonce}` && !running) {
      try {
        const current = await page.locator('body').evaluate(readNavigationDom);
        assert(!current.siteUnavailable, 'merchant_site_unavailable');
        assert(!current.ageConfirmationRequired, 'age_confirmation_requires_user');
        await setup.finish(); running = true;
        res.statusCode = 202; res.end('The navigation test has started in the same browser. Please leave the server browser untouched. Results will be reported in Codex.');
        void evaluate().catch(() => void stop(1));
      } catch (error) {
        res.statusCode = 409;
        res.end(html(error.code === 'merchant_site_unavailable'
          ? 'Glovo is showing its problem page. Wait for the store page to load normally before starting the test.'
          : error.code === 'age_confirmation_requires_user'
            ? 'Glovo is still showing its age/terms prompt. Complete that step yourself in the server browser first.' : setupErrorMessage(error)));
      }
      return;
    }
    res.statusCode = 404; res.end();
  });
  server.listen(6081, '0.0.0.0');
  console.log('Navigation desktop ready. Complete any site confirmation, then use Start three navigation runs on port 6081. Browser stays open until the evaluation ends.');
  process.on('SIGTERM', () => void stop()); process.on('SIGINT', () => void stop());
} catch (error) { console.error(JSON.stringify({ error: 'navigation_desktop_failed', reason: error.code || error.name })); await stop(1); }
