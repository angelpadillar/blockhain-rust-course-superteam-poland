import { allowedUrl, allowedRequest, createBrowser, normalize, StaleBeforeDispatch } from './browser.mjs';

class Stop extends Error {
  constructor(code) { super(code); this.code = code; }
}
export function validateTask(task) {
  if (!task || Object.keys(task).some(key => !['query', 'targetText', 'context'].includes(key))) throw new Stop('unsupported_task');
  for (const key of ['query', 'targetText']) if (typeof task[key] !== 'string' || !task[key].trim()
    || task[key].length > 240 || /[\x00-\x1f]/.test(task[key])) throw new Stop('invalid_task');
  if (task.context !== undefined && (typeof task.context !== 'string' || task.context.length > 160 || /[\x00-\x1f]/.test(task.context))) throw new Stop('invalid_task');
  return { query: task.query.trim(), targetText: task.targetText.trim(), ...(task.context ? { context: task.context.trim() } : {}) };
}

export async function runSearchAndOpen({ page, task: suppliedTask, choose, onEvent = async () => {}, signal,
  mode = 'fast', maxMs = 15000, maxActions = 8 }) {
  const task = validateTask(suppliedTask);
  if (!['fast', 'stepwise'].includes(mode) || !Number.isFinite(maxMs) || maxMs < 100 || maxMs > 60000
    || !Number.isInteger(maxActions) || maxActions < 1 || maxActions > 20) throw new Stop('invalid_runtime_limits');
  const started = performance.now(), stop = new AbortController();
  const combined = AbortSignal.any([stop.signal, AbortSignal.timeout(maxMs), ...(signal ? [signal] : [])]);
  const origin = new URL(page.url()).origin;
  if (!allowedUrl(page.url(), origin)) throw new Stop('outside_navigation_scope');
  const metrics = { totalMs: 0, observationMs: 0, executionMs: 0, conditionWaitMs: 0, settlingMs: 0, chooserMs: 0, eventMs: 0,
    explicitProtocolCalls: 0, observations: 0, revalidations: 0, browserScans: 0, observerWakeups: 0,
    nativeActionAttempts: 0, nativeActionsCompleted: 0, fillAttempts: 0, pressAttempts: 0, clickAttempts: 0,
    chooserCalls: 0, staleRefreshes: 0, blockedRequests: 0 };
  const events = [], browser = createBrowser(page, origin, task, metrics, combined);
  let snapshot, searchBaseline, lastKnown = { url: page.url(), title: '' }, status = 'incomplete', reason = null, installed = false;
  const remaining = () => Math.max(1, maxMs - (performance.now() - started));
  function check() { combined.throwIfAborted(); if (remaining() <= 1) throw new Stop('time_limit'); }
  function bounded(operation) {
    check();
    return new Promise((resolve, reject) => {
      const abort = () => reject(combined.reason);
      combined.addEventListener('abort', abort, { once: true });
      Promise.resolve(operation).then(resolve, reject).finally(() => combined.removeEventListener('abort', abort));
    });
  }
  async function emit(type, detail = {}) {
    const event = { type, elapsedMs: performance.now() - started, ...detail };
    events.push(event);
    const before = performance.now();
    try { await bounded(onEvent(event)); } catch { if (combined.aborted) throw combined.reason; throw new Stop('event_sink_failed'); }
    finally { metrics.eventMs += performance.now() - before; }
  }
  const guard = async route => {
    const request = route.request();
    metrics.explicitProtocolCalls++;
    if (!allowedRequest({ url: request.url(), method: request.method(), navigation: request.isNavigationRequest(), resourceType: request.resourceType() }, origin)) {
      metrics.blockedRequests++;
      stop.abort(new Stop('forbidden_request'));
      await route.abort().catch(() => {});
    } else await route.fallback().catch(() => {});
  };
  const download = item => { stop.abort(new Stop('download_blocked')); metrics.explicitProtocolCalls++; void item.cancel().catch(() => {}); };
  const popup = newPage => { stop.abort(new Stop('popup_blocked')); metrics.explicitProtocolCalls++; void newPage.close().catch(() => {}); };
  async function observe(options = {}) {
    check();
    snapshot = await browser.capture(options);
    lastKnown = { url: snapshot.data.url, title: snapshot.data.title };
    return snapshot;
  }
  async function settle() {
    if (mode !== 'stepwise') return;
    check();
    const before = performance.now();
    await bounded(new Promise(resolve => setTimeout(resolve, Math.min(700, remaining()))));
    metrics.settlingMs += performance.now() - before;
    check();
  }
  function publicObservation(snap) {
    return { title: snap.data.title, origin, controls: snap.data.controls.length,
      searchControls: browser.candidates(snap, 'search').length, resultLinks: browser.candidates(snap, 'result').length };
  }
  async function select(kind, snap, { sameSearch } = {}) {
    let candidates = browser.candidates(snap, kind, kind === 'result');
    if (kind === 'result') candidates = candidates.filter(candidate => normalize(candidate.what) === normalize(task.targetText));
    if (sameSearch) candidates = candidates.filter(candidate => normalize(candidate.what) === normalize(sameSearch.what)
      && candidate.role === sameSearch.role && JSON.stringify(candidate.where) === JSON.stringify(sameSearch.where));
    if (task.context) {
      const scoped = candidates.filter(candidate => candidate.where.some(where => normalize(where) === normalize(task.context)));
      if (scoped.length) candidates = scoped;
    }
    if (!candidates.length) throw new Stop(kind === 'search' ? 'no_search_control' : 'no_exact_result');
    if (candidates.length === 1) return candidates[0];
    if (!choose) throw new Stop(`ambiguous_${kind}`);
    const before = performance.now(); metrics.chooserCalls++;
    let ref;
    try { ref = await bounded(choose({ kind, candidates, task, observation: publicObservation(snap), signal: combined })); }
    finally { metrics.chooserMs += performance.now() - before; }
    check();
    const candidate = candidates.find(candidate => candidate.ref === ref);
    if (!candidate) throw new Stop('chooser_invalid_ref');
    return candidate;
  }
  async function act(kind, snap, candidate, { sameSearch } = {}) {
    for (;;) {
      check();
      if (metrics.nativeActionAttempts >= maxActions) throw new Stop('action_limit');
      await emit('action_planned', { kind, ref: candidate.ref });
      try {
        const before = await browser.execute(snap, candidate, kind, task.query, Math.min(3000, remaining()));
        await emit('action_completed', { kind, ref: candidate.ref });
        return before;
      } catch (error) {
        if (!(error instanceof StaleBeforeDispatch)) throw error;
        if (metrics.staleRefreshes >= 2) throw new Stop('stale_limit');
        metrics.staleRefreshes++;
        await emit('stale_refreshed', { kind });
        snap = await observe(kind === 'click' ? { baseline: searchBaseline } : {});
        candidate = await select(kind === 'click' ? 'result' : 'search', snap, { sameSearch });
      }
    }
  }
  async function waitFor(goal, baseline, limit) {
    const before = performance.now(), until = performance.now() + Math.min(limit, remaining());
    try {
      while (performance.now() < until) {
        check();
        try {
          const observed = await observe({ baseline, goal, waitMs: Math.min(300, until - performance.now(), remaining()),
            beforeTitle: baseline.data.title, beforeUrl: baseline.data.url, beforeTargetHeading: baseline.data.targetHeading });
          if (observed.data.ready) return observed;
        } catch (error) {
          // Navigation can destroy an observer's execution context. Retrying a
          // read is safe; dispatched browser actions are never retried here.
          if (!/Execution context was destroyed|Cannot find context|different JavaScript context/.test(error.message || '')) throw error;
        }
      }
      return null;
    } finally { metrics.conditionWaitMs += performance.now() - before; }
  }
  try {
    metrics.explicitProtocolCalls++;
    await page.route('**/*', guard); installed = true;
    page.on('download', download); page.on('popup', popup);
    await emit('started', { mode });
    snapshot = await observe();
    let search = await select('search', snapshot);
    searchBaseline = await act('fill', snapshot, search);
    search = browser.candidates(searchBaseline, 'search').find(candidate =>
      browser.control(searchBaseline, candidate).index === searchBaseline.data.selectedIndex) || search;
    const searchControl = browser.control(searchBaseline, search);
    await settle();
    let results;
    if (searchControl.live) results = await waitFor('results', searchBaseline, searchControl.submit ? 900 : remaining());
    if (!results && searchControl.submit) {
      const filled = await observe({ baseline: searchBaseline });
      const submit = await select('search', filled, { sameSearch: search });
      if (!submit.supports.includes('press')) throw new Stop('unsupported_submission');
      await act('press', filled, submit, { sameSearch: search });
      await settle();
    }
    results ||= await waitFor('results', searchBaseline, remaining());
    if (!results) throw new Stop('results_timeout');
    if (results.data.emptyResults && !browser.candidates(results, 'result', true).some(candidate => normalize(candidate.what) === normalize(task.targetText))) throw new Stop('empty_results');
    const chosen = await select('result', results);
    const beforeClick = await act('click', results, chosen);
    const opened = await waitFor('opened', beforeClick, remaining());
    if (!opened) throw new Stop('open_not_observed');
    status = 'opened';
    await emit('opened', { independentlyVerified: false });
  } catch (error) {
    reason = combined.aborted && error.code !== 'uncertain_execution'
      ? (stop.signal.reason?.code || (signal?.aborted ? 'aborted' : 'time_limit'))
      : typeof error.code === 'string' ? error.code : 'browser_error';
    if (status === 'opened') status = 'incomplete';
  } finally {
    page.removeListener('download', download); page.removeListener('popup', popup);
    if (installed) { metrics.explicitProtocolCalls++; await page.unroute('**/*', guard).catch(() => {}); }
    await browser.dispose();
    metrics.totalMs = performance.now() - started;
  }
  return { status, reason, metrics, final: lastKnown, events,
    scope: 'General native/ARIA search and exact-link opening subset; independent task verification is external. Navigation and fetch/XHR stay within the start origin; HTTP(S) GET/HEAD static subresources may use other origins. All non-read methods and downloads are blocked.',
    metricScope: 'explicitProtocolCalls counts only explicit runtime Playwright calls, including handle disposal and route setup; it excludes Playwright internal traffic and chooser screenshots/provider calls. Observation time includes browser-side waits; conditionWaitMs overlaps it. Total excludes initial page navigation.' };
}
