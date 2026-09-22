import { PilotError, requireThat, errorCode } from './core.mjs';
import { captureSafeScreenshot } from './screenshots.mjs';

// The internal decision abstraction. An advisor PROPOSES a BrowserAction; the
// kernel authorizes and executes it. No advisor performs a browser operation, and
// no advisor may widen the permitted set, the risk class or the workflow's roles.
//
//   L1 deterministic  - the flow decides; zero model calls
//   L2 Jev            - the existing finite-choice path (TypeSafe/Fireworks text)
//   L3 frontier vision- visual escalation, at most 3 per episode, screenshot only here
//   L4 operator       - a genuine external verification only a person can complete
export const advisorLevels = ['deterministic', 'jev', 'frontier', 'operator'];
export const maxVisualEscalations = 3;

export function createAdvisor({ name, level, advise, metrics = null }) {
  requireThat(typeof name === 'string' && name.length > 0, 'invalid_advisor_name');
  requireThat(advisorLevels.includes(level), 'unsupported_advisor_level');
  requireThat(typeof advise === 'function', 'advisor_advise_required');
  return { name, level, advise, metrics };
}

export const asAbstain = reason => ({ abstained: true, reason });
export const isAbstain = result => !result || result.abstained === true || !result.candidate;

// The existing Jev path, unchanged, behind the advisor interface. Its metrics are
// the same counters the run report already carries.
export function createJevAdvisor({ choose, minConfidence = 0.8, name = 'jev' } = {}) {
  requireThat(typeof choose === 'function', 'advisor_choose_required');
  const metrics = { calls: 0, abstained: 0, escalated: 0 };
  return createAdvisor({ name, level: 'jev', metrics,
    advise: async ({ page = null, permittedActions = [], visualEvidenceRequired = false } = {}) => {
      if (visualEvidenceRequired) { metrics.escalated++; return asAbstain('visual_evidence_required'); }
      if (!permittedActions.length) return asAbstain('no_permitted_actions');
      metrics.calls++;
      let decision;
      try {
        decision = await choose({ page, actions: permittedActions.map(({ id, description }) => ({ id, description })) });
      } catch (error) {
        metrics.abstained++;
        return asAbstain(errorCode(error));
      }
      const candidate = permittedActions.find(item => item.id === decision?.action?.id);
      if (!candidate) { metrics.abstained++; return asAbstain('jev_unknown_action'); }
      // Low confidence is an abstain: it escalates rather than being accepted.
      if (Number.isFinite(decision.confidence) && decision.confidence < minConfidence) {
        metrics.escalated++; return asAbstain('jev_low_confidence');
      }
      return { candidate, method: decision.method ?? 'jev', confidence: decision.confidence ?? null,
        probability: decision.probability ?? null, reason: decision.reason ?? null };
    } });
}

// Captures the ONE fresh screenshot an L3 escalation is allowed to use. It reuses
// the existing safe capture, so a credential-entry page is never captured.
export function createVisionScreenshotter({ page, directory, credentialOrigins = [], counter = { index: 0 } }) {
  requireThat(page && typeof page.screenshot === 'function', 'screenshot_page_required');
  return async ({ observation }) => {
    counter.index++;
    const result = await captureSafeScreenshot({ page, directory, label: `vision-epoch-${observation.epoch.slice(0, 8)}`,
      index: counter.index, credentialOrigins });
    return { ...result, epoch: observation.epoch };
  };
}

// L3. The provider is NOT connected here: an implementation must be injected as
// `vision` = { capture({observation}) -> screenshot, decide({...}) -> {actionId} }.
// Without one, this advisor always abstains, which is the current state.
export function createFrontierVisionAdvisor({ vision = null, maxEscalations = maxVisualEscalations,
  name = 'frontier-vision' } = {}) {
  const metrics = { escalations: 0, screenshots: 0, calls: 0, abstained: 0 };
  return createAdvisor({ name, level: 'frontier', metrics,
    advise: async ({ goal = null, page = null, observation = null, permittedActions = [],
      episode = null } = {}) => {
      // A screenshot decision is bound to the epoch it was taken on.
      if (!observation?.epoch) return asAbstain('observation_required');
      if (!vision) return asAbstain('frontier_not_configured');
      // An unconfigured provider is reported as such and never even screenshots.
      if (typeof vision.available === 'function' && (await vision.available()) === false) {
        return asAbstain('frontier_unavailable');
      }
      if (!permittedActions.length) return asAbstain('no_permitted_actions');
      const used = episode?.escalations ?? metrics.escalations;
      if (used >= maxEscalations) return asAbstain('visual_escalation_budget_exhausted');
      if (metrics.escalations >= maxEscalations) return asAbstain('visual_escalation_budget_exhausted');

      metrics.escalations++; metrics.screenshots++;
      const screenshot = await vision.capture({ observation });
      let decision;
      try {
        metrics.calls++;
        decision = await vision.decide({ goal, observation, page, screenshot,
          permittedActions: permittedActions.map(({ id, description, kind }) => ({ id, description, kind })) });
      } catch (error) {
        metrics.abstained++; return asAbstain(errorCode(error));
      }
      if (decision?.abstain === true || !decision) { metrics.abstained++; return asAbstain('frontier_abstained'); }
      if (decision?.humanVerificationRequired === true) {
        // A person is required: the frontier may say so, but it never solves it.
        return { humanVerificationRequired: true, reason: decision.reason ?? null,
          decisionEpoch: observation.epoch,
          screenshot: { id: screenshot?.name ?? screenshot?.id ?? null, epoch: observation.epoch } };
      }
      const candidate = permittedActions.find(item => item.id === decision.actionId);
      if (!candidate) { metrics.abstained++; return asAbstain('frontier_action_not_permitted'); }
      return { candidate, method: 'frontier-vision', confidence: decision.confidence ?? null,
        reason: decision.reason ?? null, decisionEpoch: observation.epoch,
        screenshot: { id: screenshot?.name ?? screenshot?.id ?? null, epoch: observation.epoch } };
    } });
}

