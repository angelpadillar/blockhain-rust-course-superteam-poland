import { allowedUrl, allowedRequest, createBrowser, normalize, StaleBeforeDispatch } from '../browser-runtime-v3/browser.mjs';
import { runSearchAndOpen } from './search.mjs';

export class WorkflowError extends Error {
  constructor(code) { super(code); this.name = 'WorkflowError'; this.code = code; }
}
const requireValue = (condition, code) => { if (!condition) throw new WorkflowError(code); };
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const text = (value, max, empty = false) => typeof value === 'string' && (empty || value.trim().length > 0)
  && value.length <= max && !/[\x00-\x1f]/.test(value);

export function validatePlan(plan) {
  requireValue(object(plan) && Object.keys(plan).length === 1 && Array.isArray(plan.steps), 'invalid_plan');
  requireValue(plan.steps.length >= 1 && plan.steps.length <= 4, 'step_limit');
  return { steps: plan.steps.map(step => {
    requireValue(object(step) && ['search_and_open', 'open_link'].includes(step.operation), 'unsupported_operation');
    const keys = step.operation === 'search_and_open' ? ['operation', 'query', 'targetText', 'context'] : ['operation', 'targetText', 'context'];
    requireValue(Object.keys(step).every(key => keys.includes(key)), 'unsupported_step_field');
    requireValue(text(step.targetText, 240) && (step.context === undefined || text(step.context, 160, true))
      && (step.operation !== 'search_and_open' || text(step.query, 240)), 'invalid_step');
    return { operation: step.operation, ...(step.operation === 'search_and_open' ? { query: step.query.trim() } : {}),
      targetText: step.targetText.trim(), ...(step.context?.trim() ? { context: step.context.trim() } : {}) };
  }) };
}

function freshMetrics() {
  return { totalMs: 0, observationMs: 0, executionMs: 0, conditionWaitMs: 0, settlingMs: 0, chooserMs: 0, eventMs: 0,
    explicitProtocolCalls: 0, observations: 0, revalidations: 0, browserScans: 0, observerWakeups: 0,
    nativeActionAttempts: 0, nativeActionsCompleted: 0, fillAttempts: 0, pressAttempts: 0, clickAttempts: 0,
    chooserCalls: 0, staleRefreshes: 0, blockedRequests: 0 };
}
function mergeMetrics(target, source) {
  for (const key of Object.keys(target)) if (key !== 'totalMs' && Number.isFinite(source?.[key])) target[key] += source[key];
}
const knownReasons = new Set(['action_limit', 'time_limit', 'aborted', 'outside_navigation_scope', 'forbidden_request',
  'download_blocked', 'popup_blocked', 'event_sink_failed', 'no_search_control', 'no_exact_result', 'no_exact_link',
  'ambiguous_search', 'ambiguous_result', 'context_unresolved', 'chooser_invalid_ref', 'stale_limit', 'unsupported_submission',
  'results_timeout', 'empty_results', 'open_not_observed', 'postcondition_failed', 'uncertain_execution', 'browser_error',
  'model_call_budget', 'model_cost_budget', 'previous_usage_incomplete', 'provider_network_error',
  'provider_usage_or_cost_missing', 'invalid_model_reference', 'cancelled', 'cancelled_or_timed_out']);
function reasonFor(error) { return knownReasons.has(error?.code) ? error.code : 'browser_error'; }
function permittedContext(snapshot, step, origin) {
  return { origin, title: snapshot?.data?.title || '', requestedStep: { ...step },
    permittedOperations: ['search_and_open', 'open_link'],
    controls: (snapshot?.data?.controls || []).slice(0, 20).map(control => ({ what: control.what, role: control.role,
      where: [...control.where], supports: [...control.supports] })),
    observationScope: 'Last observed permitted controls; reacquire before any future action.', independentlyVerified: false };
}

