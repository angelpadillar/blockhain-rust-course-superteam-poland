// Browser session wrapper: atomic captures with real node identity, epoch
// tracking across navigations, and pre-dispatch revalidation so a stale or
// semantically changed target is refreshed — never blindly dispatched.
import { inspectPage } from './snapshot.mjs';

export class StaleBeforeDispatch extends Error {
  constructor() { super('stale_before_dispatch'); this.code = 'stale_before_dispatch'; }
}
export class OutsideScope extends Error {
  constructor() { super('outside_navigation_scope'); this.code = 'outside_navigation_scope'; }
}

export function createSession(page, origin, task, metrics, signal, options = {}) {
  const retained = new Set();
  let epoch = 0, sequence = 0, current = null;
  const navigated = frame => { if (frame === page.mainFrame()) epoch++; };
  page.on('framenavigated', navigated);
  const cap = options.cap ?? 120, textCap = options.textCap ?? 20000;
  async function protocol(operation) {
    metrics.protocolCalls++;
    return operation();
  }
  async function release(handle) {
    if (!handle) return;
    retained.delete(handle);
    await protocol(() => handle.dispose()).catch(() => {});
  }
  function inspectOptions(extra = {}) {
    return { origin, deny: options.deny || [], denyPath: options.denyPath || '', cap, textCap,
      targetText: task.targetText || '', ...extra };
  }
  async function capture({ baseline, goal, waitMs = 0 } = {}) {
    signal.throwIfAborted();
    const started = performance.now(), snapshotEpoch = epoch;
    const handle = await protocol(() => page.locator('body').evaluateHandle(inspectPage, inspectOptions({
      baseline: baseline?.epoch === epoch ? baseline.handle : null,
      freshDocument: Boolean(baseline && baseline.epoch !== epoch),
      goal, waitMs,
    }), { timeout: Math.max(1000, waitMs + 2000) }));
    retained.add(handle);
    const data = await protocol(() => handle.evaluate(value => value.data));
    metrics.snapMs += performance.now() - started;
    metrics.observations++; metrics.observerWakeups += data.observerWakeups; metrics.browserScans += data.browserScans;
    if (options.allowedUrl && !options.allowedUrl(data.url)) throw new OutsideScope();
    const previous = current;
    current = { handle, data, epoch: snapshotEpoch, id: ++sequence, consumed: false };
    if (previous && previous !== baseline) await release(previous.handle);
    return current;
  }
  function candidates(snapshot, supports) {
    return snapshot.data.controls
      .filter(control => supports.some(kind => control.supports.includes(kind)))
      .map(control => ({ ref: `s${snapshot.id}:e${control.nodeIndex}`, what: control.what, role: control.role,
        kind: control.kind, where: [...control.where], component: control.component,
        supports: [...control.supports], inViewport: control.inViewport }));
  }
  function control(snapshot, candidate) {
    return snapshot.data.controls.find(control => `s${snapshot.id}:e${control.nodeIndex}` === candidate?.ref);
  }
  const semantics = item => item && JSON.stringify([item.kind, item.what, item.role, item.where,
    item.component, item.supports, item.href, item.value, item.tag, item.type, item.name]);
  async function execute(snapshot, candidate, kind, value, timeout) {
    signal.throwIfAborted();
    const old = control(snapshot, candidate);
    if (current !== snapshot || snapshot.consumed || snapshot.epoch !== epoch || page.url() !== snapshot.data.url
      || !old || !old.supports.includes(kind)) throw new StaleBeforeDispatch();
    let node;
    try {
      node = (await protocol(() => snapshot.handle.evaluateHandle((snapshot, nodeIndex) => snapshot.nodes[nodeIndex], old.nodeIndex))).asElement();
      if (!node) throw new StaleBeforeDispatch();
      const freshHandle = await protocol(() => page.locator('body').evaluateHandle(inspectPage, inspectOptions({ selected: node }), { timeout: 1000 }));
      retained.add(freshHandle);
      const freshData = await protocol(() => freshHandle.evaluate(snapshot => snapshot.data));
      const before = { handle: freshHandle, data: freshData, epoch, id: ++sequence, consumed: false };
      metrics.revalidations++; metrics.browserScans += freshData.browserScans;
      const selected = freshData.controls.find(control => control.nodeIndex === freshData.selectedIndex);
      if (current !== snapshot || freshData.url !== snapshot.data.url || semantics(selected) !== semantics(old)) throw new StaleBeforeDispatch();
      signal.throwIfAborted();
      snapshot.consumed = true;
      const started = performance.now();
      metrics.nativeActionAttempts++; metrics[kind + 'Attempts'] = (metrics[kind + 'Attempts'] || 0) + 1;
      try {
        if (kind === 'fill') await protocol(() => node.fill(value, { timeout }));
        else if (kind === 'press') await protocol(() => node.press('Enter', { timeout }));
        else if (kind === 'select') await protocol(() => node.selectOption({ index: value }, { timeout }));
        else if (kind === 'scroll_down' || kind === 'scroll_up') {
          await protocol(() => node.evaluate((el, direction) => {
            const amount = Math.round(innerHeight * 0.8) * direction;
            (el === document.body || el === document.documentElement ? window : el).scrollBy({ top: amount, behavior: 'instant' });
          }, kind === 'scroll_down' ? 1 : -1));
        } else await protocol(() => node.click({ timeout }));
        metrics.nativeActionsCompleted++;
        return before;
      } catch {
        throw Object.assign(new Error('uncertain_execution'), { code: 'uncertain_execution' });
      } finally { metrics.actMs += performance.now() - started; }
    } finally { await release(node); }
  }
  // Scroll targets the scrollable region itself when no element handles it.
  async function scrollPage(direction) {
    signal.throwIfAborted();
    const before = current;
    const started = performance.now();
    metrics.nativeActionAttempts++; metrics[direction > 0 ? 'scrollDownAttempts' : 'scrollUpAttempts'] = (metrics[direction > 0 ? 'scrollDownAttempts' : 'scrollUpAttempts'] || 0) + 1;
    await protocol(() => page.evaluate(direction => scrollBy({ top: direction * innerHeight * 0.8, behavior: 'instant' }), direction));
    metrics.nativeActionsCompleted++;
    metrics.actMs += performance.now() - started;
    return before;
  }
  return { capture, candidates, control, execute, scrollPage,
    current: () => current,
    releaseSnapshot: snapshot => release(snapshot?.handle),
    async dispose() { page.removeListener('framenavigated', navigated); for (const handle of [...retained]) await release(handle); } };
}
