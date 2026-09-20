import { JevBrowserAgent } from './mahmoud/agent.mjs';
import { createLedger, ProviderError } from '../../browser-runtime-v3/providers.mjs';
import { createJev } from '../../../src/jev.mjs';

export const UPSTREAM = Object.freeze({
  repository: 'https://github.com/MahmoudAdelbghany/jev-browser',
  revision: '20c27dd96df3140cf162c936fbb7aa742c50edc6', version: '0.1.0',
  scope: 'Normalized decision policy, including upstream corrective retry; shared observation and execution, not upstream end-to-end browser.',
});
const validCount = value => Number.isSafeInteger(value) && value >= 0;
const safeModel = value => typeof value === 'string' && /^[a-zA-Z0-9_./:-]{1,160}$/.test(value) ? value : 'unknown';
const fail = code => { throw new ProviderError(code); };

// Called only with the common observer's public fields. No answer routes, fixture
// descriptors, verifier state or task internals are forwarded to the model.
export function normalizeObservation(observation) {
  if (!observation || !Array.isArray(observation.elements)) fail('invalid_observation');
  const seen = new Set();
  const elements = observation.elements.map(element => {
    const ref = String(element.ref ?? element.id ?? '');
    if (!ref || ref.length > 120 || ref.includes('|') || seen.has(ref)) fail('invalid_observed_reference');
    seen.add(ref);
    const bbox = Array.isArray(element.bbox) && element.bbox.length === 4 && element.bbox.every(Number.isFinite)
      ? [...element.bbox] : [0, 0, 0, 0];
    const context = Array.isArray(element.context) ? element.context.join(' > ') : String(element.context || '');
    const label = String(element.label ?? element.text ?? '');
    return { ref, tag: String(element.tag || element.role || 'element'), role: String(element.role || ''),
      label: context ? `${label} — ${context}` : label, bbox,
      ...(element.value == null ? {} : { value: String(element.value) }),
      ...(element.href ? { href: String(element.href) } : {}),
      flags: Array.isArray(element.flags) ? element.flags.map(String) : [] };
  });
  return { url: String(observation.url || ''), title: String(observation.title || ''),
    textSample: String(observation.text || ''), elements, latencyMs: 0,
    dialogs: observation.dialogs || 0, focusRef: observation.focusRef || null,
    scrollY: Number(observation.scrollY) || 0, scrollHeight: Number(observation.scrollHeight) || 0,
    viewportH: Number(observation.viewportH) || 800 };
}

function publicTexts(texts) {
  if (!Array.isArray(texts) || texts.length > 40 || texts.some(text => typeof text !== 'string' || text.length > 500)) fail('invalid_task_texts');
  return [...texts];
}
function publicPrevious(previous) {
  if (!previous) return null;
  return { action: String(previous.action || ''), ref: previous.ref == null ? undefined : String(previous.ref),
    key: previous.key == null ? undefined : String(previous.key),
    text: previous.text == null ? undefined : String(previous.text), label: String(previous.label || ''),
    outcome: String(previous.outcome || ''), evidence_changed: previous.evidence_changed === true };
}

export function mapUpstreamAction(action) {
  if (!action || typeof action.type !== 'string') fail('invalid_upstream_action');
  switch (action.type) {
    case 'click': return { type: 'click', ref: action.ref };
    case 'type': return { type: 'fill', ref: action.ref, text: action.text };
    case 'press_key': return { type: 'press', key: action.key || 'Enter' };
    case 'scroll_down': return { type: 'scroll', direction: 'down' };
    case 'scroll_up': return { type: 'scroll', direction: 'up' };
    case 'back': return { type: 'back' };
    case 'wait': return { type: 'wait', ms: 500 };
    default: fail('unsupported_upstream_action');
  }
}

// This validates only the policy/executor boundary, never claims permission to
// mutate a site. The common executor must rebind refs and apply its safety guard.
export function validateProposal(action, observation, texts, supportedActions = ['click', 'fill', 'press', 'wait']) {
  if (!supportedActions.includes(action?.type)) return { ok: false, reason: 'unsupported_action' };
  if (['click', 'fill'].includes(action.type)) {
    const element = observation.elements.find(e => String(e.ref ?? e.id) === String(action.ref));
    if (!element) return { ok: false, reason: 'unobserved_reference' };
    if (action.type === 'fill' && (!['textbox', 'searchbox', 'combobox'].includes(element.role) || !texts.includes(action.text))) {
      return { ok: false, reason: 'invalid_fill' };
    }
    if (action.type === 'click' && ['textbox', 'searchbox'].includes(element.role)) return { ok: false, reason: 'invalid_click' };
  }
  if (action.type === 'press' && !['Enter', 'Tab', 'Escape', 'ArrowDown', 'ArrowUp', 'Space', 'PageDown', 'PageUp'].includes(action.key)) {
    return { ok: false, reason: 'unsupported_key' };
  }
  return { ok: true };
}

