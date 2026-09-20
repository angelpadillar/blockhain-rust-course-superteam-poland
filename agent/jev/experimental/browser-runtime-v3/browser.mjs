export const normalize = value => String(value || '').normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();
export const deniedText = value => /\b(?:checkout|buy|purchase|pay|payment|order|cart|basket|account|profile|login|logout|log in|log out|sign in|sign out|register|delete|remove|unsubscribe|subscribe)\b/i.test(value || '');
export function allowedUrl(value, origin) {
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && url.origin === origin && !url.username && !url.password
      && !/\/(?:carts?|baskets?|orders?|payments?|transactions?|accounts?|profiles?|address(?:es)?|checkout|login|logout|delete|remove)(?:\/|$)/i.test(url.pathname)
      && ![...url.searchParams].some(([key, val]) => /^(?:action|do|operation)$/i.test(key) && deniedText(val));
  } catch { return false; }
}
export function allowedRequest({ url, method, navigation, resourceType }, origin) {
  if (!['GET', 'HEAD', 'OPTIONS'].includes(method)) return false;
  if (allowedUrl(url, origin)) return true;
  if (navigation || !['GET', 'HEAD'].includes(method)
    || !['stylesheet', 'image', 'font', 'script', 'media', 'manifest', 'texttrack'].includes(resourceType)) return false;
  try {
    const resource = new URL(url);
    return ['http:', 'https:'].includes(resource.protocol) && resource.origin !== origin && !resource.username && !resource.password;
  } catch { return false; }
}
export class StaleBeforeDispatch extends Error {
  constructor() { super('stale_before_dispatch'); this.code = 'stale_before_dispatch'; }
}

