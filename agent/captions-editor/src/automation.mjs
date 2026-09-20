import { appendFile, readFile, open, rename, mkdir, realpath, stat, copyFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { structured } from './mcp.mjs';
import { SESSION_ID } from './config.mjs';
import { networkSummary } from './network.mjs';

const idPattern = /^[a-zA-Z0-9_-]{1,80}$/;
const forbidden = /\b(?:buy|purchase|upgrade|subscribe|subscription|billing|checkout|payment|pay|publish|share|delete|remove|trash|account|log\s*in|log\s*out|sign\s*in|sign\s*out|sign\s*up|password|verification|oauth)\b/i;
const operations = new Set(['upload', 'fill_prompt', 'click', 'uncheck', 'export']);
export const digest = value => createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value)).digest('hex');
export class GuardError extends Error { constructor(code) { super(code); this.code = code; } }
const guard = (condition, code) => { if (!condition) throw new GuardError(code); };
const exactKeys = (object, names) => guard(object && typeof object === 'object' && !Array.isArray(object) && Object.keys(object).every(key => names.includes(key)), 'unexpected_field');
const validId = id => guard(typeof id === 'string' && idPattern.test(id), 'invalid_identifier');
export function validateManifest(value, { allowedOrigin = 'https://captions.ai' } = {}) {
  exactKeys(value, ['version', 'assets', 'jobs']); guard(value.version === 1 && Array.isArray(value.assets) && Array.isArray(value.jobs), 'invalid_manifest');
  guard(value.assets.length <= 30 && value.jobs.length <= 30, 'manifest_too_large');
  const assets = new Map(); const jobs = new Map();
  for (const asset of value.assets) {
    exactKeys(asset, ['id', 'file', 'sha256']); validId(asset.id);
    guard(typeof asset.file === 'string' && /^[a-zA-Z0-9._-]+\.mp4$/.test(asset.file) && !asset.file.startsWith('.'), 'invalid_asset_file');
    guard(/^[a-f0-9]{64}$/.test(asset.sha256), 'invalid_asset_hash'); guard(!assets.has(asset.id), 'duplicate_asset'); assets.set(asset.id, asset);
  }
  for (const job of value.jobs) {
    exactKeys(job, ['id', 'assetId', 'prompt', 'startUrl', 'steps']); validId(job.id); guard(assets.has(job.assetId), 'unknown_asset');
    guard(typeof job.prompt === 'string' && job.prompt.length <= 4000, 'invalid_prompt');
    const url = new URL(job.startUrl); guard(url.origin === allowedOrigin && !url.username && !url.password && !url.hash, 'invalid_start_url');
    guard(Array.isArray(job.steps) && job.steps.length <= 30, 'invalid_steps');
    const stepIds = new Set();
    for (const step of job.steps) {
      exactKeys(step, ['id', 'operation', 'controls', 'verifyText', 'mayNavigate', 'verifyTimeoutMs']); validId(step.id);
      guard(!stepIds.has(step.id), 'duplicate_step'); stepIds.add(step.id); guard(operations.has(step.operation), 'invalid_operation');
      guard(Array.isArray(step.controls) && step.controls.length >= 1 && step.controls.length <= 10, 'invalid_controls');
      for (const control of step.controls) {
        exactKeys(control, ['role', 'name', 'accept', 'multiple', 'labelContext']);
        guard(control.accept === undefined || (control.role === 'file' && typeof control.accept === 'string' && control.accept.length <= 500), 'invalid_file_accept');
        guard(control.multiple === undefined || (control.role === 'file' && typeof control.multiple === 'boolean'), 'invalid_file_multiple'); guard(['button', 'link', 'textbox', 'checkbox', 'switch', 'file', 'input'].includes(control.role), 'invalid_role');
        guard(typeof control.name === 'string' && (control.name.length > 0 || (['checkbox', 'switch'].includes(control.role) && typeof control.labelContext === 'string' && control.labelContext.length > 0)) && control.name.length <= 180 && !forbidden.test(control.name), 'forbidden_control');
        guard(control.labelContext === undefined || (['checkbox', 'switch'].includes(control.role) && typeof control.labelContext === 'string' && control.labelContext.length <= 200 && !forbidden.test(control.labelContext)), 'invalid_label_context');
        if (step.operation === 'upload') guard(control.role === 'file', 'upload_requires_file_input');
        if (step.operation === 'fill_prompt') guard(control.role === 'textbox', 'prompt_requires_textbox');
        if (step.operation === 'uncheck') guard(['checkbox', 'switch'].includes(control.role), 'uncheck_requires_checkbox');
      }
      guard(step.operation === 'export' || (typeof step.verifyText === 'string' && step.verifyText.length > 0 && step.verifyText.length <= 200), 'postcondition_required');
      guard(step.mayNavigate === undefined || typeof step.mayNavigate === 'boolean', 'invalid_navigation_policy');
      guard(step.verifyTimeoutMs === undefined || (Number.isInteger(step.verifyTimeoutMs) && step.verifyTimeoutMs >= 1000 && step.verifyTimeoutMs <= 60000), 'invalid_verify_timeout');
    }
    guard(!jobs.has(job.id), 'duplicate_job'); jobs.set(job.id, job);
  }
  return { assets, jobs };
}
const signature = element => JSON.stringify({ role: element.role, name: element.name, labelContext: element.label_context || '', href: element.href || '', inputType: element.input_type || '', disabled: Boolean(element.disabled), checked: element.checked ?? null, hidden: Boolean(element.hidden), accept: element.accept || '', multiple: Boolean(element.multiple) });
const snapshotHash = snapshot => digest({ url: snapshot.url, elements: snapshot.elements.map(signature) });
const match = (element, controls) => !element.disabled && !forbidden.test(element.name || '') && controls.some(control => control.role === element.role && control.name === element.name && (control.labelContext === undefined || control.labelContext === element.label_context) && (control.accept === undefined || control.accept === element.accept) && (control.multiple === undefined || control.multiple === element.multiple));