export function createMahmoudPolicy({ apiKey, model = 'jev-latest', ledger = createLedger(), fetchImpl = fetch } = {}) {
  if (typeof apiKey !== 'string' || apiKey.length <= 10) fail('missing_typesafe_key');
  let busy = false;
  return async function choose({ observation, task, history = [], prev = null,
    signal = AbortSignal.timeout(15000), supportedActions = ['click', 'fill', 'press', 'wait'] }) {
    if (busy) fail('concurrent_policy_call');
    if (signal.aborted) fail('cancelled');
    if (!task || typeof task.goal !== 'string' || !task.goal.trim() || task.goal.length > 6000) fail('invalid_goal');
    const texts = publicTexts(task.texts || []), snapshot = normalizeObservation(observation);
    busy = true;
    const started = performance.now();
    try {
      const jev = { ask: async (state, questions) => {
        if (signal.aborted) fail('cancelled');
        if (JSON.stringify({ state, questions }).length > 64000) fail('model_request_too_large');
        // Persist the attempt before any network request. Record usage before the
        // shared client or upstream agent interprets answer shape or confidence.
        const call = await ledger.begin({ provider: 'typesafe', model, purpose: 'choose' });
        const requestStarted = performance.now();
        let recorded = false;
        const decide = createJev({ apiKey, model, fetchImpl: async (url, options) => {
          const response = await fetchImpl(url, options);
          let data;
          try { data = await response.clone().json(); } catch { data = null; }
          const usage = data?.usage;
          const complete = validCount(usage?.input_tokens) && validCount(usage?.output_tokens);
          recorded = true;
          await ledger.finish(call, { status: response.ok ? 'response_received' : 'failed',
            latencyMs: performance.now() - requestStarted, actualModel: safeModel(data?.model),
            usageComplete: complete, inputTokens: validCount(usage?.input_tokens) ? usage.input_tokens : null,
            outputTokens: validCount(usage?.output_tokens) ? usage.output_tokens : null,
            costUsd: complete ? usage.input_tokens * 0.042 / 1e6 : null, costBasis: 'estimated',
            ...(response.ok ? {} : { reason: `provider_http_${response.status}` }) });
          return response;
        } });
        try { return await decide({ state, questions }, signal); }
        catch (error) {
          if (!recorded) await ledger.finish(call, { status: 'failed', latencyMs: performance.now() - requestStarted,
            reason: signal.aborted ? 'cancelled' : /^[a-z][a-z0-9_]{0,80}$/.test(error.code || '') ? error.code : 'provider_error',
            usageComplete: false, costUsd: null });
          throw error;
        }
      } };
      // Original step() contains the upstream corrective retry and private retry
      // prompt. Intercept exactly at execute(): the shared runner owns effects.
      const proposalReady = new Error('proposal_ready');
      let proposal, lastDecision;
      const agent = new JevBrowserAgent({ session: { snapshot: async () => snapshot, softState: async () => ({}) }, jev });
      agent.history = history.slice(-3).map(item => typeof item === 'string' ? item.slice(0, 1000)
        : JSON.stringify({ action: item.action, ref: item.ref, key: item.key, text: item.text,
          label: item.label, outcome: item.outcome }));
      const originalDecide = agent.decide.bind(agent);
      agent.decide = async (...args) => { lastDecision = await originalDecide(...args); return lastDecision; };
      agent.execute = async action => { proposal = action; throw proposalReady; };
      let terminal;
      try { terminal = await agent.step(task.goal, { texts, prev: publicPrevious(prev) }); }
      catch (error) { if (error !== proposalReady) throw error; }
      const metadata = { status: lastDecision?.status || terminal?.status,
        reasons: lastDecision?.reasons || [], retried: lastDecision?.retried === true,
        decision: lastDecision?.decision || null };
      if (!proposal) return { status: terminal?.status === 'done' ? 'done' : 'stop',
        reason: terminal?.status === 'done' ? null : `upstream_${terminal?.status || 'stopped'}`,
        action: null, upstream: metadata, totalMs: performance.now() - started, independentlyVerified: false };
      const action = mapUpstreamAction(proposal), validation = validateProposal(action, observation, texts, supportedActions);
      return { status: validation.ok ? 'action' : 'stop', reason: validation.ok ? null : validation.reason,
        action, upstream: metadata, totalMs: performance.now() - started, independentlyVerified: false };
    } finally { busy = false; }
  };
}
