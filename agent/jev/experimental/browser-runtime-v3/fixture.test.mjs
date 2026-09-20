import test from 'node:test';
import assert from 'node:assert/strict';
import { createFixtureServer } from './fixture.mjs';
import { createDeterministicChooser, executionSchedule, summarizeAttempts } from './benchmark.mjs';

async function withFixture(fn) {
  const fixture = await createFixtureServer({ seed: 12345 });
  try { await fn(fixture); } finally { await fixture.close(); }
}

async function observedLinks(fixture, descriptor) {
  const html = await (await fetch(`${fixture.origin}/catalogue/${descriptor.id}?q=${encodeURIComponent(descriptor.publicTask.query)}`)).text();
  return [...html.matchAll(/<section aria-label="([^"]+)">([\s\S]*?)<\/section>/g)]
    .flatMap(section => [...section[2].matchAll(/<a href="([^"]+)">([^<]+)<\/a>/g)]
      .map(link => ({ url: fixture.origin + link[1], title: link[2], context: section[1] })));
}

function pageEvidence({ url, headings = [], collections = [], empty = false }) {
  return { url: () => url, evaluate: async () => ({ headings, collections, empty }) };
}

test('runtime task descriptors contain goals only and answer routes are not exported', async () => withFixture(async fixture => {
  assert.equal(fixture.cases.length, 10);
  assert.equal(fixture.cases.filter(descriptor => descriptor.expectation === 'complete').length, 9);
  assert.equal(fixture.cases.filter(descriptor => descriptor.expectation === 'stop').length, 1);
  for (const descriptor of fixture.cases) {
    assert.deepEqual(Object.keys(descriptor).sort(), ['expectation', 'id', 'publicTask', 'startUrl']);
    assert.deepEqual(Object.keys(descriptor.publicTask).sort(), ['duplicate-labels', 'semantic-context'].includes(descriptor.id)
      ? ['context', 'query', 'targetText'] : ['query', 'targetText']);
    assert.match(descriptor.startUrl, /^http:\/\/127\.0\.0\.1:\d+\/cases\/[a-z-]+$/);
    assert.doesNotMatch(JSON.stringify(descriptor), /\/items\/|[a-f0-9]{20}|expectedUrl|targetId|selector/);
    assert.ok(Object.isFrozen(descriptor.publicTask));
  }
  assert.equal(Object.hasOwn(fixture, 'definitions'), false);
  assert.equal(Object.hasOwn(fixture, 'answers'), false);
}));

test('independent verifier requires correct route, visible title and collection together', async () => withFixture(async fixture => {
  const descriptor = fixture.cases.find(item => item.id === 'live-search');
  const [link] = await observedLinks(fixture, descriptor);
  const rendered = { url: link.url, headings: [link.title], collections: [link.context] };
  assert.equal((await fixture.verify(pageEvidence(rendered), descriptor)).passed, true);
  for (const change of [
    { headings: [] }, { collections: [] }, { headings: ['Unrelated title'] },
    { url: descriptor.startUrl }, { url: link.url + '?claimed=complete' },
    { url: link.url + '#claimed' }, { url: link.url.replace(fixture.origin, 'https://example.invalid') },
  ]) assert.equal((await fixture.verify(pageEvidence({ ...rendered, ...change }), descriptor)).passed, false);
  const result = await fixture.verify(pageEvidence(rendered), descriptor);
  assert.deepEqual(Object.keys(result).sort(), ['checks', 'expectation', 'passed']);
  assert.doesNotMatch(JSON.stringify(result), /\/items\/|[a-f0-9]{20}/);
}));

test('case descriptor changes and plausible duplicate title cannot change verifier ground truth', async () => withFixture(async fixture => {
  const descriptor = fixture.cases.find(item => item.id === 'duplicate-labels');
  const links = await observedLinks(fixture, descriptor);
  assert.equal(links.length, 2);
  const wrong = links.find(link => link.context === 'Travel shelf');
  const correct = links.find(link => link.context === descriptor.publicTask.context);
  assert.equal((await fixture.verify(pageEvidence({ url: correct.url, headings: [correct.title], collections: [correct.context] }), descriptor)).passed, true);
  const tampered = { ...descriptor, expectation: 'complete', publicTask: { ...descriptor.publicTask, context: 'Travel shelf' }, expectedUrl: wrong.url, status: 'opened' };
  const result = await fixture.verify(pageEvidence({ url: wrong.url, headings: [wrong.title], collections: [wrong.context] }), tampered);
  assert.equal(result.passed, false);
  assert.equal(result.checks.exactDetailRoute, false);
  assert.equal(result.checks.exactCollection, false);
}));

test('semantic-context fixture leaves a real nonliteral ambiguity for a chooser', async () => withFixture(async fixture => {
  const descriptor = fixture.cases.find(item => item.id === 'semantic-context');
  assert.equal(descriptor.publicTask.context, 'the shelf for creative studio work');
  const links = await observedLinks(fixture, descriptor);
  assert.equal(links.length, 2);
  assert.ok(links.every(link => link.title === descriptor.publicTask.targetText));
  assert.deepEqual(links.map(link => link.context).sort(), ['Studio shelf', 'Travel shelf']);
  assert.ok(links.every(link => link.context !== descriptor.publicTask.context));
}));

test('empty result is a separately verified stop, never a completion', async () => withFixture(async fixture => {
  const descriptor = fixture.cases.find(item => item.id === 'empty-result');
  const result = await fixture.verify(pageEvidence({ url: descriptor.startUrl, empty: true }), descriptor);
  assert.equal(result.expectation, 'stop');
  assert.equal(result.passed, true);
  assert.equal((await fixture.verify(pageEvidence({ url: descriptor.startUrl, empty: false }), descriptor)).passed, false);
  assert.equal((await fixture.verify(pageEvidence({ url: descriptor.startUrl, empty: true, headings: [descriptor.publicTask.targetText] }), descriptor)).passed, false);
  const html = await (await fetch(`${fixture.origin}/catalogue/${descriptor.id}?q=${encodeURIComponent(descriptor.publicTask.query)}`)).text();
  assert.match(html, /role="status">No matching items/);
  assert.doesNotMatch(html, /href=/);
}));