// The chain is the L1..L4 policy. It returns the same decision shape the login
// flow already consumes, so it can be handed in as `choose`, and it adds the
// epoch and screenshot evidence an L3 decision must carry.
export function createAdvisorChain({ jev = null, frontier = null, maxEscalations = maxVisualEscalations,
  classifySecurityCheckpoint = null, onStep = async () => {}, l3Triggers = null } = {}) {
  const metrics = { deterministic: 0, jev: 0, frontier: 0, operator: 0, abstained: 0, escalations: 0 };
  const guide = async request => {
    const { goal = null, page = null, actions = [], observation = null, snapshot = null,
      classifiedReason = null, visualEvidenceRequired = false, episode = null,
      trigger = null } = request || {};
    requireThat(Array.isArray(actions) && actions.length > 0, 'invalid_action_candidates');

    // L1: one permitted action needs no model at all.
    if (actions.length === 1) {
      metrics.deterministic++;
      return { action: actions[0], method: 'exact-single-match', confidence: null, probability: null,
        episode: episode || { escalations: 0 } };
    }

    // A genuine external verification is L4. Vision never solves a challenge, so
    // L3 is not even considered for a classified checkpoint page.
    const checkpoint = classifiedReason
      || (classifySecurityCheckpoint && snapshot ? classifySecurityCheckpoint(snapshot) : null);
    if (checkpoint) {
      metrics.operator++;
      await onStep({ phase: 'advisor', level: 'operator', reason: checkpoint, state: 'required' });
      const error = new PilotError('advisor_requested_operator');
      error.reason = checkpoint;
      throw error;
    }

    if (jev) {
      const advised = await jev.advise({ goal, page, observation, permittedActions: actions, episode,
        visualEvidenceRequired });
      if (!isAbstain(advised)) {
        metrics.jev++;
        await onStep({ phase: 'advisor', level: jev.level, action: advised.candidate.id,
          confidence: advised.confidence, method: advised.method });
        return { ...decisionOf(advised), episode: episode || { escalations: 0 } };
      }
      await onStep({ phase: 'advisor', level: jev.level, state: 'abstained', reason: advised.reason });
    }

    if (frontier) {
      // L3 runs only for a reason that may escalate. Jev abstaining is itself the
      // default reason; an explicit trigger must be one of the allowed ones.
      const escalationTrigger = trigger || (jev ? 'jev_abstained' : null);
      if (l3Triggers && !l3Triggers.includes(escalationTrigger)) {
        await onStep({ phase: 'advisor', level: frontier.level, state: 'abstained',
          reason: 'l3_trigger_not_allowed', trigger: escalationTrigger });
        metrics.abstained++;
        throw new PilotError('no_advisor_decision');
      }
      const used = { escalations: episode?.escalations ?? metrics.escalations };
      const advised = await frontier.advise({ goal, page, observation, permittedActions: actions,
        episode: used, visualEvidenceRequired, trigger: escalationTrigger });
      if (advised?.humanVerificationRequired === true) {
        // The frontier detected a challenge. It is classified, not solved: the flow
        // preserves the session and enters L4 with the operator.
        metrics.operator++;
        await onStep({ phase: 'advisor', level: frontier.level, state: 'human_verification_required',
          reason: advised.reason ?? null, screenshotEpoch: advised.screenshot?.epoch ?? null });
        const error = new PilotError('advisor_requested_operator');
        error.reason = 'human_verification_required';
        throw error;
      }
      if (!isAbstain(advised)) {
        metrics.frontier++; metrics.escalations = used.escalations + 1;
        await onStep({ phase: 'advisor', level: frontier.level, action: advised.candidate.id,
          confidence: advised.confidence, method: advised.method,
          screenshotEpoch: advised.screenshot?.epoch ?? null, screenshot: advised.screenshot?.id ?? null });
        return { ...decisionOf(advised), decisionEpoch: advised.decisionEpoch ?? null,
          screenshot: advised.screenshot ?? null, episode: { escalations: used.escalations + 1 } };
      }
      await onStep({ phase: 'advisor', level: frontier.level, state: 'abstained', reason: advised.reason });
    }

    // No level could decide: fail closed rather than guessing.
    metrics.abstained++;
    throw new PilotError('no_advisor_decision');
  };
  guide.metrics = metrics;
  guide.advisors = { jev, frontier };
  guide.maxVisualEscalations = maxEscalations;
  return guide;
}

function decisionOf(advised) {
  return { action: advised.candidate, method: advised.method ?? null, confidence: advised.confidence ?? null,
    probability: advised.probability ?? null, reason: advised.reason ?? null };
}

// An unconnected vision stub: the frontier provider is not wired up yet, and the
// interface must abstain rather than improvise.
export function createStubVision() {
  return { capture: async () => ({ skipped: 'frontier_not_configured' }),
    decide: async () => ({ abstain: true, reason: 'frontier_not_configured' }) };
}
