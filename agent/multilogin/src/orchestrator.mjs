import { resolve } from 'node:path';
import { createRedactor, errorCode, requireThat } from './core.mjs';
import { readJson, writeJson } from './storage.mjs';
import { validateJobs, runJobBatch, inspectJobPlan, CancelToken, jobStateForResult } from './jobs.mjs';
import { runLogin } from './login.mjs';
import { inspectStudio } from './youtube.mjs';
import { createLifecycle, loadLifecycle, isResumableLifecycle, isTerminalLifecycleState,
  actionSourceForMethod } from './lifecycle.mjs';
import { announceCheckpoint, createCheckpointStore, handleCommand, countActiveCheckpoints } from './human-checkpoint.mjs';

// ONE job, ONE process, ONE lifecycle. The orchestrator wraps the tested job
// kernel (profile ownership -> launcher -> CDP -> login -> Studio -> restart
// persistence) and adds the operator-facing layer:
//
//   - the formal lifecycle state machine (lifecycle.mjs), durably persisted
//   - automatic Telegram announcement of a human checkpoint
//   - Telegram commands (/status, /done, /cancel) while the job waits
//   - a structured result.json next to the job evidence
//   - restart detection: the same profile is reopened, never re-created
//
// It never answers a challenge, never fills a challenge field and never changes
// proxy or browser identity to evade a checkpoint.
export const orchestratorSchema = 'browser-job-result/1';

const stateForJobState = ({ state = '', phase = null }) => {
  if (state === 'starting_profile') return 'PROFILE_READY';
  if (state === 'browser_ready') return 'BROWSER_ATTACHED';
  if (state === 'waiting_for_human') return 'WAITING_FOR_HUMAN';
  if (state === 'running') return phase === 'session_reopen' ? 'PERSISTENCE_CHECK' : 'LOGIN_IN_PROGRESS';
  if (state === 'success') return 'COMPLETE';
  if (state === 'failed') return 'FAILED';
  if (state === 'cancelled') return 'CANCELLED';
  return null;
};

const resultStatusForState = state => ({
  COMPLETE: 'completed', WAITING_FOR_HUMAN: 'waiting_for_human', FAILED: 'failed',
  CANCELLED: 'cancelled' }[state] || 'failed');

// Read-only restart inspection: is there an unfinished run for this job, and is
// a checkpoint waiting? No browser is touched and no lock is taken.
export async function inspectOrchestratorResume({ directory, job, accountIndex = null, jobs = null } = {}) {
  const jobDirectory = resolve(directory, 'jobs', job.id);
  const [snapshot, checkpoint, jobDocument] = await Promise.all([
    loadLifecycle({ directory: jobDirectory }),
    createCheckpointStore({ directory: jobDirectory }).load(),
    readJson(resolve(jobDirectory, 'job.json'), null).catch(() => null),
  ]);
  const resumable = isResumableLifecycle(snapshot);
  const expired = checkpoint?.expiresAt ? Date.parse(checkpoint.expiresAt) <= Date.now() : false;
  return {
    directory: jobDirectory,
    resumable,
    from: snapshot?.state ?? null,
    terminal: snapshot ? isTerminalLifecycleState(snapshot.state) : false,
    profileId: jobDocument?.profileId ?? snapshot?.profileId ?? null,
    checkpoint: checkpoint ? { id: checkpoint.id, state: checkpoint.state, reason: checkpoint.reason,
      expiresAt: checkpoint.expiresAt, expired, screenshot: checkpoint.screenshot ?? null,
      notifiedAt: checkpoint.notifiedAt ?? null } : null,
    jobState: jobDocument?.state ?? null,
    plan: accountIndex && jobs ? await inspectJobPlan({ jobs, accountIndex, directory }).catch(() => null) : null,
  };
}

