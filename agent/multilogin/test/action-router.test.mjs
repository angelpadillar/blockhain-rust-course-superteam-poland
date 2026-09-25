import test from 'node:test';
import assert from 'node:assert/strict';
import { createToolRegistry, createToolShortlister, createSystemOneScorer, createEconomicsPolicy,
  createResultAdmissionPolicy, createToolRouter, createMemoryProvider, toolKinds } from '../src/action-router.mjs';
import { createRecoveryMemory } from '../src/recovery-memory.mjs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('the registry exposes every permitted browser capability as a descriptor', () => {
  const registry = createToolRegistry();
  const registration = registry.get('fill_password');
  assert.equal(registration.kind, 'fill');
  assert.equal(registration.risk, 'form_preparation');
  assert.deepEqual(registration.roles, ['login']);
  const escalation = registry.get('escalate_security_checkpoint');
  assert.equal(escalation.recoveryOnly, true);
  assert.deepEqual(escalation.roles, ['recovery']);
  // Every registry kind is a member of the shared browser contract.
  for (const tool of registry.list()) assert.ok(toolKinds.includes(tool.kind), tool.name);
  // A fifth capability can be added without touching the login path.
  const extended = createToolRegistry({ extraTools: [{ name: 'open_youtube_studio', kind: 'navigate',
    risk: 'reversible_navigation', roles: ['login'], source: 'deterministic', description: 'open Studio' }] });
  assert.equal(extended.get('open_youtube_studio').kind, 'navigate');
});

test('the shortlister refuses recovery tools in the login phase and unknown actions', () => {
  const registry = createToolRegistry();
  const shortlister = createToolShortlister({ registry });
  const login = shortlister.forCandidates({ workflow: 'login', phase: 'action',
    candidates: [{ kind: 'fill_username', id: 'a1' }, { kind: 'submit_login', id: 'a2' }] });
  assert.deepEqual(login.map(item => item.tool), ['fill_username', 'submit_login']);
  assert.throws(() => shortlister.forCandidates({ workflow: 'login', phase: 'action',
    candidates: [{ kind: 'navigate_home', id: 'r1' }] }), /recovery_tool_in_login_phase/);
  assert.throws(() => shortlister.forCandidates({ workflow: 'login', phase: 'action',
    candidates: [{ kind: 'click_observed', id: 'x' }] }), /unregistered_action/);
  const recovery = shortlister.forCandidates({ workflow: 'recovery', phase: 'recovery',
    candidates: [{ kind: 'retry_observation', id: 'r0' }, { kind: 'open_switch_account', id: 'r1' }] });
  assert.deepEqual(recovery.map(item => item.tool), ['retry_observation', 'open_switch_account']);
});

test('the System One scorer wraps the existing chooser and never bypasses the floor', async () => {
  const calls = [];
  const chooser = async request => { calls.push(request); return { action: request.actions[1], confidence: 0.91, probability: 0.8, method: 'typesafe-choice' }; };
  const scorer = createSystemOneScorer({ chooser });
  const shortlist = [{ id: 'a', tool: 'fill_username', kind: 'fill', description: 'Username' },
    { id: 'b', tool: 'fill_password', kind: 'fill', description: 'Password' }];
  const scored = await scorer.score({ observation: { url: 'https://example.test/' }, shortlist });
  assert.equal(scored.abstained, false);
  assert.equal(scored.candidate.tool, 'fill_password');
  assert.equal(scored.source, 'jev');
  assert.equal(calls.length, 1, 'a multi-candidate question reaches the chooser exactly once');
  // Exactly one candidate is the deterministic shortcut: no model call.
  const single = await scorer.score({ shortlist: [shortlist[0]] });
  assert.equal(single.source, 'deterministic');
  assert.equal(single.method, 'exact-single-match');
  assert.equal(calls.length, 1);
  // A sub-floor answer abstains instead of executing.
  const uncertain = createSystemOneScorer({ chooser: async request =>
    ({ action: request.actions[0], confidence: 0.4, probability: 0.5 }) });
  const abstained = await uncertain.score({ shortlist });
  assert.equal(abstained.abstained, true);
  assert.equal(abstained.reason, 'below_confidence_floor');
});