export class AutomationBridge {
  constructor({ client, stateDir, assetsDir = '/app/assets', manifestFile, manifestLoader, chooser = null, sessionId = SESSION_ID, allowedOrigin = 'https://captions.ai' }) {
    Object.assign(this, { client, stateDir, assetsDir, manifestFile, chooser, sessionId, allowedOrigin });
    this.manifestLoader = manifestLoader || (async () => JSON.parse(await readFile(manifestFile, 'utf8')));
    this.latest = null; this.selections = new Map(); this.busy = false;
  }
  async manifest() { return validateManifest(await this.manifestLoader(), { allowedOrigin: this.allowedOrigin }); }
  async initialize() { await mkdir(path.join(this.stateDir, 'automation'), { recursive: true, mode: 0o700 }); }
  async state(jobId) {
    validId(jobId);
    try { return JSON.parse(await readFile(path.join(this.stateDir, 'automation', jobId + '.json'), 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return { id: jobId, nextStep: 0, receipts: {}, completedSteps: [], attempts: {}, status: 'ready' }; throw error; }
  }
  async save(state) {
    // One in-process action owner, plus the enclosing service/profile owner lock.
    const directory = path.join(this.stateDir, 'automation'); const temporary = path.join(directory, state.id + '.' + randomUUID() + '.tmp');
    const file = await open(temporary, 'wx', 0o600);
    try { await file.writeFile(JSON.stringify(state)); await file.sync(); } finally { await file.close(); }
    await rename(temporary, path.join(directory, state.id + '.json'));
    const dir = await open(directory, 'r'); try { await dir.sync(); } finally { await dir.close(); }
  }
  async log(record) { await appendFile(path.join(this.stateDir, 'automation', 'events.jsonl'), JSON.stringify({ at: new Date().toISOString(), ...record }) + '\n', { mode: 0o600 }); }
  async ownBrowser(work) {
    guard(!this.busy, 'browser_busy'); this.busy = true;
    try { return await work(); } finally { this.busy = false; }
  }
  async observe() {
    return this.ownBrowser(() => this.observeOwned());
  }
  async observeOwned() {
    const started = performance.now();
    const snapshot = structured(await this.client.call('browser_snapshot', { session_id: this.sessionId, interactive_only: true, include_values: false, max_elements: 200 }));
    guard(Array.isArray(snapshot.elements) && typeof snapshot.url === 'string', 'invalid_snapshot');
    this.latest = { token: randomUUID(), snapshot, hash: snapshotHash(snapshot), at: Date.now(), observeMs: performance.now() - started };
    this.selections.clear();
    return { ...snapshot, observationToken: this.latest.token, observationAgeLimitMs: 60000, observeMs: this.latest.observeMs };
  }
  observation(token) {
    guard(this.latest && token === this.latest.token && Date.now() - this.latest.at < 60000, 'stale_observation');
    return this.latest;
  }
  async jobContext(jobId) {
    const manifest = await this.manifest(); const job = manifest.jobs.get(jobId); guard(job, 'unknown_job');
    const state = await this.state(jobId); guard(state.status !== 'cancelled', 'job_cancelled');
    const asset = manifest.assets.get(job.assetId);
    const coreHash = digest({ id: job.id, asset, prompt: job.prompt, startUrl: job.startUrl });
    guard(!state.coreHash || state.coreHash === coreHash, 'job_definition_changed');
    guard(state.completedSteps.every((hash, index) => hash === digest(job.steps[index])), 'completed_step_changed');
    const step = job.steps[state.nextStep]; guard(step, 'no_calibrated_next_step');
    return { manifest, job, state, asset, step, coreHash };
  }
  async select(input) {
    return this.ownBrowser(() => this.selectOwned(input));
  }
  async selectReady(input) {
    exactKeys(input, ['jobId', 'waitMs']); validId(input.jobId);
    const waitMs = input.waitMs ?? 5000;
    guard(Number.isInteger(waitMs) && waitMs >= 0 && waitMs <= 10000, 'invalid_readiness_wait');
    return this.ownBrowser(async () => {
      const started = performance.now(); let observations = 0;
      const initial = await this.jobContext(input.jobId);
      const stepHash = digest(initial.step);
      try {
        for (;;) {
          const context = await this.jobContext(input.jobId);
          guard(context.coreHash === initial.coreHash && digest(context.step) === stepHash, 'job_definition_changed');
          guard(!Object.entries(context.state.receipts).some(([key, receipt]) => ['running', 'uncertain'].includes(receipt.outcome) && !context.state.receiptRecoveries?.[key]), 'previous_action_needs_attention');
          const snapshot = await this.observeOwned(); observations++;
          guard(new URL(snapshot.url).origin === this.allowedOrigin, 'wrong_origin');
          guard(snapshot.url === (context.state.boundUrl || context.job.startUrl), 'wrong_project_page');
          const candidates = snapshot.elements.filter(element => match(element, context.step.controls));
          // Only missing/disabled controls are observed again. Ambiguity, driver
          // failures, model abstention and mutations are never retried here.
          if (candidates.length) {
            const selection = await this.selectOwned({ jobId: input.jobId, observationToken: snapshot.observationToken });
            const readinessMs = performance.now() - started;
            await this.log({ kind: 'readiness', jobId: input.jobId, stepId: context.step.id, observations, readinessMs, outcome: selection.outcome });
            return { ...selection, readinessMs, observations };
          }
          const remaining = waitMs - (performance.now() - started);
          guard(remaining > 0, 'control_readiness_timeout');
          await new Promise(resolve => setTimeout(resolve, Math.min(150, remaining)));
        }
      } catch (error) {
        this.latest = null; this.selections.clear();
        await this.log({ kind: 'readiness', jobId: input.jobId, stepId: initial.step.id, observations, readinessMs: performance.now() - started, outcome: 'blocked', reason: error instanceof GuardError ? error.code : 'observation_failed' });
        throw error;
      }
    });
  }
  async selectOwned(input) {
    exactKeys(input, ['jobId', 'observationToken']); validId(input.jobId);
    const observation = this.observation(input.observationToken); const { step, asset } = await this.jobContext(input.jobId);
    const candidates = observation.snapshot.elements.filter(element => match(element, step.controls));
    guard(candidates.length > 0 && candidates.length <= 10, 'no_permitted_observed_control');
    let picked = null; let method = 'exact-single-match'; let model = null;
    if (candidates.length === 1) picked = candidates[0];
    else {
      guard(this.chooser, 'ambiguous_control_needs_selection'); method = 'typesafe-choice';
      model = await this.chooser({ requestedStep: step.id, operation: step.operation, asset: { filename: asset.file, contentType: 'video/mp4' }, candidates: candidates.map((candidate, i) => ({ id: `c${i}`, operation: step.operation, label: `${candidate.role}: ${candidate.name}`, labelContext: candidate.label_context, inputType: candidate.input_type, accept: candidate.accept, multiple: candidate.multiple, checked: candidate.checked, disabled: Boolean(candidate.disabled) })) }, new AbortController().signal);
      if (model.choice !== 'none') picked = candidates[Number(model.choice.slice(1))];
    }
    const selectionToken = randomUUID();
    const result = { selectionToken, jobId: input.jobId, stepId: step.id, observationToken: observation.token, ref: picked?.ref || null, selectionMethod: method, selectionMs: model?.latencyMs || 0, confidence: model?.confidence ?? null, outcome: picked ? 'selected' : 'needs_attention' };
    this.selections.set(selectionToken, result);
    await this.log({ kind: 'selection', jobId: input.jobId, stepId: step.id, method, outcome: result.outcome, durationMs: result.selectionMs, confidence: result.confidence, usage: model?.usage || null });
    return result;
  }
  async stageAsset(asset) {
    const root = await realpath(this.assetsDir); const source = await realpath(path.join(root, asset.file));
    guard(path.dirname(source) === root, 'asset_path_escape'); const info = await stat(source);
    guard(info.isFile() && info.size > 0 && info.size <= 50 * 1024 * 1024, 'asset_size_limit');
    guard(digest(await readFile(source)) === asset.sha256, 'asset_hash_mismatch');
    const directory = path.join(this.stateDir, 'inputs', asset.sha256); await mkdir(directory, { recursive: true, mode: 0o700 });
    const destination = path.join(directory, asset.file);
    try { await copyFile(source, destination, constants.COPYFILE_EXCL); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
    guard(digest(await readFile(destination)) === asset.sha256, 'staged_asset_hash_mismatch');
    return destination;
  }
  async act(input) {
    exactKeys(input, ['jobId', 'idempotencyKey', 'observationToken', 'ref', 'selectionToken']); validId(input.jobId); validId(input.idempotencyKey);
    guard(typeof input.ref === 'string' && /^e[0-9]+$/.test(input.ref), 'invalid_ref');
    guard(!this.busy, 'browser_busy'); this.busy = true;
    const totalStarted = performance.now(); let state, step, receipt; let dispatched = false;
    try {
      state = await this.state(input.jobId);
      const requestHash = digest(input);
      if (state.receipts[input.idempotencyKey]) {
        const prior = state.receipts[input.idempotencyKey]; guard(prior.requestHash === requestHash, 'idempotency_conflict');
        return { ...prior, replayed: true, needsAttention: ['running', 'uncertain'].includes(prior.outcome) };
      }
      const context = await this.jobContext(input.jobId); ({ state, step } = context);
      guard(!Object.entries(state.receipts).some(([key, item]) => ['running', 'uncertain'].includes(item.outcome) && !state.receiptRecoveries?.[key]), 'previous_action_needs_attention');
      const observation = this.observation(input.observationToken);
      guard(new URL(observation.snapshot.url).origin === this.allowedOrigin, 'wrong_origin');
      guard(observation.snapshot.url === (state.boundUrl || context.job.startUrl), 'wrong_project_page');
      const target = observation.snapshot.elements.find(element => element.ref === input.ref); guard(target && match(target, step.controls), 'control_not_permitted');
      if (step.operation === 'upload') guard(target.role === 'file' && target.input_type === 'file', 'upload_requires_file_input');
      if (step.operation === 'uncheck') guard(typeof target.checked === 'boolean', 'checkbox_state_missing');
      let selection = null;
      if (input.selectionToken) {
        selection = this.selections.get(input.selectionToken);
        guard(selection && selection.jobId === input.jobId && selection.stepId === step.id && selection.observationToken === observation.token && selection.ref === input.ref, 'invalid_selection');
      }
      receipt = { requestHash, jobId: input.jobId, stepId: step.id, stepHash: digest(step), operation: step.operation, outcome: 'running', selectionMethod: selection?.selectionMethod || 'explicit-observed-ref', observeMs: observation.observeMs, selectionMs: selection?.selectionMs || 0, retries: state.attempts[step.id] || 0 };
      state.attempts[step.id] = receipt.retries + 1; state.coreHash = context.coreHash; state.boundUrl ||= context.job.startUrl;
      state.receipts[input.idempotencyKey] = receipt; await this.save(state);
      const sourcePath = step.operation === 'upload' ? await this.stageAsset(context.asset) : null;
      // Reobserve after all file/journal awaits. Only a unique unchanged semantic
      // target gets its new live ref; upstream also checks ref signatures itself.
      const fresh = structured(await this.client.call('browser_snapshot', { session_id: this.sessionId, interactive_only: true, include_values: false, max_elements: 200 }));
      guard(snapshotHash(fresh) === observation.hash, 'page_changed');
      const targets = fresh.elements.filter(element => signature(element) === signature(target)); guard(targets.length === 1, 'ambiguous_target');
      const ref = targets[0].ref; this.latest = null; this.selections.clear();
      const common = { session_id: this.sessionId, ref, timeout_ms: 15000 };
      const actionStarted = performance.now(); dispatched = true;
      if (step.operation === 'upload') await this.client.call('browser_upload_file', { ...common, paths: [sourcePath] });
      if (step.operation === 'fill_prompt') await this.client.call('browser_type', { ...common, text: context.job.prompt, clear_first: true, press_enter_after: false });
      if (step.operation === 'click') await this.client.call('browser_click', common);
      if (step.operation === 'uncheck') {
        if (targets[0].role === 'switch') {
          guard(typeof targets[0].checked === 'boolean', 'checkbox_state_missing');
          receipt.actionMethod = targets[0].checked ? 'click-observed-on-switch' : 'already-off';
          if (targets[0].checked) await this.client.call('browser_click', common);
        } else await this.client.call('browser_set_checked', { ...common, checked: false });
      }
      let exportPath;
      if (step.operation === 'export') {
        const directory = path.join(this.stateDir, 'exports', input.jobId); await mkdir(directory, { recursive: true, mode: 0o700 });
        exportPath = path.join(directory, 'export.mp4');
        await this.client.call('browser_download', { ...common, timeout_ms: 120000, path: exportPath, overwrite: false });
      }
      receipt.actionMs = performance.now() - actionStarted; const verifyStarted = performance.now();
      if (step.operation !== 'export') await this.client.call('browser_wait_for', { session_id: this.sessionId, text: step.verifyText, timeout_ms: step.verifyTimeoutMs ?? 15000 });
      else { const file = await stat(exportPath); guard(file.isFile() && file.size > 0 && file.size <= 50 * 1024 * 1024, 'invalid_download'); receipt.artifact = exportPath; receipt.sha256 = digest(await readFile(exportPath)); }
      const after = structured(await this.client.call('browser_snapshot', { session_id: this.sessionId, interactive_only: true, include_values: false, max_elements: 200 }));
      guard(new URL(after.url).origin === this.allowedOrigin, 'unexpected_navigation');
      guard(step.mayNavigate || after.url === state.boundUrl, 'unexpected_navigation');
      if (step.operation === 'uncheck') { const boxes = after.elements.filter(element => match(element, step.controls)); guard(boxes.length === 1 && boxes[0].checked === false, 'checkbox_not_off'); }
      state.boundUrl = after.url; state.completedSteps.push(digest(step)); state.nextStep++;
      state.status = step.operation === 'export' ? 'exported_unverified' : 'ready';
      receipt.verificationMs = performance.now() - verifyStarted; receipt.outcome = 'verified_postcondition';
      return receipt;
    } catch (error) {
      if (!receipt) throw error;
      receipt.outcome = dispatched ? 'uncertain' : 'blocked'; receipt.reason = error instanceof GuardError ? error.code : 'browser_operation_failed';
      if (error.browserFailure) receipt.browserFailure = error.browserFailure;
      state.status = 'needs_attention'; return receipt;
    } finally {
      try { if (receipt) { receipt.totalMs = performance.now() - totalStarted; await this.save(state); await this.log({ kind: 'action', ...receipt, requestHash: undefined }); } }
      finally { this.busy = false; }
    }
  }
  async reconcile(input) {
    exactKeys(input, ['jobId', 'idempotencyKey', 'reviewed']); validId(input.jobId); validId(input.idempotencyKey);
    guard(input.reviewed === true, 'explicit_review_required');
    return this.ownBrowser(async () => {
      const state = await this.state(input.jobId); const receipt = state.receipts[input.idempotencyKey];
      guard(receipt, 'unknown_action_receipt');
      if (receipt.outcome === 'verified_postcondition') return { ...receipt, replayed: true };
      guard(['running', 'uncertain'].includes(receipt.outcome), 'action_not_uncertain');
      const { step } = await this.jobContext(input.jobId);
      guard(receipt.stepId === step.id && receipt.stepHash === digest(step), 'uncertain_step_changed');
      this.latest = null; this.selections.clear();
      const started = performance.now(); let after, artifact;
      try {
        // This endpoint only observes the existing result. It never replays the action.
        const before = structured(await this.client.call('browser_snapshot', { session_id: this.sessionId, interactive_only: true, include_values: false, max_elements: 200 }));
        guard(new URL(before.url).origin === this.allowedOrigin, 'wrong_origin');
        guard(step.mayNavigate || before.url === state.boundUrl, 'wrong_project_page');
        if (step.operation === 'export') {
          const file = path.join(this.stateDir, 'exports', input.jobId, 'export.mp4');
          const info = await stat(file); guard(info.isFile() && info.size > 0 && info.size <= 50 * 1024 * 1024, 'invalid_download');
          artifact = { artifact: file, sha256: digest(await readFile(file)) };
        } else {
          await this.client.call('browser_wait_for', { session_id: this.sessionId, text: step.verifyText, timeout_ms: step.verifyTimeoutMs ?? 15000 });
        }
        after = structured(await this.client.call('browser_snapshot', { session_id: this.sessionId, interactive_only: true, include_values: false, max_elements: 200 }));
        guard(new URL(after.url).origin === this.allowedOrigin, 'unexpected_navigation');
        guard(step.mayNavigate || after.url === state.boundUrl, 'unexpected_navigation');
      if (step.operation === 'uncheck') { const boxes = after.elements.filter(element => match(element, step.controls)); guard(boxes.length === 1 && boxes[0].checked === false, 'checkbox_not_off'); }
      } catch (error) {
        const result = { jobId: input.jobId, stepId: step.id, outcome: 'unconfirmed', needsAttention: true, reason: error instanceof GuardError ? error.code : 'postcondition_not_observed', verificationMs: performance.now() - started };
        await this.log({ kind: 'reconcile', ...result }); return result;
      }
      state.boundUrl = after.url; state.completedSteps.push(digest(step)); state.nextStep++;
      state.status = step.operation === 'export' ? 'exported_unverified' : 'ready';
      Object.assign(receipt, artifact, { outcome: 'verified_postcondition', reconciled: true, reconciledAt: new Date().toISOString(), verificationMs: performance.now() - started });
      await this.save(state);
      await this.log({ kind: 'reconcile', jobId: input.jobId, stepId: step.id, outcome: receipt.outcome, verificationMs: receipt.verificationMs, artifactSha256: receipt.sha256 });
      return receipt;
    });
  }
  async recoverToggle(input) {
    exactKeys(input, ['jobId', 'idempotencyKey', 'reviewed']); validId(input.jobId); validId(input.idempotencyKey);
    guard(input.reviewed === true, 'explicit_review_required');
    return this.ownBrowser(async () => {
      const { state, step } = await this.jobContext(input.jobId); const receipt = state.receipts[input.idempotencyKey];
      guard(receipt?.operation === 'uncheck' && receipt.outcome === 'uncertain', 'recovery_requires_uncertain_toggle');
      guard(step.operation === 'uncheck' && receipt.stepId === step.id && receipt.stepHash === digest(step), 'uncertain_step_changed');
      guard(!state.receiptRecoveries?.[input.idempotencyKey], 'toggle_already_reviewed');
      const fresh = structured(await this.client.call('browser_snapshot', { session_id: this.sessionId, interactive_only: true, include_values: false, max_elements: 200 }));
      guard(fresh.url === state.boundUrl && new URL(fresh.url).origin === this.allowedOrigin, 'wrong_project_page');
      const controls = fresh.elements.filter(element => match(element, step.controls));
      guard(controls.length === 1 && controls[0].role === 'switch' && controls[0].checked === true, 'toggle_not_observed_on');
      // Preserve the uncertain receipt verbatim. A separate reviewed observation
      // authorizes only a fresh attempt of this same non-spending toggle step.
      const recovery = { stepId: step.id, reviewedAt: new Date().toISOString(), observedChecked: true, outcome: 'observed_not_applied' };
      state.receiptRecoveries ||= {}; state.receiptRecoveries[input.idempotencyKey] = recovery;
      state.status = 'ready'; this.latest = null; this.selections.clear(); await this.save(state);
      await this.log({ kind: 'toggle_recovery', jobId: input.jobId, idempotencyKey: input.idempotencyKey, ...recovery });
      return { jobId: input.jobId, ...recovery, nextStep: step.id, newAttemptAuthorized: true };
    });
  }
  async reconcileNavigation(input) {
    exactKeys(input, ['jobId', 'idempotencyKey', 'reviewed']); validId(input.jobId); validId(input.idempotencyKey);
    guard(input.reviewed === true, 'explicit_review_required');
    return this.ownBrowser(async () => {
      const manifest = await this.manifest(); const job = manifest.jobs.get(input.jobId); guard(job, 'unknown_job');
      const state = await this.state(input.jobId); guard(state.status !== 'cancelled', 'job_cancelled');
      guard(state.coreHash === digest({ id: job.id, asset: manifest.assets.get(job.assetId), prompt: job.prompt, startUrl: job.startUrl }), 'job_definition_changed');
      guard(state.nextStep > 0 && state.completedSteps.length === state.nextStep && state.completedSteps.every((hash, index) => hash === digest(job.steps[index])), 'completed_step_changed');
      const step = job.steps[state.nextStep - 1]; const receipt = state.receipts[input.idempotencyKey];
      guard(step?.mayNavigate === true && step.operation === 'click' && receipt?.outcome === 'verified_postcondition' && receipt.stepId === step.id && receipt.stepHash === digest(step), 'requires_latest_verified_navigation');
      guard(!Object.entries(state.receipts).some(([key, item]) => ['running', 'uncertain'].includes(item.outcome) && !state.receiptRecoveries?.[key]), 'previous_action_needs_attention');
      const prior = state.navigationReconciliations?.[input.idempotencyKey];
      if (prior) { guard(prior.toUrl === state.boundUrl, 'navigation_binding_changed'); return { ...prior, replayed: true }; }
      const project = /^https:\/\/captions\.ai\/projects\/([a-zA-Z0-9_-]{8,80})$/.exec(state.boundUrl || '');
      guard(project && this.allowedOrigin === 'https://captions.ai', 'requires_owned_project_root');
      const fresh = structured(await this.client.call('browser_snapshot', { session_id: this.sessionId, interactive_only: true, include_values: false, max_elements: 200 }));
      const destination = new RegExp('^https://captions\\.ai/projects/' + project[1] + '/videos/[a-zA-Z0-9_-]{8,80}$');
      guard(typeof fresh.url === 'string' && destination.test(fresh.url), 'navigation_not_same_project_video');
      const result = { jobId: input.jobId, stepId: step.id, idempotencyKey: input.idempotencyKey, outcome: 'observed_delayed_navigation', fromUrl: state.boundUrl, toUrl: fresh.url, observedAt: new Date().toISOString() };
      // Observe and bind the delayed result only. Never repeat the render click,
      // alter its receipt, or count another completed step.
      state.boundUrl = fresh.url; state.navigationReconciliations ||= {}; state.navigationReconciliations[input.idempotencyKey] = result;
      this.latest = null; this.selections.clear(); await this.save(state);
      await this.log({ kind: 'navigation_reconciliation', ...result }); return result;
    });
  }
  async cancel(jobId) {
    validId(jobId);
    return this.ownBrowser(async () => { const state = await this.state(jobId); state.status = 'cancelled'; await this.save(state); await this.log({ kind: 'cancel', jobId }); return { jobId, status: 'cancelled' }; });
  }
  async resumeUrl(jobId) {
    validId(jobId); const manifest = await this.manifest(); const job = manifest.jobs.get(jobId); guard(job, 'unknown_resume_job');
    const state = await this.state(jobId); guard(state.status !== 'cancelled', 'resume_job_cancelled');
    guard(state.coreHash === digest({ id: job.id, asset: manifest.assets.get(job.assetId), prompt: job.prompt, startUrl: job.startUrl }), 'job_definition_changed');
    guard(state.completedSteps.length > 0 && state.completedSteps.every((hash, index) => hash === digest(job.steps[index])), 'resume_steps_changed');
    const projectRoot = typeof state.boundUrl === 'string' && /^https:\/\/captions\.ai\/projects\/[a-zA-Z0-9_-]{8,80}$/.test(state.boundUrl);
    const projectVideo = typeof state.boundUrl === 'string' && /^https:\/\/captions\.ai\/projects\/[a-zA-Z0-9_-]{8,80}\/videos\/[a-zA-Z0-9_-]{8,80}$/.test(state.boundUrl);
    guard(projectRoot || projectVideo, 'resume_requires_recorded_project');
    guard(Object.values(state.receipts).some(receipt => receipt.outcome === 'verified_postcondition' && job.steps.some(step => step.mayNavigate === true && digest(step) === receipt.stepHash)), 'resume_requires_verified_navigation');
    return state.boundUrl;
  }
  async network() { return this.ownBrowser(async () => networkSummary(structured(await this.client.call('browser_network_requests', { session_id: this.sessionId, max_events: 200, clear: false })))); }
  async jobs() {
    const manifest = await this.manifest(); const result = [];
    for (const job of manifest.jobs.values()) { const state = await this.state(job.id); result.push({ id: job.id, assetId: job.assetId, status: state.status, nextStep: job.steps[state.nextStep]?.id || null, completedSteps: state.nextStep }); }
    return result;
  }
}
