// The stepwise browser loop. One Jev request per step picks the operation and
// speculatively all per-operation targets; deterministic handlers and
// done-when checks run in code around it. Executed targets are revalidated
// against a fresh scan before dispatch; uncertain executions are never
// replayed. Completion requires the deterministic done-when contract — a
// model's "done" is only ever an advisory signal.
import { createSession, StaleBeforeDispatch } from './session.mjs';
import { buildStepRequest, resolveStep } from './questions.mjs';
import { validateSpec, constrain } from './policy.mjs';
import { checkDoneWhen } from './donewhen.mjs';

export class RuntimeError extends Error {
  constructor(code) { super(code); this.name = 'RuntimeError'; this.code = code; }
}
const requireValue = (ok, code) => { if (!ok) throw new RuntimeError(code); };
const norm = value => String(value || '').normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase();

const KNOWN_REASONS = new Set(['action_limit', 'step_limit', 'time_limit', 'aborted', 'outside_navigation_scope',
  'forbidden_request', 'download_blocked', 'popup_blocked', 'event_sink_failed', 'uncertain_execution',
  'stale_limit', 'browser_error', 'invalid_model_answer', 'invalid_spec', 'target_unresolved', 'done_unverified',
  'destructive_blocked', 'model_blocked', 'model_call_budget', 'cancelled', 'cancelled_or_timed_out',
  'provider_network_error', 'provider_usage_missing', 'no_candidates', 'repeated_action_limit',
  'model_cost_budget', 'previous_usage_incomplete',
  'browser_challenge', 'merchant_site_unavailable', 'unexpected_age_confirmation_terms',
  'unexpected_age_confirmation_controls', 'age_confirmation_not_authorized_for_case', 'age_confirmation_requires_user',
  'age_confirmation_wrong_store', 'age_confirmation_dialog_not_found']);

function allowedRequest(request, origin) {
  if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method())) return false;
  try {
    const url = new URL(request.url());
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return false;
    if (url.origin === origin) return true;
    // Cross-origin is limited to passive static subresources, never navigation.
    return !request.isNavigationRequest() && ['GET', 'HEAD'].includes(request.method())
      && ['stylesheet', 'image', 'font', 'script', 'media', 'manifest', 'texttrack'].includes(request.resourceType());
  } catch { return false; }
}

function freshMetrics() {
  return { totalMs: 0, snapMs: 0, pickMs: 0, actMs: 0, settleMs: 0, eventMs: 0,
    protocolCalls: 0, observations: 0, revalidations: 0, browserScans: 0, observerWakeups: 0,
    nativeActionAttempts: 0, nativeActionsCompleted: 0,
    jevCalls: 0, unsurePicks: 0, abstains: 0, wastedSteps: 0, deterministicSteps: 0,
    staleRefreshes: 0, blockedRequests: 0, prematureDone: 0 };
}

/** Run one goal to its deterministic finish or a bounded stop.
 * `decide(request, signal)` is the injected Jev client; `spec` is validated
 * by policy.mjs; `onEvent` is the durable-event sink (a failed write stops
 * the run, matching the journaled-execution invariant). */