/** Execute a bounded, already compiled plan. Completion is step evidence, never
 * independent proof of the user's complete task. No destination answers enter
 * the policy, and no model roundtrip is inserted between deterministic steps. */
export async function runWorkflow({ page, plan: suppliedPlan, choose, onEvent = async () => {}, signal,
  maxMs = 30000, maxActions = 12 }) {
  const plan = validatePlan(suppliedPlan);
  requireValue(Number.isFinite(maxMs) && maxMs >= 100 && maxMs <= 60000
    && Number.isInteger(maxActions) && maxActions >= 1 && maxActions <= 20, 'invalid_workflow_limits');
  const started = performance.now(), stop = new AbortController();
  const combined = AbortSignal.any([stop.signal, AbortSignal.timeout(Math.ceil(maxMs)), ...(signal ? [signal] : [])]);
  const origin = new URL(page.url()).origin;
  requireValue(allowedUrl(page.url(), origin), 'outside_navigation_scope');
  const metrics = freshMetrics(), steps = [], events = [];
  let installed = false, status = 'incomplete', reason = null, failedStep = null, escalation = null;
  let final = { url: page.url(), title: '' }, sinkFailed = false;
  const remaining = () => Math.max(0, maxMs - (performance.now() - started));
  const check = () => {
    combined.throwIfAborted();
    if (remaining() < 1) throw new WorkflowError('time_limit');
    if (!allowedUrl(page.url(), origin)) throw new WorkflowError('outside_navigation_scope');
  };
  const abortReason = error => error?.code === 'uncertain_execution' ? 'uncertain_execution'
    : sinkFailed ? 'event_sink_failed' : stop.signal.aborted ? reasonFor(stop.signal.reason)
      : signal?.aborted ? 'aborted' : combined.aborted ? 'time_limit' : reasonFor(error);
  async function bounded(operation) {
    check();
    return new Promise((resolve, reject) => {
      const aborted = () => reject(combined.reason);
      combined.addEventListener('abort', aborted, { once: true });
      Promise.resolve().then(() => { check(); return operation(); }).then(resolve, reject).finally(() => combined.removeEventListener('abort', aborted));
    });
  }
  async function emit(type, detail = {}) {
    check();
    const event = { ...detail, type, elapsedMs: performance.now() - started };
    events.push(event);
    const before = performance.now();
    try { await bounded(() => onEvent(event)); }
    catch (error) {
      if (combined.aborted) throw error;
      sinkFailed = true; stop.abort(new WorkflowError('event_sink_failed')); throw new WorkflowError('event_sink_failed');
    } finally { metrics.eventMs += performance.now() - before; }
  }
  const guard = async route => {
    const request = route.request(); metrics.explicitProtocolCalls++;
    if (combined.aborted || !allowedRequest({ url: request.url(), method: request.method(),
      navigation: request.isNavigationRequest(), resourceType: request.resourceType() }, origin)) {
      if (!combined.aborted) { metrics.blockedRequests++; stop.abort(new WorkflowError('forbidden_request')); }
      await route.abort().catch(() => {});
    } else await route.fallback().catch(() => {});
  };
  const download = item => { stop.abort(new WorkflowError('download_blocked')); metrics.explicitProtocolCalls++; void item.cancel().catch(() => {}); };
  const popup = item => { stop.abort(new WorkflowError('popup_blocked')); metrics.explicitProtocolCalls++; void item.close().catch(() => {}); };
  try {
    check(); metrics.explicitProtocolCalls++; await page.route('**/*', guard); installed = true;
    page.on('download', download); page.on('popup', popup);
    await emit('workflow_started', { plannedSteps: plan.steps.length });
    for (const [index, step] of plan.steps.entries()) {
      const stepStarted = performance.now(), stepMetrics = freshMetrics();
      const row = { step: index + 1, operation: step.operation, targetText: step.targetText,
        status: 'incomplete', reason: null, evidence: null, metrics: stepMetrics };
      steps.push(row); failedStep = row.step;
      const task = { query: step.query || step.targetText, targetText: step.targetText, ...(step.context ? { context: step.context } : {}) };
      const browser = createBrowser(page, origin, task, stepMetrics, combined);
      let snapshot, baseline;
      async function capture(options = {}) {
        check(); snapshot = await browser.capture(options);
        final = { url: snapshot.data.url, title: snapshot.data.title };
        return snapshot;
      }
      async function selectLink(snap) {
        let candidates = browser.candidates(snap, 'result').filter(candidate => normalize(candidate.what) === normalize(step.targetText));
        let contextUnresolved = false;
        if (step.context) {
          const scoped = candidates.filter(candidate => candidate.where.some(where => normalize(where) === normalize(step.context)));
          if (scoped.length) candidates = scoped;
          else contextUnresolved = true;
        }
        if (!candidates.length) throw new WorkflowError('no_exact_link');
        if (candidates.length === 1 && !contextUnresolved) return candidates[0];
        if (!choose) throw new WorkflowError(contextUnresolved ? 'context_unresolved' : 'ambiguous_result');
        const before = performance.now(); stepMetrics.chooserCalls++;
        let ref;
        try {
          ref = await bounded(() => choose({ kind: 'result', candidates, task,
            observation: { title: snap.data.title, origin, controls: snap.data.controls.length,
              searchControls: browser.candidates(snap, 'search').length, resultLinks: browser.candidates(snap, 'result').length }, signal: combined }));
        } finally { stepMetrics.chooserMs += performance.now() - before; }
        check();
        const candidate = candidates.find(item => item.ref === ref);
        if (!candidate) throw new WorkflowError('chooser_invalid_ref');
        return candidate;
      }
      async function openLink() {
        let selected = await selectLink(snapshot);
        for (;;) {
          check();
          if (metrics.nativeActionAttempts + stepMetrics.nativeActionAttempts >= maxActions) throw new WorkflowError('action_limit');
          await emit('action_planned', { step: row.step, operation: step.operation, kind: 'click', ref: selected.ref });
          try {
            const before = await browser.execute(snapshot, selected, 'click', '', Math.min(3000, remaining()));
            await emit('action_completed', { step: row.step, operation: step.operation, kind: 'click', ref: selected.ref });
            return before;
          } catch (error) {
            if (!(error instanceof StaleBeforeDispatch)) throw error;
            if (stepMetrics.staleRefreshes >= 2) throw new WorkflowError('stale_limit');
            stepMetrics.staleRefreshes++;
            await emit('stale_refreshed', { step: row.step, operation: step.operation, kind: 'click' });
            await capture(); selected = await selectLink(snapshot);
          }
        }
      }
      async function postcondition(before) {
        const waiting = performance.now();
        try {
          while (remaining() > 0) {
            check();
            try {
              const observed = await capture({ baseline: before, goal: 'opened', waitMs: Math.min(300, remaining()),
                beforeUrl: before.data.url, beforeTitle: before.data.title, beforeTargetHeading: before.data.targetHeading });
              const evidence = { before: { url: baseline.data.url, title: baseline.data.title }, after: { ...final },
                urlChanged: observed.data.url !== baseline.data.url, visibleExactHeading: observed.data.targetHeading,
                originPreserved: allowedUrl(observed.data.url, origin), independentlyVerified: false };
              row.evidence = evidence;
              if (evidence.urlChanged && evidence.visibleExactHeading && evidence.originPreserved) return;
              // A SPA may render its heading before pushState. Waiting for a
              // browser navigation condition catches URL-only changes without
              // repeatedly scanning a DOM whose heading is already ready.
              if (observed.data.ready && !evidence.urlChanged) {
                stepMetrics.explicitProtocolCalls++;
                try {
                  await bounded(() => page.waitForURL(url => url.href !== baseline.data.url,
                    { waitUntil: 'commit', timeout: Math.max(1, Math.ceil(remaining())) }));
                } catch (error) {
                  if (combined.aborted) throw error;
                  if (error.name === 'TimeoutError') throw new WorkflowError('postcondition_failed');
                  throw error;
                }
              }
            } catch (error) {
              if (!/Execution context was destroyed|Cannot find context|different JavaScript context/.test(error.message || '')) throw error;
            }
          }
          throw new WorkflowError('postcondition_failed');
        } finally { stepMetrics.conditionWaitMs += performance.now() - waiting; }
      }
      try {
        check();
        if (metrics.nativeActionAttempts >= maxActions) throw new WorkflowError('action_limit');
        await emit('step_started', { step: row.step, operation: step.operation, targetText: step.targetText });
        baseline = await capture();
        if (step.operation === 'search_and_open') {
          if (remaining() < 100) throw new WorkflowError('time_limit');
          const result = await runSearchAndOpen({ page, task, choose, signal: combined, mode: 'fast',
            maxMs: Math.floor(remaining()), maxActions: maxActions - metrics.nativeActionAttempts,
            onEvent: event => emit(event.type, { ...event, step: row.step, operation: step.operation, stepElapsedMs: event.elapsedMs }) });
          mergeMetrics(stepMetrics, result.metrics);
          // Child event time is already included in the workflow event counter.
          stepMetrics.eventMs -= result.metrics.eventMs;
          row.runtimeStatus = result.status;
          if (result.status !== 'opened') throw new WorkflowError(knownReasons.has(result.reason) ? result.reason : 'browser_error');
          await postcondition(baseline);
        } else {
          const beforeClick = await openLink();
          await postcondition(beforeClick);
        }
        row.status = 'completed';
        await emit('step_completed', { step: row.step, operation: step.operation, evidence: row.evidence });
      } catch (error) {
        row.status = 'incomplete'; row.reason = abortReason(error);
        escalation = { reason: row.reason, failedStep: row.step, permittedContext: permittedContext(snapshot, step, origin),
          completedSteps: steps.filter(item => item.status === 'completed').map(item => ({ step: item.step, operation: item.operation, targetText: item.targetText })),
          uncertainAction: row.reason === 'uncertain_execution', automaticRetryAllowed: false };
        throw error;
      } finally {
        await browser.dispose();
        stepMetrics.totalMs = performance.now() - stepStarted;
        mergeMetrics(metrics, stepMetrics);
      }
    }
    await emit('workflow_completed', { completedSteps: steps.length, independentlyVerified: false });
    status = 'completed'; failedStep = null;
  } catch (error) {
    reason = abortReason(error);
    failedStep ||= Math.min(steps.length + 1, plan.steps.length);
    escalation ||= { reason, failedStep, permittedContext: permittedContext({ data: { title: final.title, controls: [] } }, plan.steps[failedStep - 1], origin),
      completedSteps: steps.filter(item => item.status === 'completed').map(item => ({ step: item.step, operation: item.operation, targetText: item.targetText })),
      uncertainAction: reason === 'uncertain_execution', automaticRetryAllowed: false };
  }
  finally {
    page.removeListener('download', download); page.removeListener('popup', popup);
    if (installed) { metrics.explicitProtocolCalls++; await page.unroute('**/*', guard).catch(() => {}); }
    metrics.totalMs = performance.now() - started;
  }
  return { status, reason, failedStep, steps, metrics, final, events, escalation, independentlyVerified: false,
    scope: 'At most four compiled native search/open or exact-link steps; each requires a changed URL and an observed exact target heading. Completion is not independent task verification.',
    metricScope: 'Counters add explicit wrapper and v3 operations; internal Playwright traffic is excluded. Observation includes browser waits, and condition/event/request timing can overlap. Journal event time is recorded at workflow level, not added again to step eventMs. No fixed inter-step settling or model calls are added.' };
}