// Telegram long-poll for the duration of a human checkpoint. `/done` cannot
// resume anything by itself: the job's own live re-observation is the gate, so
// the reply says exactly that. `/cancel` aborts the job's cancel token.
export function createTelegramCommandLoop({ notifier, directory, cancel, pollMs = 2000,
  onEvent = () => {}, now = Date.now }) {
  let active = false;
  const handled = [];
  return {
    handled,
    get active() { return active; },
    async start({ jobId }) {
      if (!notifier || active) return;
      active = true;
      const store = createCheckpointStore({ directory: resolve(directory, 'jobs', jobId) });
      const tick = async () => {
        if (!active) return;
        try {
          const commands = await notifier.poll();
          for (const parsed of commands) {
            const checkpoint = await store.load();
            const outcome = await handleCommand({ parsed, notifier, store,
              loadCheckpoint: async id => (checkpoint && checkpoint.id === id ? checkpoint : null),
              loadActive: async () => countActiveCheckpoints({ directory }),
              verify: null });
            handled.push({ command: parsed.command, action: outcome.action, at: new Date(now()).toISOString() });
            await onEvent({ phase: 'telegram', command: parsed.command, action: outcome.action });
            if (outcome.action === 'cancelled') cancel.abort('cancelled_by_telegram');
          }
        } catch (error) {
          await onEvent({ phase: 'telegram', error: errorCode(error) });
        }
        if (active) setTimeout(tick, pollMs).unref?.();
      };
      await tick();
    },
    stop() { active = false; },
  };
}