export async function runLoop({ page, spec: rawSpec, decide, onEvent = async () => {}, signal,
  maxSteps = 30, maxActions = 40, maxMs = 90000, maxModelCalls = 40,
  allowedUrl: allowedUrlOption, requestFilter } = {}) {
  const spec = validateSpec(rawSpec);
  requireValue(typeof decide === 'function', 'decider_required');
  requireValue(Number.isInteger(maxSteps) && maxSteps >= 1 && maxSteps <= 60
    && Number.isInteger(maxActions) && maxActions >= 1 && maxActions <= 80
    && Number.isFinite(maxMs) && maxMs >= 1000 && maxMs <= 300000
    && Number.isInteger(maxModelCalls) && maxModelCalls >= 0 && maxModelCalls <= 80, 'invalid_limits');
  const started = performance.now(), stop = new AbortController();
  const combined = AbortSignal.any([stop.signal, AbortSignal.timeout(Math.ceil(maxMs)), ...(signal ? [signal] : [])]);
  const origin = new URL(page.url()).origin;
  const metrics = freshMetrics(), steps = [], events = [], history = [];
  const denyPathRegex = spec.policy.denyPath ? new RegExp(`\\/(?:${spec.policy.denyPath})(?:\\/|$)`, 'i') : null;
  const allowedUrl = allowedUrlOption || (url => {
    try {
      const u = new URL(url);
      return ['http:', 'https:'].includes(u.protocol) && u.origin === origin && !u.username && !u.password
        && !(denyPathRegex && denyPathRegex.test(u.pathname));
    } catch { return false; }
  });
  requireValue(allowedUrl(page.url()), 'outside_navigation_scope');
  const session = createSession(page, origin, { targetText: spec.targetText }, metrics, combined,
    { deny: spec.policy.deny, denyPath: spec.policy.denyPath, allowedUrl, cap: spec.cap ?? 120,
      extraSelector: spec.extraControls || '', componentSelector: spec.componentSelector || '',
      purposeMap: spec.purposeMap || null });
  let installed = false, status = 'incomplete', reason = null, escalation = null, snapshot = null;
  let final = { url: page.url(), title: '' }, sinkFailed = false, consecutiveAbstains = 0, consecutiveWaits = 0, prematureDoneCount = 0, emptySnaps = 0;
  const remaining = () => Math.max(0, maxMs - (performance.now() - started));
  const check = () => {
    combined.throwIfAborted();
    if (remaining() < 1) throw new RuntimeError('time_limit');
    if (!allowedUrl(page.url())) throw new RuntimeError('outside_navigation_scope');
  };
  const abortReason = error => error?.code === 'uncertain_execution' ? 'uncertain_execution'
    : sinkFailed ? 'event_sink_failed' : stop.signal.reason?.code && KNOWN_REASONS.has(stop.signal.reason.code) ? stop.signal.reason.code
      : signal?.aborted ? 'aborted' : combined.aborted ? 'time_limit'
        : KNOWN_REASONS.has(error?.code) ? error.code : 'browser_error';
  async function bounded(operation) {
    check();
    return new Promise((resolve, reject) => {
      const aborted = () => reject(combined.reason);
      combined.addEventListener('abort', aborted, { once: true });
      Promise.resolve().then(() => { check(); return operation(); }).then(resolve, reject)
        .finally(() => combined.removeEventListener('abort', aborted));
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
      sinkFailed = true; stop.abort(new RuntimeError('event_sink_failed')); throw new RuntimeError('event_sink_failed');
    } finally { metrics.eventMs += performance.now() - before; }
  }
  const guard = async route => {
    const request = route.request();
    metrics.protocolCalls++;
    // A site adapter's filter owns the verdict: 'allow' continues, 'deny'
    // quietly aborts the request (e.g. a tracker's iframe navigation —
    // counted, never fatal), 'fatal' stops the run. undefined falls
    // through to the default same-origin/static rule, whose denial is fatal.
    const verdict = requestFilter
      ? await requestFilter(request, { mainFrame: request.frame() === page.mainFrame() }) : undefined;
    const allowed = verdict === undefined ? allowedRequest(request, origin) : verdict === 'allow';
    if (combined.aborted || !allowed || verdict === 'fatal') {
      metrics.blockedRequests++;
      if (!combined.aborted && verdict !== 'deny') stop.abort(new RuntimeError('forbidden_request'));
      await route.abort().catch(() => {});
    } else await route.fallback().catch(() => {});
  };
  const download = item => { stop.abort(new RuntimeError('download_blocked')); metrics.protocolCalls++; void item.cancel().catch(() => {}); };
  const popup = item => { stop.abort(new RuntimeError('popup_blocked')); metrics.protocolCalls++; void item.close().catch(() => {}); };

  async function capture(options = {}) {
    check();
    // An in-flight navigation can destroy the execution context mid-evaluate;
    // that is a transient page state, not a failure — observe again.
    for (let attempt = 0; ; attempt++) {
      try {
        snapshot = await session.capture(options);
        break;
      } catch (error) {
        if (attempt >= 2 || !/Execution context was destroyed|Cannot find context|different JavaScript context/.test(error.message || '')) throw error;
        await new Promise(resolve => setTimeout(resolve, 150));
      }
    }
    final = { url: snapshot.data.url, title: snapshot.data.title };
    return snapshot;
  }
  function permittedContext(stepRow) {
    return { origin, title: snapshot?.data?.title || '', goal: spec.goal,
      controls: (snapshot?.data?.controls || []).slice(0, 20).map(control => ({ what: control.what, role: control.role,
        kind: control.kind, where: [...control.where], component: control.component, supports: [...control.supports] })),
      observationScope: 'Last observed permitted controls; reacquire before any future action.',
      lastStep: stepRow ? { operation: stepRow.operation, target: stepRow.what } : null,
      independentlyVerified: false };
  }
  const rebindKey = candidate => norm([candidate.kind, candidate.what, candidate.component?.label || '', candidate.href || ''].join('|'));
  async function postcondition(before, goal, waitMs) {
    const waiting = performance.now();
    try {
      while (remaining() > 0) {
        check();
        try {
          const observed = await capture({ baseline: before, goal, waitMs: Math.min(waitMs, remaining()) });
          if (observed.data.ready) return observed;
          return observed; // A bounded wait that expires still returns state; the next step observes it.
        } catch (error) {
          if (!/Execution context was destroyed|Cannot find context|different JavaScript context/.test(error.message || '')) throw error;
        }
      }
      return null;
    } finally { metrics.settleMs += performance.now() - waiting; }
  }
  function heads(snap) {
    // Adapter scoping runs before policy avoid: it is the trusted caller's
    // candidate contract (e.g. Glovo only ever offers the target store's
    // links and the exact product tile). Both filters intersect.
    const allowed = spec.filterControls ? spec.filterControls(snap.data, snap.data.controls) : snap.data.controls;
    requireValue(Array.isArray(allowed), 'invalid_spec');
    const click = constrain(allowed.filter(c => c.supports.includes('click')), spec.policy)
      .map(c => ({ ref: `s${snap.id}:e${c.nodeIndex}`, control: c }));
    const fill = constrain(allowed.filter(c => c.supports.includes('fill')), spec.policy)
      .map(c => ({ ref: `s${snap.id}:e${c.nodeIndex}`, control: c }));
    const press = constrain(allowed.filter(c => c.supports.includes('press')), spec.policy)
      .map(c => ({ ref: `s${snap.id}:e${c.nodeIndex}`, control: c }));
    const select = constrain(allowed.filter(c => c.supports.includes('select')), spec.policy)
      .flatMap(c => (c.options?.length ? c.options : [{ index: null, label: '' }])
        .map(option => ({ ref: `s${snap.id}:e${c.nodeIndex}${option.index === null ? '' : `:o${option.index}`}`,
          control: c, option: option.index === null ? null : option.index,
          what: option.index === null ? c.what : `${c.what} → ${option.label}` })));
    const map = list => list.map(item => ({ ...item, what: item.what ?? item.control.what, component: item.control.component,
      where: item.control.where, role: item.control.role, kind: item.control.kind }));
    return { click: map(click), fill: map(fill), press: map(press), select: map(select) };
  }
  function resolveCandidate(list, ref) {
    return list.find(item => item.ref === ref) || null;
  }

  try {
    metrics.protocolCalls++;
    await page.route('**/*', guard); installed = true;
    page.on('download', download); page.on('popup', popup);
    await emit('loop_started', { goal: spec.goal, maxSteps });
    for (let stepNumber = 1; stepNumber <= maxSteps; stepNumber++) {
      const row = { step: stepNumber, picker: 'jev', operation: null, ref: null, what: null,
        snapMs: 0, pickMs: 0, actMs: 0, settleMs: 0, unsure: false, outcome: null };
      steps.push(row);
      // ---- observe ----
      const snapStart = performance.now();
      snapshot = await capture();
      row.snapMs = performance.now() - snapStart;
      // ---- deterministic handlers (known screens decided in code) ----
      let handled = false;
      for (const handler of spec.handlers) {
        check();
        if (handler.when(snapshot.data)) {
          const before = metrics.nativeActionAttempts;
          await emit('handler_fired', { step: stepNumber, name: handler.name });
          const acted = await bounded(() => handler.act({ session, snapshot, page, signal: combined }));
          // 'retry': the screen was mid-transition (dialog animating, node
          // detached) — re-observe next step, on its own bounded budget
          // (separate from dispatch staleness — both mean "page moved").
          if (acted === 'retry') {
            metrics.handlerRetries = (metrics.handlerRetries || 0) + 1; row.outcome = 'handler_retry';
            if (metrics.handlerRetries >= 4) { reason = 'stale_limit'; break; }
            handled = true; break;
          }
          if (acted) {
            row.picker = 'deterministic'; row.operation = handler.name; row.outcome = 'handled';
            metrics.deterministicSteps++;
            history.push({ step: stepNumber, operation: handler.name, target: null, outcome: 'handled' });
            handled = true; break;
          }
          void before;
        }
      }
      if (reason) break;
      if (handled) continue;
      // ---- deterministic finish check (independent done) ----
      if (spec.doneWhen) {
        const done = checkDoneWhen(spec.doneWhen.compiled, snapshot.data, spec.doneWhen.clauses);
        row.doneWhen = done.results;
        if (done.passed) { row.operation = 'done'; row.outcome = 'done_when_satisfied'; status = 'completed'; break; }
      }
      // ---- constrain + one batched decision ----
      const candidateSets = heads(snapshot);
      const total = Object.values(candidateSets).reduce((n, list) => n + list.length, 0);
      row.candidates = total; row.controls = snapshot.data.controls.length;
      if (total === 0) {
        // Transient empty states — a loading skeleton or a modal still
        // rendering — are not proof the page is dead. Give the page a
        // bounded beat and re-observe twice before declaring it.
        emptySnaps = (emptySnaps || 0) + 1;
        if (emptySnaps <= 2) { row.outcome = 'empty_snapshot'; await bounded(() => new Promise(r => setTimeout(r, 400))); stepNumber--; continue; }
        reason = 'no_candidates'; row.outcome = 'no_candidates'; break;
      }
      emptySnaps = 0;
      if (metrics.jevCalls >= maxModelCalls) { reason = 'model_call_budget'; row.outcome = 'budget'; break; }
      const request = buildStepRequest({ spec, snapshot, candidates: candidateSets, step: stepNumber, history });
      row.offered = request.actions.slice(0, 30).map(a => a.id);
      const pickStart = performance.now();
      metrics.jevCalls++;
      const answers = await bounded(() => decide(request, combined));
      row.pickMs = performance.now() - pickStart;
      metrics.pickMs += row.pickMs;
      const decision = resolveStep(answers, { questions: request.questions, actions: request.actions, valueKeys: Object.keys(spec.values) });
      row.decision = { operation: decision.operation, ref: decision.ref, valueKey: decision.valueKey,
        operationProbability: decision.operationProbability, targetProbability: decision.targetProbability,
        goalMet: decision.goalMet, destructive: decision.destructive };
      if (decision.error) {
        consecutiveAbstains++; metrics.abstains++; row.outcome = decision.error;
        if (consecutiveAbstains >= 3) { reason = 'invalid_model_answer'; break; }
        continue;
      }
      row.operation = decision.operation; row.ref = decision.ref;
      const picked = decision.ref ? resolveCandidate([...candidateSets.click, ...candidateSets.fill, ...candidateSets.press, ...candidateSets.select], decision.ref) : null;
      row.what = picked?.what || null;
      if ((decision.operationProbability ?? 1) < spec.policy.operationFloor
        || (decision.ref && (decision.targetProbability ?? 1) < spec.policy.targetFloor)) {
        row.unsure = true; metrics.unsurePicks++;
      }
      if ((decision.destructive ?? 0) >= spec.policy.destructiveGate && !spec.policy.allowDestructive
        && !['done', 'blocked', 'wait'].includes(decision.operation)) {
        row.outcome = 'destructive_blocked'; reason = 'destructive_blocked'; break;
      }
      // ---- gates on terminal / abstaining answers ----
      if (decision.operation === 'blocked') { row.outcome = 'model_blocked'; reason = 'model_blocked'; status = 'blocked'; break; }
      if (decision.operation === 'done') {
        if (spec.doneWhen) {
          const done = checkDoneWhen(spec.doneWhen.compiled, snapshot.data, spec.doneWhen.clauses);
          row.doneWhen = done.results;
          if (done.passed) { row.outcome = 'done_when_satisfied'; status = 'completed'; break; }
          prematureDoneCount++; metrics.prematureDone++; row.outcome = 'premature_done';
          history.push({ step: stepNumber, operation: 'done', target: null, outcome: 'rejected: finish checks not met' });
          if (prematureDoneCount >= 3) { reason = 'done_unverified'; break; }
          continue;
        }
        if ((decision.goalMet ?? 0) >= spec.policy.doneFloor) { row.outcome = 'done_unverified_model'; status = 'completed_unverified'; break; }
        row.outcome = 'premature_done'; prematureDoneCount++; metrics.prematureDone++;
        history.push({ step: stepNumber, operation: 'done', target: null, outcome: 'rejected: goal_met below floor' });
        if (prematureDoneCount >= 3) { reason = 'done_unverified'; break; }
        continue;
      }
      if (['click', 'fill', 'select', 'press'].includes(decision.operation) && !decision.ref) {
        consecutiveAbstains++; metrics.abstains++; row.outcome = 'abstained_no_target';
        history.push({ step: stepNumber, operation: decision.operation, target: null, outcome: 'abstained: no target fit' });
        if (consecutiveAbstains >= 3) { reason = 'target_unresolved'; break; }
        continue;
      }
      consecutiveAbstains = 0;
      // Same semantic action on the same URL caps at two attempts — the v3
      // loop guard. A page that did not change is not worth a third try.
      // Consecutive 'wait's are capped too: a model stalling on an empty
      // candidate set otherwise burns the whole step budget.
      if (decision.operation === 'wait') {
        consecutiveWaits++;
        if (consecutiveWaits >= 3) { reason = 'repeated_action_limit'; row.outcome = 'repeated_action_limit'; break; }
      } else consecutiveWaits = 0;
      if (['click', 'fill', 'select', 'press'].includes(decision.operation) && picked) {
        const dupKey = `${decision.operation}|${norm(picked.what)}|${norm(picked.component?.label)}|${snapshot.data.url}`;
        if (history.filter(item => item.key === dupKey).length >= 2) {
          reason = 'repeated_action_limit'; row.outcome = 'repeated_action_limit'; break;
        }
      }
      // ---- execute ----
      if (metrics.nativeActionAttempts >= maxActions) { reason = 'action_limit'; row.outcome = 'action_limit'; break; }
      const actionStart = performance.now();
      let before = snapshot;
      try {
        switch (decision.operation) {
          case 'wait': {
            await bounded(() => new Promise(resolve => setTimeout(resolve, Math.min(400, remaining()))));
            row.outcome = 'waited'; break;
          }
          case 'scroll_down': case 'scroll_up': {
            const direction = decision.operation === 'scroll_down' ? 1 : -1;
            await emit('action_planned', { step: stepNumber, operation: decision.operation });
            before = await session.scrollPage(direction);
            const settled = await postcondition(before, { type: 'scroll', beforeScrollY: snapshot.data.scrollY }, Math.min(400, remaining()));
            row.outcome = settled?.data?.ready ? 'scrolled' : 'scroll_no_change'; break;
          }
          case 'go_back': {
            await emit('action_planned', { step: stepNumber, operation: 'go_back' });
            before = snapshot;
            await bounded(() => page.goBack({ timeout: Math.min(5000, remaining()), waitUntil: 'domcontentloaded' }).catch(() => null));
            const settled = await postcondition(before, { type: 'change', beforeUrl: snapshot.data.url, beforeTitle: snapshot.data.title }, Math.min(800, remaining()));
            row.outcome = settled?.data?.ready ? 'navigated_back' : 'back_no_change'; break;
          }
          case 'fill': {
            const value = decision.valueKey ? spec.values[decision.valueKey] : null;
            if (value === null) {
              consecutiveAbstains++; metrics.abstains++; row.outcome = 'abstained_no_value';
              history.push({ step: stepNumber, operation: 'fill', target: row.what, outcome: 'abstained: no supplied value fit' });
              break;
            }
            await emit('action_planned', { step: stepNumber, operation: 'fill', ref: decision.ref });
            before = await bounded(() => session.execute(snapshot, picked, 'fill', value, Math.min(3000, remaining())));
            // Search-kind inputs live-filter on sites like Glovo: wait for the
            // result list, not just the field value, so the next snapshot
            // sees filtered candidates rather than a mid-render state.
            const goal = picked.control.kind === 'search' || picked.control.live
              ? { type: 'results' } : { type: 'value', nodeIndex: picked.control.nodeIndex, value };
            const settled = await postcondition(before, goal, Math.min(goal.type === 'results' ? 800 : 300, remaining()));
            row.outcome = settled?.data?.ready ? 'filled' : 'fill_unconfirmed';
            break;
          }
          case 'select': {
            if (picked?.option === null || picked?.option === undefined) { row.outcome = 'no_option_chosen'; break; }
            const target = { ...picked, ref: picked.ref.replace(/:o\d+$/, '') };
            await emit('action_planned', { step: stepNumber, operation: 'select', ref: decision.ref });
            before = await bounded(() => session.execute(snapshot, target, 'select', picked.option, Math.min(3000, remaining())));
            const settled = await postcondition(before, { type: 'selected', nodeIndex: target.control.nodeIndex, index: picked.option }, Math.min(400, remaining()));
            row.outcome = settled?.data?.ready ? 'selected' : 'select_no_change'; break;
          }
          case 'press': {
            await emit('action_planned', { step: stepNumber, operation: 'press', ref: decision.ref });
            before = await bounded(() => session.execute(snapshot, picked, 'press', '', Math.min(3000, remaining())));
            const settled = await postcondition(before, { type: 'results', beforeUrl: snapshot.data.url }, Math.min(1200, remaining()));
            row.outcome = settled?.data?.ready ? 'submitted' : 'submit_no_result'; break;
          }
          default: { // click
            await emit('action_planned', { step: stepNumber, operation: 'click', ref: decision.ref });
            before = await bounded(() => session.execute(snapshot, picked, 'click', '', Math.min(3000, remaining())));
            // Clicking the spec's named target opens a detail view (modal or
            // page): wait for the open state, not just any change — URL
            // params can update well before the content renders.
            const isTarget = spec.targetText && norm(picked.what) === norm(spec.targetText);
            const goal = isTarget
              ? { type: 'product_opened', text: spec.targetText, beforeUrl: snapshot.data.url }
              : { type: 'change', beforeUrl: snapshot.data.url, beforeTitle: snapshot.data.title };
            const settled = await postcondition(before, goal, Math.min(isTarget ? 1600 : 800, remaining()));
            row.outcome = settled?.data?.ready ? 'clicked' : 'click_no_change'; break;
          }
        }
      } catch (error) {
        if (error instanceof StaleBeforeDispatch) {
          // Staleness is the mechanism working — the page legitimately moved
          // under the pick. The cap bounds pathological churn only.
          if (metrics.staleRefreshes >= 8) { reason = 'stale_limit'; row.outcome = 'stale_limit'; break; }
          metrics.staleRefreshes++; row.outcome = 'stale_refreshed';
          await emit('stale_refreshed', { step: stepNumber });
          const fresh = await capture();
          const key = rebindKey(picked);
          const rebound = fresh.data.controls
            .filter(c => c.supports.includes(decision.operation === 'press' ? 'press' : decision.operation === 'fill' ? 'fill' : 'click'))
            .find(c => rebindKey({ kind: c.kind, what: c.what, component: c.component, href: c.href }) === key);
          if (!rebound) { consecutiveAbstains++; metrics.abstains++; history.push({ step: stepNumber, operation: decision.operation, target: row.what, outcome: 'stale: target gone' }); continue; }
          const retry = { ...picked, ref: `s${fresh.id}:e${rebound.nodeIndex}` };
          try {
            before = await bounded(() => session.execute(fresh, retry, decision.operation === 'press' ? 'press' : decision.operation === 'fill' ? 'fill' : 'click',
              decision.operation === 'fill' ? spec.values[decision.valueKey] || '' : '', Math.min(3000, remaining())));
            await postcondition(before, { type: 'change', beforeUrl: fresh.data.url, beforeTitle: fresh.data.title }, Math.min(800, remaining()));
            row.outcome = `${decision.operation}_after_stale`;
          } catch (retryError) {
            if (retryError instanceof StaleBeforeDispatch) { metrics.staleRefreshes++; row.outcome = 'stale_again'; continue; }
            throw retryError;
          }
        } else throw error;
      } finally { row.actMs = performance.now() - actionStart; }
      // wasted-step accounting: same semantic action as an earlier step on the same URL
      if (['click', 'fill', 'select', 'press'].includes(decision.operation) && picked) {
        const key = `${decision.operation}|${norm(picked.what)}|${norm(picked.component?.label)}|${snapshot.data.url}`;
        if (history.some(item => item.key === key)) metrics.wastedSteps++;
        history.push({ step: stepNumber, operation: decision.operation, target: picked.what, outcome: row.outcome, key });
      } else {
        history.push({ step: stepNumber, operation: decision.operation, target: null, outcome: row.outcome });
      }
      await emit('step_completed', { step: stepNumber, operation: decision.operation, target: row.what, outcome: row.outcome });
    }
    if (status === 'incomplete' && !reason) reason = 'step_limit';
  } catch (error) {
    reason = abortReason(error);
    if (reason === 'browser_error' && process.env.V5_DEBUG) console.error('v5 raw error:', error);
    escalation = { reason, pageUrl: page.url(), permittedContext: permittedContext(steps.at(-1)),
      completedSteps: steps.filter(s => s.outcome && !['no_candidates'].includes(s.outcome)).map(s => ({ step: s.step, operation: s.operation, target: s.what })),
      uncertainAction: reason === 'uncertain_execution', automaticRetryAllowed: false };
  } finally {
    page.removeListener('download', download); page.removeListener('popup', popup);
    if (installed) { metrics.protocolCalls++; await page.unroute('**/*', guard).catch(() => {}); }
    await session.dispose();
    metrics.totalMs = performance.now() - started;
  }
  if (!escalation && status !== 'completed' && status !== 'completed_unverified') {
    escalation = { reason: reason || 'step_limit', permittedContext: permittedContext(steps.at(-1)),
      completedSteps: steps.filter(s => s.outcome).map(s => ({ step: s.step, operation: s.operation, target: s.what })),
      uncertainAction: false, automaticRetryAllowed: false };
  }
  return { status, reason, steps, metrics, final, events, escalation, independentlyVerified: status === 'completed',
    doneWhen: spec.doneWhen?.clauses || null,
    scope: 'Stepwise goal loop: one batched typed decision per step over observed permitted controls; deterministic finish checks decide completion; model output never becomes selectors, code, navigation or typed text beyond supplied values.' };
}
