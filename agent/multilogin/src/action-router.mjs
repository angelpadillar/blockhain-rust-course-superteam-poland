import { mkdir, appendFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { requireThat } from './core.mjs';
import { operationKinds, riskByOperation, workflowRoles, decisionSourceFor } from './execution.mjs';
import { recoveryCapabilities } from './recovery.mjs';

// Adapter boundary between THIS browser agent and the provider-agnostic Agent
// Efficiency Runtime (jev-compaction). The concepts map like this:
//
//   ToolDescriptor     -> describeTool / toolForOperation
//   ToolRegistry       -> createToolRegistry
//   ToolShortlister    -> createToolShortlister
//   SystemOneScorer    -> createSystemOneScorer (wraps the existing JEV chooser)
//   MemoryProvider     -> createMemoryProvider (wraps recovery-memory.mjs)
//   EconomicsPolicy    -> createEconomicsPolicy (model-call and cost budget)
//   ResultAdmissionPolicy -> createResultAdmissionPolicy (workflow roles + freshness)
//   EvidenceStore      -> createEvidenceStore (receipts + lifecycle journal)
//
// The browser runtime does NOT depend on jev-compaction: this module only names
// the seam and provides local implementations over primitives that already
// exist and are already tested. A future adapter can substitute a real
// ToolRegistry/Scorer without changing the login path.

export const toolSources = ['deterministic', 'jev', 'frontier', 'operator', 'human'];
export const toolKinds = ['click', 'fill', 'submit', 'choose', 'navigate', 'back', 'wait', 'dismiss'];
export const routingOutcomes = ['deterministic', 'jev', 'frontier', 'human', 'blocked'];

export function describeTool({ name, kind, risk, roles, source, description, recoveryOnly = false,
  costClass = 'local' } = {}) {
  requireThat(typeof name === 'string' && /^[a-z][a-z0-9_]{1,47}$/.test(name), 'invalid_tool_name');
  requireThat(toolKinds.includes(kind), 'unsupported_tool_kind');
  requireThat(toolSources.includes(source), 'unsupported_tool_source');
  requireThat(Array.isArray(roles) && roles.length > 0, 'tool_roles_required');
  return { name, kind, risk, roles: [...roles], source, description: description || name,
    recoveryOnly: recoveryOnly === true, costClass };
}

// Every workflow operation the executor understands, plus every typed recovery
// capability. The recovery capabilities are marked recoveryOnly so a login-phase
// shortlist can exclude them without a second table.
export function createToolRegistry({ extraTools = [] } = {}) {
  const tools = new Map();
  for (const [operation, kind] of Object.entries(operationKinds)) {
    if (operation.endsWith('_observed')) continue; // external surface, not login
    const risk = riskByOperation[operation];
    tools.set(operation, describeTool({ name: operation, kind, risk,
      roles: ['login'], source: 'deterministic',
      description: `deterministic ${operation}`, costClass: 'local' }));
  }
  for (const [capability, description] of Object.entries(recoveryCapabilities)) {
    tools.set(capability, describeTool({ name: capability,
      kind: capability === 'navigate_home' ? 'navigate' : capability === 'retry_observation' || capability === 'wait'
        || capability === 'escalate_security_checkpoint' || capability === 'complete' ? 'wait' : 'click',
      risk: riskByOperation[capability] || 'read_only', roles: ['recovery'], source: 'jev',
      description, recoveryOnly: true, costClass: 'model' }));
  }
  for (const tool of extraTools) {
    requireThat(!tools.has(tool.name), 'duplicate_tool');
    tools.set(tool.name, describeTool(tool));
  }
  return {
    size: tools.size,
    get: name => tools.get(name) || null,
    list: ({ recoveryOnly = null } = {}) => [...tools.values()]
      .filter(tool => recoveryOnly === null || tool.recoveryOnly === recoveryOnly),
    forRoles: roleList => [...tools.values()].filter(tool => tool.roles.some(role => roleList.includes(role))),
  };
}

const roleFor = risk => ({ read_only: 'read', reversible_navigation: 'navigate',
  form_preparation: 'prepare', authentication: 'authenticate',
  consequential_external_action: 'consequential' }[risk] || null);

// A shortlist is the only place candidates come from: one entry per observed
// control or page capability, each bound to a registry tool.
export function createToolShortlister({ registry }) {
  requireThat(registry?.list, 'tool_registry_required');
  return {
    forCandidates({ candidates = [], workflow = 'login', phase = 'action' } = {}) {
      const roleList = workflowRoles[workflow] || [];
      return candidates.map((candidate, index) => {
        const tool = registry.get(candidate.kind);
        requireThat(tool, `unregistered_action:${candidate.kind}`);
        requireThat(tool.roles.includes(workflow) || roleList.includes(roleFor(tool.risk)), 'tool_not_permitted_for_workflow');
        requireThat(workflow !== 'login' || !tool.recoveryOnly, 'recovery_tool_in_login_phase');
        return { id: candidate.id || `t${index}`, tool: tool.name, kind: tool.kind, risk: tool.risk,
          description: candidate.description || tool.description, candidate };
      });
    },
  };
}

// The cheap System One scorer is exactly the existing JEV chooser: it answers a
// finite-choice question and abstains below the confidence floor. It is wrapped,
// not reimplemented, so the browser path keeps one validation contract.
export function createSystemOneScorer({ chooser, confidenceFloor = 0.8 } = {}) {
  requireThat(typeof chooser === 'function', 'chooser_required');
  return {
    async score({ observation, shortlist, goal = null }) {
      requireThat(shortlist.length > 0, 'shortlist_required');
      if (shortlist.length === 1) {
        return { abstained: false, source: 'deterministic', candidate: shortlist[0],
          method: 'exact-single-match', confidence: null };
      }
      const request = { page: observation, observation, actions: shortlist.map(entry =>
        ({ id: entry.id, description: entry.description })) };
      const decision = await chooser(goal ? { ...request, page: { goal, ...observation } } : request);
      if (!decision || decision.abstain) return { abstained: true, reason: 'scorer_abstained' };
      if (Number.isFinite(decision.confidence) && decision.confidence < confidenceFloor) {
        return { abstained: true, reason: 'below_confidence_floor', confidence: decision.confidence };
      }
      const candidate = shortlist.find(entry => entry.id === decision.action?.id);
      requireThat(candidate, 'scorer_unknown_choice');
      return { abstained: false, source: actionSourceForDecision(decision), candidate,
        method: decision.method || null, confidence: decision.confidence ?? null,
        probability: decision.probability ?? null };
    },
  };
}

function actionSourceForDecision(decision) {
  return decision?.method === 'exact-single-match' ? 'deterministic' : 'jev';
}

// The budget boundary: model calls are the expensive resource. Deterministic
// routing spends nothing; an exhausted budget escalates instead of looping.
export function createEconomicsPolicy({ maxModelCalls = 5, maxFrontierCalls = 1 } = {}) {
  const spent = { modelCalls: 0, frontierCalls: 0 };
  return { spent,
    canSpendModel: () => spent.modelCalls < maxModelCalls,
    canSpendFrontier: () => spent.frontierCalls < maxFrontierCalls,
    recordModel: ({ frontier = false } = {}) => { spent.modelCalls++; if (frontier) spent.frontierCalls++; },
  };
}

// Admission is independent of who chose the action: workflow roles authorize the
// risk class, and freshness is checked against the observation the decision
// quoted. A model confidence never widens either.
export function createResultAdmissionPolicy({ allowedRoles = [], confidenceFloor = 0.8 } = {}) {
  return {
    admit({ decision, candidate, workflow = null }) {
      if (!candidate) return { admitted: false, reason: 'no_candidate' };
      const roles = workflow && workflowRoles[workflow] ? workflowRoles[workflow] : allowedRoles;
      const risk = candidate.risk || riskByOperation[candidate.tool || candidate.kind];
      const role = roleFor(risk);
      if (!role || !roles.includes(role)) return { admitted: false, reason: `risk_not_authorized:${risk}` };
      if (decision?.confidence !== null && decision?.confidence !== undefined
        && decision.confidence < confidenceFloor && decision.method !== 'exact-single-match') {
        return { admitted: false, reason: 'below_confidence_floor' };
      }
      return { admitted: true, role, risk };
    },
  };
}

// The evidence boundary over the existing receipt store plus the lifecycle
// journal: append-only, metadata only.
export function createEvidenceStore({ directory } = {}) {
  requireThat(directory, 'evidence_directory_required');
  return {
    async recordReceipt(receipt) { requireThat(receipt?.id, 'invalid_receipt'); return receipt; },
    async recordAction(action) { requireThat(action?.action, 'invalid_evidence_action'); return action; },
  };
}

export function createMemoryProvider({ memory } = {}) {
  requireThat(memory?.recall, 'memory_required');
  return { recall: options => memory.recall(options), hints: options => memory.hints(options) };
}

// The router is the explicit decision table for future A/B comparison
// (deterministic / JEV / CLM / DeepSeek Flash). It never executes anything; it
// returns the routing outcome and the chosen tool for the caller's executor.
export function createToolRouter({ registry, shortlister, scorer = null, economics = null,
  admission = null, memory = null } = {}) {
  requireThat(registry?.get && shortlister?.forCandidates, 'router_registry_required');
  const counters = { deterministic: 0, jev: 0, frontier: 0, human: 0, blocked: 0, redundant: 0, failed: 0 };
  return {
    counters,
    async route({ state = {}, candidates = [], observation = null, workflow = 'login',
      classifiedReason = null, goal = null, execution = null } = {}) {
      // A genuine security surface is always a person's job. Nothing here answers it.
      if (classifiedReason || state.challengeFrame === true) {
        counters.human++;
        return { outcome: 'human', tool: 'escalate_security_checkpoint', rationale: classifiedReason || 'challenge_frame' };
      }
      const shortlist = shortlister.forCandidates({ candidates, workflow,
        phase: workflow === 'recovery' ? 'recovery' : 'action' });
      if (!shortlist.length) {
        counters.blocked++;
        return { outcome: 'blocked', tool: null, rationale: 'no_permitted_candidates' };
      }
      const memoryHints = memory && observation
        ? await memory.recall({ reason: classifiedReason, url: observation.url,
          failedAction: execution?.previousFailedAction, limit: 2 }).catch(() => [])
        : [];
      const augmented = memoryHints.length && observation
        ? { ...observation, memory: memoryHints.map(episode => `${episode.reason}`
            + `${episode.statePath ? ` at ${episode.statePath}` : ''}`
            + `${episode.correction ? `: use ${episode.correction}` : ''}`) }
        : observation;
      // One permitted action is deterministic by construction and spends nothing.
      if (shortlist.length === 1) {
        counters.deterministic++;
        return { outcome: 'deterministic', tool: shortlist[0].tool, candidate: shortlist[0].candidate,
          rationale: 'single_permitted_candidate', memory: memoryHints };
      }
      if (scorer && (!economics || economics.canSpendModel())) {
        const scored = await scorer.score({ observation: augmented, shortlist, goal }).catch(() => ({ abstained: true, reason: 'scorer_error' }));
        if (!scored.abstained) {
          if (economics) economics.recordModel({ frontier: scored.source === 'frontier' });
          counters[scored.source === 'deterministic' ? 'deterministic' : 'jev']++;
          const admitted = admission ? admission.admit({ decision: scored, candidate: scored.candidate, workflow })
            : { admitted: true };
          if (!admitted.admitted) {
            counters.blocked++;
            return { outcome: 'blocked', tool: null, rationale: admitted.reason };
          }
          return { outcome: scored.source, tool: scored.candidate.tool, candidate: scored.candidate.candidate,
            method: scored.method, confidence: scored.confidence, memory: memoryHints };
        }
        // The cheap scorer did not decide; escalate rather than guess.
        counters.human++;
        return { outcome: 'human', tool: 'escalate_security_checkpoint',
          rationale: scored.reason || 'scorer_abstained', memory: memoryHints };
      }
      counters.human++;
      return { outcome: 'human', tool: 'escalate_security_checkpoint',
        rationale: economics ? 'model_budget_exhausted' : 'no_scorer', memory: memoryHints };
    },
    recordExecution({ outcome, succeeded }) {
      if (!succeeded) counters.failed++;
      if (outcome && ['deterministic', 'jev', 'frontier'].includes(outcome)) counters.redundant++;
    },
  };
}

export { decisionSourceFor };

// ---------------------------------------------------------------------------
// Observation mode. The router never controls a live action in this phase: it
// records what the deterministic executor already did and what the router's
// policy would have preferred, so real state → candidate → outcome data can be
// compared later across deterministic / JEV / CLM / DeepSeek Flash.
//
// One append-only NDJSON line per decision and per execution/outcome. Nothing
// here mutates a decision, calls a model, or records page text: candidates are
// reduced to their tool name, and descriptions are never stored.
export function createRouterObserver({ directory, now = Date.now, journal = null } = {}) {
  requireThat(typeof directory === 'string' && directory.length > 0, 'router_observer_directory_required');
  const path = resolve(directory, 'router-observations.ndjson');
  const summary = { decisions: 0, deterministicShortcuts: 0, modelDecisions: 0, agreements: 0,
    disagreements: 0, executions: 0, succeeded: 0, failed: 0, stale: 0, lastStateClass: null,
    executionChanged: false };
  let sequence = 0;
  let open = null;
  let lastExecution = null;
  const closed = new Set();
  const append = async record => {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await appendFile(path, `${JSON.stringify(record)}\n`, { mode: 0o600 });
  };
  // A journal is pure instrumentation: even a synchronous throw from a broken
  // implementation must not affect the decision, the observation record or the
  // job. Every call is wrapped.
  const journalSafely = async fn => { try { await fn(); } catch { /* instrumentation only */ } };
  const toolOf = description => /^([a-z][a-z0-9_]{1,47}):/.exec(String(description || ''))?.[1] || null;
  const stateClassFor = ({ phase, classifiedReason, tools }) => {
    if (classifiedReason) return `checkpoint:${classifiedReason}`;
    const names = new Set(tools.map(entry => entry.tool).filter(Boolean));
    if (names.has('fill_totp') || names.has('choose_totp') || names.has('try_another_way')) return 'authenticator_challenge';
    if (names.has('fill_username') || names.has('fill_password') || names.has('submit_login')) return 'login_form';
    if (names.has('open_account_menu') || names.has('open_switch_account')) return 'account_menu';
    if (names.has('retry_observation') || names.has('wait')) return 'unexpected_state';
    if (names.has('navigate_home')) return 'off_home';
    if (phase === 'jev_recovery') return 'recovery';
    if (phase === 'verify_reopen') return 'session_reopen';
    return 'other';
  };
  return {
    path,
    summary,
    // Called with exactly the request/decision pair the live chooser used. The
    // returned record is evidence; the caller's decision is untouched.
    async observeDecision({ phase = 'login', request = null, decision = null, step = null, jobId = null } = {}) {
      const actions = Array.isArray(request?.actions) ? request.actions : [];
      const tools = actions.map(action => ({ id: action.id, tool: toolOf(action.description) }));
      const chosenId = decision?.action?.id ?? null;
      const chosenIndex = tools.findIndex(entry => entry.id === chosenId);
      const topCandidate = tools[0]?.id ?? null;
      const agreed = topCandidate !== null && chosenId === topCandidate;
      const source = decision?.method === 'exact-single-match' ? 'deterministic'
        : phase === 'jev_recovery' ? 'jev' : 'none';
      sequence++;
      const record = { kind: 'decision', id: `d${sequence}`, at: new Date(now()).toISOString(),
        jobId, step: step ?? request?.step ?? null, phase,
        stateClass: stateClassFor({ phase, classifiedReason: request?.classifiedReason ?? null, tools }),
        candidateCount: tools.length, candidates: tools,
        // The deterministic-first policy the router would apply on its own; no
        // model call is made in observation mode, so confidence stays null.
        router: { policy: 'deterministic-first', topCandidate, agreed, confidence: null },
        chosen: { id: chosenId, tool: chosenIndex >= 0 ? tools[chosenIndex].tool : null,
          method: decision?.method ?? null, confidence: decision?.confidence ?? null,
          probability: decision?.probability ?? null },
        scorerSource: source, executionChanged: false };
      open = record;
      await append(record);
      summary.decisions++;
      if (agreed) summary.agreements++; else summary.disagreements++;
      if (source === 'deterministic') summary.deterministicShortcuts++; else if (source === 'jev') summary.modelDecisions++;
      summary.lastStateClass = record.stateClass;
      // Passive journal: the same evidence, in the flywheel's record shape. It is
      // best-effort by construction and cannot alter the decision or the record.
      if (journal) {
        await journalSafely(() => journal.decision({ phase, step: record.step, stateClass: record.stateClass,
          candidates: tools.map(entry => ({ id: entry.id, tool: entry.tool })),
          chosen: { id: chosenId, tool: record.chosen.tool },
          method: record.chosen.method, confidence: record.chosen.confidence, probability: record.chosen.probability,
          source, topCandidate, agreed }));
      }
      return record;
    },
    // Correlates the executor's own step events with the decision that preceded
    // them. Never alters them.
    async observeStep(detail = {}) {
      if (!detail || typeof detail !== 'object') return null;
      if (['login', 'verify_reopen', 'jev_recovery'].includes(detail.phase)) {
        if (!open) return null;
        if (detail.state === 'before') {
          const record = { kind: 'execution', decisionId: open.id, at: new Date(now()).toISOString(),
            phase: detail.phase, executed: { action: detail.action ?? null }, result: 'selected', succeeded: null };
          lastExecution = record;
          summary.executions++;
          await append(record);
          await journalSafely(() => journal.execution({ phase: detail.phase, action: detail.action ?? null, result: 'selected' }));
          return record;
        }
        if (detail.state === 'after') {
          const record = { kind: 'outcome', decisionId: open.id, at: new Date(now()).toISOString(),
            phase: detail.phase, executed: { action: detail.action ?? null }, result: 'dispatched', succeeded: true };
          closed.add(open.id); open = null; lastExecution = null;
          summary.succeeded++;
          await append(record);
          await journalSafely(() => journal.outcome({ phase: detail.phase, action: detail.action ?? null, succeeded: true }));
          return record;
        }
        if (detail.state === 'stale' || detail.state === 'stale_decision') {
          const record = { kind: 'outcome', decisionId: open.id, at: new Date(now()).toISOString(),
            phase: detail.phase, executed: { action: detail.action ?? null }, result: detail.state,
            succeeded: false, reason: 'reobserve' };
          closed.add(open.id); open = null; lastExecution = null;
          summary.stale++;
          await append(record);
          await journalSafely(() => journal.outcome({ phase: detail.phase, action: detail.action ?? null, succeeded: false,
            receipt: { state: 'failed', postconditionMet: false }, recovery: 'reobserve' }));
          return record;
        }
      }
      if (detail.phase === 'attention' && lastExecution && !closed.has(lastExecution.decisionId)) {
        const record = { kind: 'outcome', decisionId: lastExecution.decisionId, at: new Date(now()).toISOString(),
          phase: 'attention', executed: lastExecution.executed, result: 'failed',
          succeeded: false, reason: detail.reason || 'attention' };
        closed.add(lastExecution.decisionId); open = null; lastExecution = null;
        summary.failed++;
        await append(record);
        await journalSafely(() => journal.outcome({ phase: 'attention', action: record.executed?.action ?? null, succeeded: false,
          receipt: { state: 'failed', postconditionMet: false }, recovery: detail.reason || 'attention' }));
        return record;
      }
      return null;
    },
  };
}

// Wrap a live guide so every decision is observed without changing it. The
// wrapped function returns exactly the inner decision, including the
// exact-single-match shortcut, and preserves the metrics object.
export function wrapGuideForObservation(guide, observer) {
  requireThat(typeof guide === 'function', 'guide_required');
  if (!observer) return guide;
  const wrapped = async request => {
    const decision = await guide(request);
    await observer.observeDecision({ phase: request?.phase ?? 'login', request, decision,
      step: request?.step ?? null }).catch(() => {});
    return decision;
  };
  if (guide.metrics) wrapped.metrics = guide.metrics;
  return wrapped;
}
