import { appendFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { requireThat } from './core.mjs';
import { readJson, writeJson } from './storage.mjs';

// The formal job lifecycle. It is a durable, operator-facing view layered over
// the existing job kernel: the kernel still owns the browser; this module owns
// the named states, the transition evidence and the restart snapshot.
//
// Every transition records observation, selected action, action source,
// execution result, verification, elapsed time and the retry/recovery counters,
// so one file answers "what happened, who decided it, and what proved it".
export const lifecycleStates = ['PENDING', 'PROFILE_READY', 'BROWSER_ATTACHED', 'AUTH_CHECK',
  'LOGIN_IN_PROGRESS', 'WAITING_FOR_HUMAN', 'AUTHENTICATED', 'STUDIO_VERIFIED',
  'PERSISTENCE_CHECK', 'COMPLETE', 'FAILED', 'CANCELLED'];

export const terminalLifecycleStates = ['COMPLETE', 'FAILED', 'CANCELLED'];

// Forward-only except for the two genuine return paths: a security checkpoint
// resumes into the login flow, and a persistence check re-enters AUTHENTICATED
// when a restart lands on the sign-in surface and the flow recovers from there.
export const allowedLifecycleTransitions = {
  PENDING: ['PROFILE_READY', 'FAILED', 'CANCELLED'],
  PROFILE_READY: ['BROWSER_ATTACHED', 'FAILED', 'CANCELLED'],
  BROWSER_ATTACHED: ['AUTH_CHECK', 'FAILED', 'CANCELLED'],
  AUTH_CHECK: ['LOGIN_IN_PROGRESS', 'AUTHENTICATED', 'WAITING_FOR_HUMAN', 'FAILED', 'CANCELLED'],
  LOGIN_IN_PROGRESS: ['WAITING_FOR_HUMAN', 'AUTHENTICATED', 'FAILED', 'CANCELLED'],
  WAITING_FOR_HUMAN: ['LOGIN_IN_PROGRESS', 'PERSISTENCE_CHECK', 'AUTHENTICATED', 'FAILED', 'CANCELLED'],
  AUTHENTICATED: ['STUDIO_VERIFIED', 'PERSISTENCE_CHECK', 'COMPLETE', 'FAILED', 'CANCELLED'],
  STUDIO_VERIFIED: ['PERSISTENCE_CHECK', 'COMPLETE', 'AUTHENTICATED', 'FAILED', 'CANCELLED'],
  PERSISTENCE_CHECK: ['COMPLETE', 'AUTHENTICATED', 'FAILED', 'CANCELLED'],
  COMPLETE: [], FAILED: [], CANCELLED: [],
};
// WAITING_FOR_HUMAN ends a run without being terminal: the same job resumes on
// the same profile once the person has cleared the challenge.
export const lifecycleSettledStates = [...terminalLifecycleStates, 'WAITING_FOR_HUMAN'];

// Who chose the action that ran. `human` is a person acting in the preserved
// browser; `operator` is a human command (for example /cancel); the rest are
// machine decisions at their respective levels.
export const actionSources = ['deterministic', 'jev', 'frontier', 'operator', 'human', 'none'];

export function isTerminalLifecycleState(state) { return terminalLifecycleStates.includes(state); }

export function actionSourceForMethod(method) {
  if (!method) return 'none';
  const normalized = String(method).toLowerCase();
  if (normalized === 'exact-single-match') return 'deterministic';
  if (normalized.includes('frontier') || normalized.includes('vision')) return 'frontier';
  if (normalized.includes('operator')) return 'operator';
  return 'jev';
}

const emptyCounters = () => ({ modelCalls: 0, exactActions: 0, recoverySteps: 0, recoveryBudget: 0,
  recoveryStalls: 0, proxySwitches: 0, visualEscalations: 0, checkpointWaits: 0, retries: 0 });

// The lifecycle is append-only on disk: lifecycle.ndjson keeps every action and
// transition for the record, while lifecycle.json is the compact snapshot a
// restart reads first.
export function createLifecycle({ directory, job, now = Date.now, elapsed = () => performance.now(),
  redact = value => String(value ?? '') } = {}) {
  requireThat(directory, 'lifecycle_directory_required');
  requireThat(job?.id, 'lifecycle_job_required');
  const path = resolve(directory, 'lifecycle.json');
  const journalPath = resolve(directory, 'lifecycle.ndjson');
  let state = 'PENDING';
  let sequence = 0;
  let lastAction = null;
  let lastEntry = null;
  const counters = emptyCounters();
  const transitions = [];
  const startedAt = now();
  const safe = value => {
    if (value === null || value === undefined) return null;
    if (typeof value === 'string') return redact(value);
    if (Array.isArray(value)) return value.map(safe);
    if (typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, safe(item)]));
    return value;
  };
  const append = async entry => {
    try { await appendFile(journalPath, `${JSON.stringify(safe(entry))}\n`, { mode: 0o600 }); }
    catch { /* evidence is best-effort; lifecycle.json stays authoritative */ }
  };
  const snapshot = () => ({ version: 1, jobId: job.id, platform: job.platform || null,
    accountRef: job.accountRef || null, profileRef: job.profileRef || null, state,
    startedAt: new Date(startedAt).toISOString(), updatedAt: new Date(now()).toISOString(),
    elapsedMs: Math.round(elapsed()), counters: { ...counters }, lastAction,
    // The latest evidence for the CURRENT state, including same-state updates
    // (for example the reason a WAITING_FOR_HUMAN run settled).
    lastTransition: lastEntry ? { ...lastEntry } : null,
    transitions: transitions.map(entry => ({ ...entry })) });
  const persist = async () => {
    try { await mkdir(directory, { recursive: true, mode: 0o700 }); await writeJson(path, snapshot()); }
    catch { /* the caller's job log still records the run */ }
  };

  const lifecycle = {
    path, journalPath, get state() { return state; }, get counters() { return { ...counters }; },
    get transitions() { return transitions.map(entry => ({ ...entry })); },
    snapshot,
    // A same-state call updates the evidence trail without a state change; a new
    // state must be reachable from the current one.
    async transition(next, detail = {}) {
      requireThat(lifecycleStates.includes(next), 'unknown_lifecycle_state');
      const changed = next !== state;
      if (changed) requireThat(allowedLifecycleTransitions[state].includes(next), `illegal_lifecycle_transition:${state}->${next}`);
      const previous = state;
      state = next;
      if (detail.counters) Object.assign(counters, detail.counters);
      if (detail.action || detail.actionSource) {
        lastAction = { action: detail.action ?? lastAction?.action ?? null,
          actionSource: detail.actionSource ?? lastAction?.actionSource ?? 'none',
          at: new Date(now()).toISOString() };
      }
      sequence++;
      const entry = { seq: sequence, kind: changed ? 'state_transition' : 'state_update',
        at: new Date(now()).toISOString(), elapsedMs: Math.round(elapsed()),
        from: changed ? previous : state, state,
        profileId: detail.profileId ?? null,
        observation: detail.observation ? safe(detail.observation) : null,
        action: detail.action ?? null, actionSource: detail.actionSource ?? null,
        result: detail.result ?? null, verification: detail.verification ?? null,
        retries: detail.retries ?? counters.retries, recovery: detail.recovery ?? null,
        ...(detail.reason ? { reason: detail.reason } : {}),
        ...(detail.detail ? { detail: safe(detail.detail) } : {}),
      };
      if (changed) transitions.push(entry);
      lastEntry = entry;
      await append({ event: entry.kind, ...entry });
      await persist();
      return entry;
    },
    // Action-level evidence stays in the journal and the snapshot's lastAction.
    async recordAction(entry = {}) {
      sequence++;
      const record = { seq: sequence, kind: 'action', at: new Date(now()).toISOString(),
        elapsedMs: Math.round(elapsed()), state, action: entry.action ?? null,
        actionSource: entry.actionSource ?? 'none', phase: entry.phase ?? null,
        result: entry.result ?? null, verification: entry.verification ?? null,
        method: entry.method ?? null, confidence: entry.confidence ?? null,
        recoveryStep: entry.recoveryStep ?? null, budget: entry.budget ?? null,
        observation: entry.observation ? safe(entry.observation) : null };
      lastAction = { action: record.action, actionSource: record.actionSource, at: record.at };
      lastEntry = record;
      await append({ event: 'action', ...record });
      await persist();
      return record;
    },
    async addCounters(delta = {}) { for (const [key, value] of Object.entries(delta)) counters[key] += Number(value) || 0; await persist(); },
    async finish(finalState, detail = {}) {
      requireThat(lifecycleSettledStates.includes(finalState), 'unknown_lifecycle_settled_state');
      await lifecycle.transition(finalState, detail);
      return snapshot();
    },
  };
  return lifecycle;
}

// A restart reads the last snapshot. The job is resumable while it is
// unfinished and its profile mapping still exists; the orchestrator reopens the
// SAME profile rather than starting the flow over.
export async function loadLifecycle({ directory } = {}) {
  requireThat(directory, 'lifecycle_directory_required');
  const snapshot = await readJson(resolve(directory, 'lifecycle.json'), null).catch(() => null);
  if (!snapshot || snapshot.version !== 1) return null;
  return snapshot;
}

export function isResumableLifecycle(snapshot) {
  if (!snapshot) return false;
  if (terminalLifecycleStates.includes(snapshot.state)) return false;
  return typeof snapshot.profileRef === 'string' && snapshot.profileRef.length > 0;
}