test('routing prefers deterministic, then the cheap scorer, then a person', async () => {
  const registry = createToolRegistry();
  const shortlister = createToolShortlister({ registry });
  const economics = createEconomicsPolicy({ maxModelCalls: 1 });
  let chooserCalls = 0;
  const chooser = async request => { chooserCalls++;
    return { action: request.actions[0], confidence: 0.95, probability: 0.9, method: 'typesafe-choice' }; };
  const router = createToolRouter({ registry, shortlister, scorer: createSystemOneScorer({ chooser }), economics });
  // A single permitted action is deterministic and spends nothing.
  const deterministic = await router.route({ workflow: 'login',
    candidates: [{ kind: 'submit_login', id: 'a1' }] });
  assert.equal(deterministic.outcome, 'deterministic');
  assert.equal(chooserCalls, 0);
  // Two actions are a genuine question for the cheap scorer.
  const ambiguous = await router.route({ workflow: 'login',
    candidates: [{ kind: 'fill_username', id: 'a1' }, { kind: 'fill_password', id: 'a2' }] });
  assert.equal(ambiguous.outcome, 'jev');
  assert.equal(chooserCalls, 1);
  assert.equal(economics.spent.modelCalls, 1);
  // The budget is now exhausted: the next ambiguous state escalates.
  const exhausted = await router.route({ workflow: 'login',
    candidates: [{ kind: 'fill_username', id: 'a1' }, { kind: 'fill_password', id: 'a2' }] });
  assert.equal(exhausted.outcome, 'human');
  assert.equal(exhausted.rationale, 'model_budget_exhausted');
  assert.equal(chooserCalls, 1);
  // A classified security surface is a person's job even with one candidate.
  const challenge = await router.route({ workflow: 'login',
    candidates: [{ kind: 'submit_login', id: 'a1' }], classifiedReason: 'human_verification_required' });
  assert.equal(challenge.outcome, 'human');
  assert.equal(challenge.tool, 'escalate_security_checkpoint');
  // A keyword state routes without a model request.
  const keyword = await router.route({ workflow: 'login', candidates: [{ kind: 'fill_totp', id: 'a1' }],
    keywordState: 'known_totp_screen' });
  assert.equal(keyword.outcome, 'deterministic');
});

test('admission is about workflow roles and the confidence floor, not the model’s belief', () => {
  const admission = createResultAdmissionPolicy({});
  const authorized = admission.admit({ workflow: 'login',
    candidate: { tool: 'submit_login', risk: 'authentication' }, decision: { confidence: 0.95, method: 'typesafe-choice' } });
  assert.equal(authorized.admitted, true);
  assert.equal(authorized.role, 'authenticate');
  const recoveryCannotAuthenticate = admission.admit({ workflow: 'recovery',
    candidate: { tool: 'submit_login', risk: 'authentication' }, decision: { confidence: 1, method: 'typesafe-choice' } });
  assert.equal(recoveryCannotAuthenticate.admitted, false);
  assert.match(recoveryCannotAuthenticate.reason, /risk_not_authorized/);
  const uncertain = admission.admit({ workflow: 'login',
    candidate: { tool: 'fill_username', risk: 'form_preparation' }, decision: { confidence: 0.5, method: 'typesafe-choice' } });
  assert.equal(uncertain.admitted, false);
  assert.equal(uncertain.reason, 'below_confidence_floor');
});

test('memory hints ride the route, bounded to a couple of compact episodes', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'router-memory-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const memory = createRecoveryMemory({ directory });
  await memory.record({ reason: 'unexpected_state', statePath: 'https://www.youtube.com/',
    failedAction: 'reopen_account_menu', correction: 'navigate_home', verification: 'login_verified' });
  const registry = createToolRegistry();
  const shortlister = createToolShortlister({ registry });
  const router = createToolRouter({ registry, shortlister, memory: createMemoryProvider({ memory }) });
  const routed = await router.route({ workflow: 'recovery', classifiedReason: null,
    candidates: [{ kind: 'retry_observation', id: 'r0' }, { kind: 'navigate_home', id: 'r1' }],
    observation: { url: 'https://www.youtube.com/' } });
  assert.ok(routed.memory.length >= 1 && routed.memory.length <= 2);
  assert.equal(routed.memory[0].correction, 'navigate_home');
});