// One browser callback captures controls and their actual nodes atomically. The
// optional wait resolves on relevant DOM evidence, never general page stability.
export function inspectDocument(body, options) {
  const norm = value => String(value || '').normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();
  const denied = value => /\b(?:checkout|buy|purchase|pay|payment|order|cart|basket|account|profile|login|logout|log in|log out|sign in|sign out|register|delete|remove|unsubscribe|subscribe)\b/i.test(value || '');
  const safe = value => {
    try {
      const u = new URL(value, location.href);
      return ['http:', 'https:'].includes(u.protocol) && u.origin === options.origin && !u.username && !u.password
        && !/\/(?:carts?|baskets?|orders?|payments?|transactions?|accounts?|profiles?|address(?:es)?|checkout|login|logout|delete|remove)(?:\/|$)/i.test(u.pathname)
        && ![...u.searchParams].some(([key, val]) => /^(?:action|do|operation)$/i.test(key) && denied(val));
    } catch { return false; }
  };
  const visible = element => {
    if (!element.isConnected || !element.getClientRects().length || getComputedStyle(element).visibility === 'hidden') return false;
    for (let parent = element; parent && parent !== body; parent = parent.parentElement) {
      const style = getComputedStyle(parent);
      if (style.display === 'none' || parent.getAttribute('aria-hidden') === 'true'
        || (/hidden|clip/.test(style.overflowY) && parent.getBoundingClientRect().height < 1)) return false;
    }
    return true;
  };
  let wakeups = 0, scans = 0;
  function scan() {
    scans++;
    const nodes = [...body.querySelectorAll('input,textarea,[role="searchbox"],a[href]')];
    const controls = nodes.flatMap((node, index) => {
      if (!visible(node) || node.disabled || node.getAttribute('aria-disabled') === 'true') return [];
      const tag = node.tagName.toLowerCase(), type = (node.type || '').toLowerCase(), role = node.getAttribute('role') || '';
      const label = (node.getAttribute('aria-label') || [...(node.labels || [])].map(label => label.textContent).join(' ')
        || node.getAttribute('placeholder') || (tag === 'a' ? node.innerText : '') || '').trim().slice(0, 160);
      if (denied(label)) return [];
      const region = node.closest('section[aria-label],[role="region"][aria-label],form[aria-label],nav[aria-label]');
      const where = [node.closest('main,[role="main"]') && 'main', node.closest('nav,[role="navigation"]') && 'navigation',
        node.closest('[role="search"]') && 'search', region?.getAttribute('aria-label')?.slice(0, 100)].filter(Boolean);
      const editable = (tag === 'input' && ['text', 'search'].includes(type)) || tag === 'textarea' || node.isContentEditable;
      if (editable && (type === 'search' || role === 'searchbox' || /\b(?:search|find|lookup|szukaj|wyszukaj)\b/i.test(label))) {
        const form = node.form || node.closest('form');
        const submit = Boolean(form && (form.getAttribute('method') || 'get').toLowerCase() === 'get' && safe(form.action || location.href));
        const live = role === 'searchbox' || ['list', 'both'].includes(node.getAttribute('aria-autocomplete')) || Boolean(node.getAttribute('aria-controls'));
        return [{ index, kind: 'search', what: label || 'Search', role: role === 'searchbox' || type === 'search' ? 'searchbox' : 'textbox',
          where, supports: submit ? ['fill', 'press'] : ['fill'], value: node.value ?? node.textContent ?? '',
          formAction: submit ? form.action : null, submit, live, tag, type }];
      }
      if (tag === 'a' && label && !node.hasAttribute('download') && safe(node.href)) {
        const baseline = options.baseline;
        const oldIndex = baseline?.nodes.indexOf(node) ?? -1;
        const old = baseline?.data.controls.find(control => control.index === oldIndex && control.kind === 'result');
        const fresh = options.freshDocument || Boolean(baseline && (!old || old.href !== node.href || old.what !== label));
        return [{ index, kind: 'result', what: label, role: 'link', where, supports: ['click'], href: node.href, fresh: Boolean(fresh) }];
      }
      return [];
    });
    const headings = [...body.querySelectorAll('h1,h2,[role="heading"]')].filter(visible);
    const targetHeading = headings.some(node => norm(node.innerText) === norm(options.targetText));
    const emptyResults = [...body.querySelectorAll('[role="status"],[role="alert"]')].filter(visible)
      .some(node => /\b(?:no (?:matching )?(?:results|items|matches)|nothing found|0 results)\b/i.test(node.innerText));
    const ready = options.goal === 'results' ? controls.some(control => control.kind === 'result' && control.fresh && norm(control.what) === norm(options.targetText)) || emptyResults
      : options.goal === 'opened' ? targetHeading && (!options.beforeTargetHeading || options.freshDocument || location.href !== options.beforeUrl)
      : true;
    const data = { url: location.href, title: document.title.slice(0, 200), controls, targetHeading, emptyResults, ready,
      observerWakeups: wakeups, browserScans: scans, selectedIndex: options.selected?.isConnected ? nodes.indexOf(options.selected) : -1 };
    return options.serializable ? { data } : { nodes, data };
  }
  const initial = scan();
  if (!options.waitMs || initial.data.ready) return initial;
  return new Promise(resolve => {
    const finish = value => { observer.disconnect(); clearTimeout(timer); resolve(value); };
    const observer = new MutationObserver(() => { wakeups++; const value = scan(); if (value.data.ready) finish(value); });
    observer.observe(body, { subtree: true, childList: true, characterData: true, attributes: true });
    const timer = setTimeout(() => finish(scan()), options.waitMs);
  });
}

