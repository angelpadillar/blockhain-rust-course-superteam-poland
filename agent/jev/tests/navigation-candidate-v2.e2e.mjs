import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright-core';
import { runNavigationCandidate } from '../src/navigation-candidate-v2.mjs';
import { config, response } from './helpers.mjs';

test('v2 fills then submits the baseline search choice while retaining local snapshot refs through verified completion', async () => {
  const task = JSON.parse(await readFile(new URL('../cases/foczka-navigation.json', import.meta.url)));
  const target = new URL(task.targetUrl);
  const attr = value => value.replaceAll('&', '&amp;').replaceAll('"', '&quot;');
  const browser = await chromium.launch({ ...(process.env.JEV_BROWSER_CHANNEL ? { channel: process.env.JEV_BROWSER_CHANNEL } : {}), chromiumSandbox: true });
  const events = [], requests = [];
  let writes = 0;
  try {
    const page = await browser.newPage();
    await page.route('**/*', route => {
      if (route.request().method() !== 'GET') writes++;
      return route.fulfill({ contentType: 'text/html; charset=utf-8', body:
        `<p>${config.expectedAddress}</p><div id="home">
<input type="search" aria-label="Wyszukaj" oninput="window.enteredQuery=this.value" onkeydown="if(event.key==='Enter'){window.submitted=true;document.querySelector('#merchant').hidden=false}">
<a id="merchant" hidden href="${attr(target.origin + target.pathname)}" onclick="event.preventDefault();history.pushState({},'',this.href);document.querySelector('#home').hidden=true;document.querySelector('#catalogue').hidden=false">${task.merchant}</a></div>
<section id="catalogue" hidden><div class="ItemTile_itemTile__test"><h3 onclick="history.pushState({},'',${attr(JSON.stringify(task.targetUrl))});document.querySelector('dialog').showModal()">${task.product}</h3></div></section>
<dialog><h1>${task.product}</h1><button>Dodaj 1</button></dialog>` });
    });
    const required = [`Search for ${task.merchant}`, `Submit search for ${task.merchant}`,
      `Open link: ${task.merchant}`, `Open product: ${task.product}`];
    const result = await runNavigationCandidate({ page, task, config, signal: AbortSignal.timeout(15000),
      onEvent: async event => events.push(event), decide: async request => {
        requests.push(request);
        const criteria = Object.entries(request.questions.next_action.criteria);
        assert(criteria.every(([, value]) => typeof value === 'string'), 'v2 must use baseline string criteria');
        const expected = required[requests.length - 1];
        const chosen = criteria.find(([, value]) => value === expected);
        assert(chosen, `The current state must offer the next observed action: ${expected}`);
        if (requests.length === 2) {
          assert.equal(await page.evaluate(() => window.enteredQuery), task.merchant);
          assert.equal(await page.evaluate(() => Boolean(window.submitted)), false);
          assert.equal(JSON.parse(request.state).history.at(-1).pageAfter, task.startUrl);
          assert.match(request.questions.next_action.instructions, /Search may update without Enter/);
        }
        const choice = chosen[0];
        return response(choice, { answers: { next_action: { type: 'choice', choice, confidence: 1,
          probabilities: Object.fromEntries(criteria.map(([id]) => [id, id === choice ? 1 : 0])) } } });
      } });
    assert.equal(result.status, 'reached_target', JSON.stringify(result));
    assert.equal(result.verification.passed, true);
    assert.equal(result.verification.checks.visibleProduct, true);
    assert.equal(result.metrics.modelCalls, 4);
    assert.equal(result.metrics.actions, 4);
    assert.equal(result.metrics.staleRecoveries, 0);
    assert.equal(await page.evaluate(() => window.submitted), true);
    assert.deepEqual(result.steps.map(step => step.action), required);
    const planned = events.filter(event => event.type === 'action_planned');
    assert.equal(planned.length, 4);
    assert(planned.every(event => /^s\d+:e\d+$/.test(event.candidate.ref)));
    for (const event of planned) {
      assert(!JSON.stringify(requests).includes(event.candidate.ref), 'Snapshot refs remain in local execution/journal only');
      assert(events.indexOf(event) < events.findIndex(other => other.type === 'action_executed' && other.step === event.step));
    }
    assert(events.some(event => event.type === 'completion_verified'));
    assert.equal(writes, 0);
    assert.equal(result.basketActions, 0);
    assert.equal(result.purchaseActions, 0);
  } finally { await browser.close(); }
});