test('the router counts redundant and failed choices for later comparison', async () => {
  const registry = createToolRegistry();
  const router = createToolRouter({ registry, shortlister: createToolShortlister({ registry }) });
  await router.route({ workflow: 'login', candidates: [{ kind: 'submit_login', id: 'a1' }] });
  router.recordExecution({ outcome: 'deterministic', succeeded: true });
  router.recordExecution({ outcome: 'jev', succeeded: false });
  assert.equal(router.counters.deterministic, 1);
  assert.equal(router.counters.redundant, 2);
  assert.equal(router.counters.failed, 1);
});

test('observation mode records decisions and outcomes without changing them', async t => {
  const { createRouterObserver, wrapGuideForObservation } = await import('../src/action-router.mjs');
  const { mkdtemp, readFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const directory = await mkdtemp(join(tmpdir(), 'router-observer-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const observer = createRouterObserver({ directory, now: () => 1_000_000 });
  const decision = { action: { id: 'a0' }, method: 'exact-single-match', confidence: null, probability: null };
  const guide = async () => decision;
  guide.metrics = { calls: 0 };
  const wrapped = wrapGuideForObservation(guide, observer);
  const returned = await wrapped({ phase: 'login', step: 3, actions: [
    { id: 'a0', description: 'fill_username: observed input labelled "Email"' },
    { id: 'a1', description: 'fill_password: observed input labelled "Password"' }] });
  assert.equal(returned, decision, 'the decision is returned untouched');
  assert.equal(wrapped.metrics, guide.metrics, 'the metrics object is preserved');
  await observer.observeStep({ phase: 'login', state: 'before', action: 'fill_username' });
  await observer.observeStep({ phase: 'login', state: 'after', action: 'fill_username' });
  const lines = (await readFile(observer.path, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.equal(lines.length, 3);
  assert.equal(lines[0].kind, 'decision');
  assert.equal(lines[0].step, 3);
  assert.equal(lines[0].stateClass, 'login_form');
  assert.deepEqual(lines[0].candidates, [{ id: 'a0', tool: 'fill_username' }, { id: 'a1', tool: 'fill_password' }]);
  assert.equal(lines[0].router.topCandidate, 'a0');
  assert.equal(lines[0].router.agreed, true);
  assert.equal(lines[0].chosen.method, 'exact-single-match');
  assert.equal(lines[0].scorerSource, 'deterministic');
  assert.equal(lines[0].executionChanged, false);
  assert.equal(lines[1].kind, 'execution');
  assert.equal(lines[1].succeeded, null);
  assert.equal(lines[2].kind, 'outcome');
  assert.equal(lines[2].succeeded, true);
  assert.equal(observer.summary.decisions, 1);
  assert.equal(observer.summary.agreements, 1);
  assert.equal(observer.summary.succeeded, 1);
  assert.equal(observer.summary.executionChanged, false);
  assert.equal(JSON.stringify(lines).includes('Email'), false, 'descriptions are never stored');
});

test('observation mode records a disagreement and a failed execution', async t => {
  const { createRouterObserver, wrapGuideForObservation } = await import('../src/action-router.mjs');
  const { mkdtemp, readFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const directory = await mkdtemp(join(tmpdir(), 'router-observer-fail-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const observer = createRouterObserver({ directory });
  const guide = async request => ({ action: request.actions[1], method: 'typesafe-choice',
    confidence: 0.9, probability: 0.8 });
  const wrapped = wrapGuideForObservation(guide, observer);
  await wrapped({ phase: 'jev_recovery', step: 7, classifiedReason: 'human_verification_required',
    actions: [{ id: 'r0', description: 'retry_observation: Re-read the page' },
      { id: 'r1', description: 'escalate_security_checkpoint: Only a person can proceed' }] });
  await observer.observeStep({ phase: 'jev_recovery', state: 'before', action: 'escalate_security_checkpoint' });
  await observer.observeStep({ phase: 'attention', reason: 'human_verification_required' });
  const lines = (await readFile(observer.path, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.equal(lines[0].stateClass, 'checkpoint:human_verification_required');
  assert.equal(lines[0].router.agreed, false);
  assert.equal(lines[0].scorerSource, 'jev');
  assert.equal(lines[0].chosen.confidence, 0.9);
  assert.equal(lines[2].kind, 'outcome');
  assert.equal(lines[2].succeeded, false);
  assert.equal(lines[2].reason, 'human_verification_required');
  assert.equal(observer.summary.disagreements, 1);
  assert.equal(observer.summary.modelDecisions, 1);
  assert.equal(observer.summary.failed, 1);
});
