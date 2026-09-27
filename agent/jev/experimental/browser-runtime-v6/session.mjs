import { createSession as frameSession, StaleBeforeDispatch, OutsideScope } from './frame-session.mjs';
export { StaleBeforeDispatch, OutsideScope };

export function createSession(page, origin, task, metrics, signal, options = {}) {
  const sessions = new Map(), generations = new Map();
  let sequence = 0, current = null;
  const navigated = frame => generations.set(frame, (generations.get(frame) || 0) + 1);
  page.on('framenavigated', navigated);
  const ancestry = frame => { const path = []; for (let f = frame; f; f = f.parentFrame()) path.unshift(f); return path; };
  const effectiveUrl = frame => { for (let f = frame; f; f = f.parentFrame()) if (!['about:blank', 'about:srcdoc'].includes(f.url())) return f.url(); return ''; };
  const allowed = frame => {
    if (frame.isDetached()) return false;
    if (frame === page.mainFrame()) return !options.allowedUrl || options.allowedUrl(page.url());
    const url = effectiveUrl(frame);
    if (options.allowedFrameUrl) return options.allowedFrameUrl(url);
    try { return new URL(url).origin === origin; } catch { return false; }
  };
  function get(frame) {
    if (!sessions.has(frame)) {
      const proxy = { url: () => frame.url(), mainFrame: () => frame, on: (name, fn) => page.on(name, fn), removeListener: (name, fn) => page.removeListener(name, fn),
        locator: (...args) => frame.locator(...args), evaluate: (...args) => frame.evaluate(...args) };
      const frameOrigin = new URL(effectiveUrl(frame)).origin;
      sessions.set(frame, frameSession(proxy, frameOrigin, task, metrics, signal, { ...options, allowedUrl: url => url === frame.url() && allowed(frame) }));
    }
    return sessions.get(frame);
  }
  async function capture({ baseline, goal, waitMs = 0 } = {}) {
    signal.throwIfAborted();
    for (const [frame, session] of sessions) if (frame.isDetached()) { await session.dispose(); sessions.delete(frame); }
    const frames = page.frames().filter(allowed), parts = new Map(), sources = new Map(), controls = [];
    const generationsBefore = new Map(frames.map(f => [f, generations.get(f) || 0]));
    let top = null, ready = !goal, observerWakeups = 0, browserScans = 0;
    for (const frame of frames) {
      const selected = baseline?.targetFrame === frame;
      const frameGoal = selected ? {
        ...goal,
        ...(goal?.beforeUrl !== undefined ? {beforeUrl:baseline.parts.get(frame).data.url} : {}),
        ...(goal?.beforeTitle !== undefined ? {beforeTitle:baseline.parts.get(frame).data.title} : {}),
        ...(baseline.targetNodeIndex !== undefined ? {nodeIndex:baseline.targetNodeIndex} : {}),
      } : frame === page.mainFrame() && !baseline?.targetFrame ? goal : undefined;
      const part = await get(frame).capture({ baseline: baseline?.parts.get(frame), goal: frameGoal, waitMs: frameGoal ? waitMs : 0 });
      parts.set(frame, part); if (frame === page.mainFrame()) top = part;
      observerWakeups += part.data.observerWakeups; browserScans += part.data.browserScans;
      if (frameGoal) ready = part.data.ready;
      for (const c of part.data.controls) {
        if (controls.length >= (options.cap ?? 120)) break;
        const nodeIndex = controls.length, path = ancestry(frame);
        sources.set(nodeIndex, { frame, part, localIndex: c.nodeIndex, lineage: path.map(f => ({ frame: f, generation: generations.get(f) || 0 })) });
        controls.push({ ...c, nodeIndex, framePath: path.map(f => page.frames().indexOf(f)), where: [...c.where, ...(frame === page.mainFrame() ? [] : [`frame:${path.map(f => page.frames().indexOf(f)).join('/')}`])] });
      }
    }
    if (!top) throw new OutsideScope();
    if (frames.some(f => f.isDetached() || (generations.get(f) || 0) !== generationsBefore.get(f))) throw new Error('Execution context was destroyed during frame observation');
    const data = { ...top.data, controls, text: [...parts.values()].map(p => p.data.text).join('\n').slice(0, options.textCap ?? 20000),
      headings: [...parts.values()].flatMap(p => p.data.headings), ready, observerWakeups, browserScans,
      // Validation feedback renders in whichever frame holds the form —
      // merging it keeps a nested-iframe rejection visible to the decider.
      feedback: [...new Set([...parts.values()].flatMap(p => p.data.feedback || []))].slice(0, 8),
      eligible: [...parts.values()].reduce((n, p) => n + p.data.eligible, 0), inaccessibleFrames: page.frames().length - frames.length };
    data.truncated = data.eligible > controls.length;
    current = { id: ++sequence, data, parts, sources, consumed: false };
    return current;
  }
  const control = (snapshot, candidate) => snapshot.data.controls.find(c => `s${snapshot.id}:e${c.nodeIndex}` === candidate?.ref);
  async function execute(snapshot, candidate, kind, value, timeout) {
    const c = control(snapshot, candidate), target = c && snapshot.sources.get(c.nodeIndex);
    if (current !== snapshot || snapshot.consumed || !target || !allowed(target.frame) || target.lineage.some(p => p.frame.isDetached() || (generations.get(p.frame) || 0) !== p.generation)) {
      throw Object.assign(new StaleBeforeDispatch(), { detail: { compositeGate: true, isCurrent: current === snapshot, consumed: snapshot.consumed,
        hasTarget: Boolean(target), frameAllowed: target ? allowed(target.frame) : null,
        staleLineage: target?.lineage.filter(p => p.frame.isDetached() || (generations.get(p.frame) || 0) !== p.generation).length ?? null } });
    }
    snapshot.consumed = true;
    const before = await get(target.frame).execute(target.part, { ...candidate, ref: `s${target.part.id}:e${target.localIndex}` }, kind, value, timeout);
    const parts = new Map(snapshot.parts); parts.set(target.frame, before);
    return { ...snapshot, parts, targetFrame: target.frame, targetNodeIndex: before.data.selectedIndex };
  }
  return { capture, control, execute,
    candidates: (snapshot, supports) => snapshot.data.controls.filter(c => supports.some(k => c.supports.includes(k))).map(c => ({ ...c, ref: `s${snapshot.id}:e${c.nodeIndex}` })),
    current: () => current,
    async scrollPage(direction) { const before = current; await get(page.mainFrame()).scrollPage(direction); return before; },
    async releaseSnapshot(snapshot) { for (const [frame, part] of snapshot.parts) await sessions.get(frame)?.releaseSnapshot(part); },
    async dispose() { page.removeListener('framenavigated', navigated); for (const session of sessions.values()) await session.dispose(); sessions.clear(); }
  };
}
