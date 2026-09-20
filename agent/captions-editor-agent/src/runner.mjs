import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { assert, resolveAsset, Stop } from './policy.mjs';
import { journal, saveJson } from './storage.mjs';
import { openBrowser, CaptionsAdapter, onboarded } from './browser.mjs';
import { probe, verifyExport } from './verify.mjs';
export async function runEditor({ id, task, config, dataDir, signal, progress, decide, open = openBrowser, verify = verifyExport, Adapter = CaptionsAdapter }) {
  const started = performance.now(), dir = join(dataDir, 'artifacts', id);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const deadline = AbortSignal.timeout(config.maxRunMs), combined = AbortSignal.any([signal, deadline]);
  const metrics = { wallMs: 0, browserMs: 0, modelMs: 0, modelCalls: 0, inputTokens: 0, outputTokens: 0, humanInterventions: 0,
    providerCostUsd: null, infrastructureCostUsd: null, purchases: 0, stages: [] };
  const result = { status: 'needs_attention', reason: null, checklist: { testProjectOpened: false, uploaded: false, trimmed: false, captionsCreated: false, copySaved: false, exported: false, ffmpegVerified: false }, metrics };
  let session, adapter, stage = 'preflight';
  async function event(data) { await journal(dir, data); }
  const closeOnAbort = () => { if (session) void session.context.close().catch(() => {}); };
  combined.addEventListener('abort', closeOnAbort, { once: true });
  async function step(name, fn) {
    stage = name; const start = performance.now(); await event({ type: 'stage_begin', stage: name });
    const data = await fn(); const ms = performance.now() - start;
    metrics.stages.push({ name, wallMs: ms }); await event({ type: 'stage_verified', stage: name, wallMs: ms });
    await progress({ stage, checklist: result.checklist, metrics }); return data;
  }
  try {
    combined.throwIfAborted(); assert(await onboarded(dataDir), 'test_account_onboarding_required');
    const asset = await resolveAsset(config, task.assetId), metadata = await probe(asset.path);
    const v = metadata.streams.find(x => x.codec_type === 'video');
    assert(v && Math.abs(v.width / v.height - 9 / 16) < 0.001, 'source_must_be_portrait_916');
    assert(task.trimEnd <= Number(metadata.format.duration) + 0.05, 'trim_exceeds_source');
    await event({ type: 'source_authorized', assetId: task.assetId, sha256: asset.sha256, bytes: asset.bytes, dimensions: [v.width, v.height] });
    session = await step('browser_start', () => open(config, dataDir, { onBlocked: detail => void event({ type: 'network_blocked', ...detail }) }));
    const choose = decide ? async state => {
      assert(metrics.modelCalls < config.maxModelCalls, 'model_call_budget_exceeded'); metrics.modelCalls++;
      const answer = await decide(state, combined);
      metrics.modelMs += answer.latencyMs; metrics.inputTokens += answer.usage.input_tokens; metrics.outputTokens += answer.usage.output_tokens;
      await event({ type: 'model_choice', observation: state.observation, choice: answer.choice, rawChoice: answer.rawChoice, confidence: answer.confidence, usage: answer.usage });
      return answer.choice;
    } : null;
    adapter = new Adapter({ session, config, artifactDir: dir, event, signal: combined, choose });
    await step('open_test_project', async () => { await adapter.start(); await adapter.createProject(); result.checklist.testProjectOpened = true; });
    await step('upload', async () => { await adapter.upload(asset); result.checklist.uploaded = true; });
    await step('trim', async () => { result.trim = await adapter.trim(task); result.checklist.trimmed = true; });
    await step('ai_captions', async () => { await adapter.captions(task); result.checklist.captionsCreated = true; });
    await step('save_copy', async () => { result.project = await adapter.saveCopy(id); result.checklist.copySaved = true; });
    const output = await step('export', async () => { const path = await adapter.exportVideo(); result.checklist.exported = true; return path; });
    const check = await step('verify', () => verify({ source: asset.path, output, task, directory: dir }));
    result.verification = check; result.checklist.ffmpegVerified = check.passed;
    await saveJson(join(dir, 'verification.json'), check);
    assert(check.passed, 'export_verification_failed'); result.status = 'complete';
  } catch (error) {
    result.status = signal.aborted ? 'cancelled' : 'needs_attention';
    result.reason = signal.aborted ? 'cancelled' : deadline.aborted ? 'time_budget_exceeded' : error instanceof Stop ? error.code : 'browser_or_runtime_error';
    result.blocker = { stage, code: result.reason }; metrics.humanInterventions = result.status === 'needs_attention' ? 1 : 0;
    await event({ type: 'stopped', reason: result.reason, stage });
    if (adapter && !combined.aborted) await adapter.observe('blocked', true).catch(() => {});
  } finally {
    combined.removeEventListener('abort', closeOnAbort); await session?.close().catch(() => {});
    metrics.wallMs = performance.now() - started;
    metrics.browserMs = metrics.stages.filter(x => x.name !== 'verify').reduce((a, b) => a + b.wallMs, 0) - metrics.modelMs;
    await saveJson(join(dir, 'report.json'), { ...result, jobId: id, recordedAt: new Date().toISOString() });
  }
  return result;
}