// Run exactly one job end to end. All heavy primitives are injected so the fake
// backend and the live deployment share this exact path.
export async function runSingleJob({ job, accountIndex, config, directory, api, guideFactory,
  connectImpl = undefined, seedImpl = undefined, flowImpl = runLogin, studioImpl = inspectStudio,
  notifier = null, notify = true, cancel = new CancelToken(), humanCheckpointPollMs = 2000,
  telegramPollMs = 2000, telegram = true, memory = null, resume = null, preserveOnCheckpoint = false,
  onEvent = null, now = Date.now, elapsed = () => performance.now() } = {}) {
  requireThat(directory, 'orchestrator_directory_required');
  requireThat(accountIndex instanceof Map, 'account_source_required');
  const [validated] = validateJobs({ jobs: [job] });
  requireThat(validated.id === job.id, 'invalid_single_job');
  const account = accountIndex.get(job.accountRef);
  requireThat(account, 'unknown_account_ref');
  const jobDirectory = resolve(directory, 'jobs', job.id);
  const redact = createRedactor([account.username, account.password, account.totp, account.recoveryEmail].filter(Boolean));
  const resumeInfo = resume || await inspectOrchestratorResume({ directory, job });
  const lifecycle = createLifecycle({ directory: jobDirectory, job, redact, now, elapsed });
  const emit = async entry => { if (onEvent) { try { await onEvent(entry); } catch { /* streaming is best-effort */ } } };
  if (resumeInfo.resumable) {
    await lifecycle.transition('PENDING', { action: 'resume', actionSource: 'operator',
      reason: `resumed_from_${resumeInfo.from}`, detail: { resumedFrom: resumeInfo.from,
        checkpoint: resumeInfo.checkpoint?.id ?? null, sameProfile: true } });
    await lifecycle.recordAction({ action: 'resume', actionSource: 'operator',
      result: `resumed_from_${resumeInfo.from}`, verification: 'same_profile_reopened' });
  }
  await emit({ event: 'lifecycle', state: lifecycle.state, jobId: job.id, resume: resumeInfo.resumable,
    from: resumeInfo.from, profileId: resumeInfo.profileId });

  // --- Action evidence -------------------------------------------------------
  let lastRecoveryStep = 0;
  const recordStep = async detail => {
    if (!detail || typeof detail !== 'object') return;
    if (detail.phase === 'receipt') {
      await lifecycle.recordAction({ action: detail.operation, actionSource: detail.decisionSource || 'none',
        phase: 'receipt', result: detail.state, verification: detail.postconditionMet === true ? 'postcondition_met' : null });
      return;
    }
    if (detail.phase === 'jev_recovery') {
      if (detail.recoveryStep && detail.recoveryStep > lastRecoveryStep) {
        await lifecycle.addCounters({ recoverySteps: detail.recoveryStep - lastRecoveryStep });
        lastRecoveryStep = detail.recoveryStep;
      }
      if (detail.state === 'decision') {
        if (detail.budget) await lifecycle.addCounters({ recoveryBudget: Math.max(0, detail.budget - lifecycle.counters.recoveryBudget) });
        await lifecycle.recordAction({ action: detail.action, phase: 'jev_recovery',
          actionSource: actionSourceForMethod(detail.method), method: detail.method,
          confidence: detail.confidence, recoveryStep: detail.recoveryStep, budget: detail.budget,
          result: 'selected' });
      } else {
        if (['budget_exhausted', 'stalled'].includes(detail.state)) await lifecycle.addCounters({ recoveryStalls: 1 });
        await lifecycle.recordAction({ phase: 'jev_recovery', result: detail.state,
          recoveryStep: detail.recoveryStep ?? null, budget: detail.budget ?? null,
          observation: detail.reason ? { reason: detail.reason } : null });
      }
      return;
    }
    if (detail.phase === 'attention') {
      await lifecycle.recordAction({ phase: 'attention', result: detail.reason || 'attention',
        observation: { reason: detail.reason || 'attention' } });
      return;
    }
    // Checkpoint events arrive through the job's own emit, not this flow's
    // wrapper, so the counters are derived from the WAITING_FOR_HUMAN
    // transitions in onJobState instead (one wait per checkpoint).
    if (detail.phase === 'human_checkpoint') return;
    if (detail.phase === 'transport_recovery') { await lifecycle.addCounters({ proxySwitches: 1 }); return; }
    if (detail.phase === 'login' || detail.phase === 'verify_reopen') {
      if (detail.state === 'before') {
        await lifecycle.recordAction({ action: detail.action, phase: detail.phase,
          actionSource: actionSourceForMethod(detail.method), method: detail.method,
          confidence: detail.confidence, result: 'selected' });
        await lifecycle.addCounters({ modelCalls: detail.method && detail.method !== 'exact-single-match' ? 1 : 0,
          exactActions: detail.method === 'exact-single-match' ? 1 : 0 });
      } else if (detail.state === 'after') {
        await lifecycle.recordAction({ action: detail.action, phase: detail.phase, result: 'executed',
          verification: 'postcondition_satisfied' });
      } else if (detail.state === 'stale' || detail.state === 'stale_decision') {
        await lifecycle.recordAction({ action: detail.action ?? null, phase: detail.phase,
          result: detail.state, verification: 'reobserve' });
      }
    }
  };

  const wrappedFlow = async args => {
    const verifyOnly = args?.verifyOnly === true;
    if (verifyOnly) {
      if (lifecycle.state !== 'PERSISTENCE_CHECK') {
        await lifecycle.transition('PERSISTENCE_CHECK', { action: 'verify_restart_persistence',
          actionSource: 'deterministic', result: 'started', verification: 'restart_persistence' });
      } else {
        await lifecycle.transition('PERSISTENCE_CHECK', { result: 'started' });
      }
    } else if (lifecycle.state === 'WAITING_FOR_HUMAN') {
      await lifecycle.transition('LOGIN_IN_PROGRESS', { action: 'resume_after_human', actionSource: 'human',
        result: 'started', detail: { resumedFromCheckpoint: true } });
    }
    const sink = args?.onStep || (async () => {});
    const result = await flowImpl({ ...args, recoveryMemory: memory,
      onStep: async detail => { await recordStep(detail).catch(() => {}); await sink(detail); } });
    if (verifyOnly) {
      await lifecycle.transition('PERSISTENCE_CHECK', { result: 'verified',
        verification: 'restart_persistence_verified', detail: { steps: result?.steps ?? null } });
    } else {
      await lifecycle.transition('AUTHENTICATED', { action: 'verify_identity', actionSource: 'deterministic',
        result: 'verified', verification: 'signed_in_identity_verified', detail: { steps: result?.steps ?? null } });
    }
    return result;
  };

  const wrappedStudio = async args => {
    const result = await studioImpl(args);
    if (result?.authenticated) {
      if (lifecycle.state === 'AUTHENTICATED') {
        await lifecycle.transition('STUDIO_VERIFIED', { action: 'open_youtube_studio', actionSource: 'deterministic',
          result: 'verified', verification: 'studio_authenticated',
          detail: { state: result.state, channel: result.channel?.name ?? null } });
      } else {
        await lifecycle.recordAction({ action: 'open_youtube_studio', result: 'verified',
          verification: 'studio_authenticated_after_restart' });
      }
    } else {
      await lifecycle.recordAction({ action: 'open_youtube_studio', result: result?.state || 'not_authenticated' });
    }
    return result;
  };

  // --- Human checkpoint: announce once, then accept commands while waiting ----
  const telegramLoop = createTelegramCommandLoop({ directory, notifier: telegram && notifier ? notifier : null,
    cancel, pollMs: telegramPollMs, onEvent: emit, now });
  let announced = null;
  let announcedFor = null;
  const onJobState = async entry => {
    const target = stateForJobState(entry);
    if (entry.state === 'running' && lifecycle.state === 'BROWSER_ATTACHED'
      && entry.phase !== 'session_reopen') {
      await lifecycle.transition('AUTH_CHECK', { result: 'checking_authentication_state',
        verification: 'initial_observation' });
    }
    if (target) {
      // A transition out of WAITING_FOR_HUMAN is a person having cleared the
      // challenge: it is recorded as human-sourced with explicit verification.
      const resumedFromCheckpoint = lifecycle.state === 'WAITING_FOR_HUMAN'
        && (entry.resumedFromCheckpoint === true || entry.state === 'running');
      if (resumedFromCheckpoint) {
        // The live re-observation is the gate: the checkpoint record settles as
        // resumed when the job itself sees the challenge gone.
        const store = createCheckpointStore({ directory: jobDirectory });
        const checkpoint = await store.load().catch(() => null);
        if (checkpoint?.state === 'waiting') {
          await store.transition(checkpoint, 'resumed', { by: 'live_reobservation' }).catch(() => {});
        }
      }
      const detail = resumedFromCheckpoint
        ? { action: 'human_verification', actionSource: 'human', verification: 'human_cleared_checkpoint',
          result: entry.state, ...(entry.waitedMs ? { detail: { waitedMs: entry.waitedMs } } : {}) }
        : { action: entry.state === 'starting_profile' ? 'resolve_profile' : null,
          actionSource: entry.state === 'starting_profile' ? 'deterministic' : null,
          reason: entry.reason || null, result: entry.state,
          ...(entry.waitedMs ? { detail: { waitedMs: entry.waitedMs } } : {}) };
      if (lifecycle.state !== target) await lifecycle.transition(target, detail);
      else await lifecycle.transition(target, { reason: entry.reason || null, result: entry.state });
    }
    if (entry.state === 'waiting_for_human') {
      const reason = entry.reason || 'human_verification_required';
      await lifecycle.addCounters({ checkpointWaits: 1 });
      // The checkpoint record is persisted even when no notifier is configured,
      // so a later run can detect the waiting state and resume the same profile.
      if (notify && (announcedFor !== reason || !announced)) {
        try {
          announced = await announceCheckpoint({ directory: jobDirectory, notifier: notifier || null,
            seconds: config.humanCheckpointSeconds ?? 1800, reason });
          announcedFor = reason;
          await lifecycle.recordAction({ action: 'announce_checkpoint', actionSource: 'operator',
            result: announced.delivery?.delivered || (announced.repeated ? 'reused' : 'recorded'),
            verification: announced.checkpoint?.id ?? null });
          await emit({ phase: 'checkpoint_announce', jobId: job.id,
            checkpointId: announced.checkpoint?.id ?? null, repeated: announced.repeated,
            delivered: announced.delivery?.delivered ?? null });
        } catch (error) {
          await lifecycle.recordAction({ action: 'announce_checkpoint', result: errorCode(error) });
        }
      }
      await telegramLoop.start({ jobId: job.id });
    } else if (telegramLoop.active && entry.state !== 'waiting_for_human') {
      telegramLoop.stop();
    }
    await emit({ event: 'job_state', jobId: entry.jobId, state: entry.state, lifecycleState: lifecycle.state,
      reason: entry.reason || null, elapsedMs: entry.elapsedMs });
  };

  // --- The kernel run ---------------------------------------------------------
  let batch = null; let failure = null;
  try {
    batch = await runJobBatch({ jobs: [job], accountIndex, config, directory, concurrency: 1, api, guideFactory,
      ...(connectImpl ? { connectImpl } : {}), ...(seedImpl ? { seedImpl } : {}),
      ...(preserveOnCheckpoint ? { preserveOnCheckpoint } : {}),
      onJobState, humanCheckpointPollMs, cancel,
      flowImpl: wrappedFlow, studioImpl: wrappedStudio });
  } catch (error) { failure = error; }
  telegramLoop.stop();
  if (failure) {
    if (lifecycle.state !== 'FAILED' && lifecycle.state !== 'CANCELLED') {
      await lifecycle.finish(errorCode(failure) === 'cancelled' ? 'CANCELLED' : 'FAILED',
        { reason: errorCode(failure), actionSource: 'deterministic' });
    }
    throw failure;
  }

  const summaryJob = batch.summary.jobs.find(item => item.id === job.id) || {};
  const mapped = summaryJob.state;
  const previousState = lifecycle.state;
  let finalState = lifecycle.state;
  if (mapped === 'success') finalState = 'COMPLETE';
  else if (mapped === 'waiting_for_human') finalState = 'WAITING_FOR_HUMAN';
  else if (mapped === 'cancelled') finalState = 'CANCELLED';
  else finalState = 'FAILED';
  if (lifecycle.state !== finalState) {
    await lifecycle.finish(finalState, { reason: summaryJob.reason || null,
      actionSource: summaryJob.reason === 'cancelled' ? 'operator' : 'deterministic',
      result: mapped, verification: finalState === 'COMPLETE' ? completionVerification(previousState) : null });
  } else {
    await lifecycle.transition(finalState, { reason: summaryJob.reason || null, result: mapped,
      verification: finalState === 'COMPLETE' ? completionVerification(previousState) : null });
  }

  const jobDocument = await readJson(resolve(jobDirectory, 'job.json'), null).catch(() => null);
  const checkpoint = await createCheckpointStore({ directory: jobDirectory }).load().catch(() => null);
  const accountResult = (batch.report.accounts || []).find(item => item.accountId === jobDocument?.accountId) || {};
  const result = {
    schema: orchestratorSchema,
    status: resultStatusForState(lifecycle.state),
    jobId: job.id, platform: job.platform, accountRef: job.accountRef, profileRef: job.profileRef,
    accountId: jobDocument?.accountId ?? null, profileId: jobDocument?.profileId ?? summaryJob.profileId ?? null,
    lifecycleState: lifecycle.state, reason: summaryJob.reason || null,
    startedAt: lifecycle.snapshot().startedAt, finishedAt: new Date(now()).toISOString(),
    durationMs: summaryJob.durationMs ?? lifecycle.snapshot().elapsedMs,
    resumedFrom: resumeInfo.resumable ? resumeInfo.from : null,
    sameProfileAsPreviousRun: resumeInfo.resumable === true,
    counters: lifecycle.counters,
    transitions: lifecycle.transitions.map(entry => ({ state: entry.state, at: entry.at, elapsedMs: entry.elapsedMs,
      reason: entry.reason ?? null, action: entry.action ?? null, actionSource: entry.actionSource ?? null,
      result: entry.result ?? null, verification: entry.verification ?? null, recovery: entry.recovery ?? null })),
    verification: {
      login: jobDocument?.login?.verified ?? null,
      reopen: jobDocument?.login?.reopenVerified ?? null,
      studio: jobDocument?.channel?.authenticated ?? null,
      studioAfterRestart: jobDocument?.studioAfterRestart?.authenticated ?? null,
      restartPersistence: finalState === 'COMPLETE' && mapped === 'success'
        ? (jobDocument?.login?.reopenVerified ?? null) : null,
    },
    checkpoint: checkpoint ? { id: checkpoint.id, state: checkpoint.state, reason: checkpoint.reason,
      expiresAt: checkpoint.expiresAt, screenshot: checkpoint.screenshot ?? null,
      notifiedAt: checkpoint.notifiedAt ?? null, documentMessageId: checkpoint.documentMessageId ?? null } : null,
    telegram: { announced: Boolean(announced), commands: telegramLoop.handled,
      notifiedAt: announced?.checkpoint?.notifiedAt ?? null },
    screenshots: (jobDocument?.screenshots || []).map(item => ({ label: item.label,
      path: item.path ?? null, skipped: item.skipped ?? null, fullPath: item.fullPath ?? null,
      regionPath: item.regionPath ?? null, contextPath: item.contextPath ?? null })),
    jobDirectory,
    jobPath: resolve(jobDirectory, 'job.json'),
    lifecyclePath: lifecycle.path,
    resultPath: resolve(jobDirectory, 'result.json'),
    reportPath: batch.reportPath ?? null,
    summaryPath: batch.summaryPath ?? null,
    jev: jobDocument?.jev ?? null,
    recovery: accountResult.login?.recovery ?? null,
    visualEscalations: accountResult.login?.visualEscalations ?? null,
  };
  await writeJson(result.resultPath, result).catch(() => {});
  await emit({ event: 'result', ...result });
  return { result, lifecycle, batch, resume: resumeInfo };
}

function completionVerification(state) {
  if (state === 'PERSISTENCE_CHECK' || state === 'COMPLETE') return 'restart_persistence_verified';
  if (state === 'STUDIO_VERIFIED') return 'studio_authenticated';
  return 'signed_in_identity_verified';
}

// Convenience for callers that only need the terminal outcome.
export function orchestrationExitCode(result = {}) {
  if (result.status === 'completed') return 0;
  if (result.status === 'waiting_for_human') return 2;
  return 1;
}

export { jobStateForResult };