test('fixtures are read-only, reset counters, and expose semantic native controls', async () => withFixture(async fixture => {
  const enter = fixture.cases.find(item => item.id === 'enter-form');
  const form = await (await fetch(enter.startUrl)).text();
  assert.match(form, /<form role="search" method="GET"/);
  assert.match(form, /type="search"/);
  assert.equal((await fetch(enter.startUrl, { method: 'POST' })).status, 405);
  assert.equal(fixture.requestCount(enter.id), 1);
  assert.deepEqual(fixture.reset(enter.id), { caseId: enter.id, generation: 1 });
  assert.equal(fixture.requestCount(enter.id), 0);
  const delayed = fixture.cases.find(item => item.id === 'delayed-title');
  const [link] = await observedLinks(fixture, delayed);
  const detail = await (await fetch(link.url)).text();
  assert.match(detail, /<h1 hidden>/);
  assert.match(detail, /},650\)/);
  const animated = await (await fetch(fixture.cases.find(item => item.id === 'unrelated-animation').startUrl)).text();
  assert.match(animated, /aria-hidden="true"/);
  assert.match(animated, /setInterval/);
}));

test('fixed seed deterministically changes private item routes without changing public task', async () => {
  const first = await createFixtureServer({ seed: 1 });
  const same = await createFixtureServer({ seed: 1 });
  const other = await createFixtureServer({ seed: 2 });
  try {
    const descriptors = [first, same, other].map(fixture => fixture.cases[0]);
    assert.deepEqual(descriptors[0].publicTask, descriptors[1].publicTask);
    assert.deepEqual(descriptors[0].publicTask, descriptors[2].publicTask);
    const links = await Promise.all([first, same, other].map((fixture, index) => observedLinks(fixture, descriptors[index])));
    assert.equal(new URL(links[0][0].url).pathname, new URL(links[1][0].url).pathname);
    assert.notEqual(new URL(links[0][0].url).pathname, new URL(links[2][0].url).pathname);
  } finally { await Promise.all([first.close(), same.close(), other.close()]); }
});

test('deterministic semantic chooser uses only exact observed goal and context', async () => {
  const choose = createDeterministicChooser();
  const candidates = [
    { ref: 's1:e1', what: 'Copper Finch Notebook', where: ['Travel shelf'], supports: ['click'] },
    { ref: 's1:e2', what: 'Copper Finch Notebook', where: ['Studio shelf'], supports: ['click'] },
    { ref: 's1:e3', what: 'Copper Finch Notebook Large', where: ['Studio shelf'], supports: ['click'] },
  ];
  const task = { query: 'Copper Finch', targetText: 'Copper Finch Notebook', context: 'Studio shelf' };
  assert.equal(await choose({ kind: 'result', candidates, task, expectedUrl: '/wrong', caseId: 'unused' }), 's1:e2');
  assert.equal(await choose({ kind: 'result', candidates, task: { ...task, context: 'the shelf for creative studio work' } }), 's1:e2');
  await assert.rejects(choose({ kind: 'result', candidates, task: { ...task, context: undefined } }), /unresolved_semantic_ambiguity/);
  await assert.rejects(choose({ kind: 'result', candidates, task: { ...task, targetText: 'Absent title' } }), /unresolved_semantic_ambiguity/);
  assert.equal(await choose({ kind: 'search', task, candidates: [{ ref: 's0:e1', what: 'Search catalogue', supports: ['fill', 'press'] }] }), 's0:e1');
});

test('paired schedule alternates order and summary retains failures outside success latency', () => {
  const schedule = executionSchedule([{ id: 'a', expectation: 'complete' }, { id: 'b', expectation: 'complete' }, { id: 'empty', expectation: 'stop' }]);
  assert.equal(schedule.length, 10);
  assert.deepEqual(schedule.slice(0, 4).map(row => row.mode), ['fast', 'stepwise', 'stepwise', 'fast']);
  assert.deepEqual(schedule.slice(4, 8).map(row => row.mode), ['stepwise', 'fast', 'fast', 'stepwise']);
  const rows = [
    { caseId: 'a', repeat: 1, mode: 'fast', expectation: 'complete', completed: true, timings: { totalMs: 100, navigationMs: 10, runtimeMs: 85, verificationMs: 5 } },
    { caseId: 'a', repeat: 1, mode: 'stepwise', expectation: 'complete', completed: true, timings: { totalMs: 300, navigationMs: 10, runtimeMs: 285, verificationMs: 5 } },
    { caseId: 'a', repeat: 2, mode: 'fast', expectation: 'complete', completed: false, timings: { totalMs: 1000 } },
    { caseId: 'empty', repeat: 1, mode: 'fast', expectation: 'stop', expectedStopVerified: true, timings: { totalMs: 200 } },
  ];
  const summary = summarizeAttempts(rows);
  assert.equal(summary.arms.fast.attempted, 2);
  assert.equal(summary.arms.fast.failed, 1);
  assert.equal(summary.arms.fast.verifiedCompletionMs.median, 100);
  assert.equal(summary.arms.fast.allAttemptMs.median, 550);
  assert.equal(summary.pairs.bothCompleted, 1);
  assert.equal(summary.pairs.stepwiseMinusFastMs.median, 200);
  assert.equal(summary.expectedStops.fast.verifiedStops, 1);
});
