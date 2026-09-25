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