export function createBrowser(page, origin, task, metrics, signal) {
  const retained = new Set();
  let epoch = 0, sequence = 0, current = null;
  const navigated = frame => { if (frame === page.mainFrame()) epoch++; };
  page.on('framenavigated', navigated);
  async function protocol(operation) {
    metrics.explicitProtocolCalls++;
    return operation();
  }
  async function release(handle) {
    if (!handle) return;
    retained.delete(handle);
    await protocol(() => handle.dispose()).catch(() => {});
  }
  async function capture({ baseline, goal, waitMs = 0, beforeTitle, beforeUrl, beforeTargetHeading } = {}) {
    signal.throwIfAborted();
    const started = performance.now(), snapshotEpoch = epoch;
    const handle = await protocol(() => page.locator('body').evaluateHandle(inspectDocument, {
      origin, targetText: task.targetText, goal, waitMs, beforeTitle, beforeUrl, beforeTargetHeading,
      baseline: baseline?.epoch === epoch ? baseline.handle : null,
      freshDocument: Boolean(baseline && baseline.epoch !== epoch),
    }, { timeout: 1000 }));
    retained.add(handle);
    const data = await protocol(() => handle.evaluate(value => value.data));
    metrics.observationMs += performance.now() - started;
    metrics.observations++; metrics.observerWakeups += data.observerWakeups; metrics.browserScans += data.browserScans;
    if (!allowedUrl(data.url, origin)) throw Object.assign(new Error('outside_navigation_scope'), { code: 'outside_navigation_scope' });
    const previous = current;
    current = { handle, data, epoch: snapshotEpoch, id: ++sequence, consumed: false };
    if (previous && previous !== baseline) await release(previous.handle);
    return current;
  }
  function candidates(snapshot, kind, freshOnly = false) {
    return snapshot.data.controls.filter(control => control.kind === kind && (!freshOnly || control.fresh))
      .map(control => ({ ref: `s${snapshot.id}:e${control.index}`, what: control.what, role: control.role,
        where: [...control.where], supports: [...control.supports] }));
  }
  function control(snapshot, candidate) {
    return snapshot.data.controls.find(control => `s${snapshot.id}:e${control.index}` === candidate?.ref);
  }
  async function execute(snapshot, candidate, kind, value, timeout) {
    signal.throwIfAborted();
    const old = control(snapshot, candidate);
    if (current !== snapshot || snapshot.consumed || snapshot.epoch !== epoch || page.url() !== snapshot.data.url
      || !old || !old.supports.includes(kind)) throw new StaleBeforeDispatch();
    let node;
    try {
      node = (await protocol(() => snapshot.handle.evaluateHandle((snapshot, index) => snapshot.nodes[index], old.index))).asElement();
      if (!node) throw new StaleBeforeDispatch();
      const freshHandle = await protocol(() => page.locator('body').evaluateHandle(inspectDocument, { origin, targetText: task.targetText, selected: node }, { timeout: 1000 }));
      retained.add(freshHandle);
      const freshData = await protocol(() => freshHandle.evaluate(snapshot => snapshot.data));
      const before = { handle: freshHandle, data: freshData, epoch, id: ++sequence, consumed: false };
      metrics.revalidations++; metrics.browserScans += freshData.browserScans;
      const selected = freshData.controls.find(control => control.index === freshData.selectedIndex);
      const semantics = item => item && JSON.stringify([item.kind, item.what, item.role, item.where, item.supports,
        item.href, item.formAction, item.value, item.submit, item.live, item.tag, item.type]);
      if (current !== snapshot || freshData.url !== snapshot.data.url || semantics(selected) !== semantics(old)) throw new StaleBeforeDispatch();
      signal.throwIfAborted();
      snapshot.consumed = true;
      const started = performance.now();
      metrics.nativeActionAttempts++; metrics[kind + 'Attempts']++;
      try {
        if (kind === 'fill') await protocol(() => node.fill(value, { timeout }));
        else if (kind === 'press') await protocol(() => node.press('Enter', { timeout }));
        else await protocol(() => node.click({ timeout }));
        metrics.nativeActionsCompleted++;
        return before;
      } catch {
        throw Object.assign(new Error('uncertain_execution'), { code: 'uncertain_execution' });
      } finally { metrics.executionMs += performance.now() - started; }
    } finally { await release(node); }
  }
  return { capture, candidates, control, execute, releaseSnapshot: snapshot => release(snapshot?.handle),
    async dispose() { page.removeListener('framenavigated', navigated); for (const handle of [...retained]) await release(handle); } };
}
