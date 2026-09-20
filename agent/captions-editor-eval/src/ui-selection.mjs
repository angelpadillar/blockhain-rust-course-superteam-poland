// One read-only semantic decision from a caller-supplied, minimal DOM projection.
// No browser connection, snapshot collection, account action, or mutation code.
import { readFile, open, rename } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

function guard(ok, code) { if (!ok) throw Error(code); }
function keys(value, allowed) { guard(value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).every(k => allowed.includes(k)), 'unexpected_projection_field'); }
export function validateProjection(input, now = Date.now()) {
  keys(input, ['version', 'observationId', 'capturedAt', 'expectedRef', 'candidates']);
  guard(input.version === 1, 'projection_version');
  guard(typeof input.observationId === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(input.observationId), 'invalid_observation_id');
  const captured = Date.parse(input.capturedAt);
  guard(Number.isFinite(captured) && captured <= now + 10000 && now - captured <= 15 * 60 * 1000, 'projection_expired');
  guard(Array.isArray(input.candidates) && input.candidates.length >= 2 && input.candidates.length <= 10, 'candidate_count');
  const seen = new Set();
  for (const c of input.candidates) {
    keys(c, ['ref', 'role', 'name', 'labelContext', 'checked', 'disabled']);
    guard(/^e[0-9]+$/.test(c.ref) && !seen.has(c.ref), 'invalid_or_duplicate_ref'); seen.add(c.ref);
    guard(c.role === 'switch' || c.role === 'checkbox', 'not_a_toggle');
    guard(typeof c.name === 'string' && c.name.length <= 180 && typeof c.labelContext === 'string' && c.labelContext.length <= 200 && (c.name.trim() || c.labelContext.trim()), 'invalid_label');
    guard(typeof c.checked === 'boolean' && typeof c.disabled === 'boolean', 'missing_toggle_state');
  }
  guard(seen.has(input.expectedRef), 'unknown_expected_ref');
  guard(!input.candidates.find(c => c.ref === input.expectedRef).disabled, 'expected_control_disabled');
  return input;
}

export function prepareSelection(input) {
  const candidates = input.candidates.filter(c => !c.disabled).map((c, i) => ({
    id: `c${i}`, operation: 'uncheck', label: `${c.role}: ${c.name}`,
    labelContext: c.labelContext, checked: c.checked, disabled: c.disabled,
  }));
  const eligible = input.candidates.filter(c => !c.disabled);
  return {
    state: { requestedStep: 'Select the Generate media switch to turn generated media OFF. Distinguish it from Voiceover Only and Auto Trim. This is selection only; do not execute any action.', operation: 'uncheck', candidates },
    mapping: Object.fromEntries(eligible.map((c, i) => [`c${i}`, c.ref])),
    expectedId: `c${eligible.findIndex(c => c.ref === input.expectedRef)}`,
  };
}

export async function evaluateProjection(input, choose) {
  const { state, mapping, expectedId } = prepareSelection(input);
  const result = await choose(state);
  return {
    expectedId, expectedRef: input.expectedRef,
    rawChoice: result.rawChoice, returnedChoice: result.choice,
    selectedRef: mapping[result.choice] ?? null,
    passed: result.choice === expectedId,
    confidence: result.confidence, probabilities: result.probabilities,
    latencyMs: result.latencyMs, usage: result.usage,
    browserActions: 0,
    note: 'One semantic selection over actual supplied toggle metadata; this does not turn any toggle off or verify an edit. Reobserve before acting.',
  };
}

async function main() {
  const [inputFile, outputFile, mode] = process.argv.slice(2);
  guard(inputFile && outputFile && (!mode || mode === '--validate-only'), 'usage_input_json_output_json_optional_validate_only');
  const input = validateProjection(JSON.parse(await readFile(inputFile, 'utf8')));
  const projectionHash = createHash('sha256').update(JSON.stringify(input)).digest('hex');
  if (mode === '--validate-only') {
    console.log(JSON.stringify({ status: 'projection_valid', candidates: input.candidates.length, projectionHash, liveRequests: 0 })); return;
  }
  // Deployment-owned module and secret only; never search for keys or use a browser account token.
  const { createJev } = await import('file:///app/src/jev.mjs');
  const apiKey = (await readFile('/run/secrets/typesafe_key', 'utf8')).trim();
  guard(apiKey.length > 0, 'typesafe_key_missing');
  const choose = createJev({ apiKey });
  const report = { version: 1, startedAt: new Date().toISOString(), status: 'started', projectionHash,
    observationId: input.observationId, capturedAt: input.capturedAt, candidates: input.candidates,
    expectedRef: input.expectedRef, liveRequests: 1, browserActions: 0 };
  // Refuse to overwrite any prior started/completed run, preventing an accidental second call.
  const file = await open(outputFile, 'wx', 0o600);
  try { await file.writeFile(JSON.stringify(report, null, 2) + '\n'); await file.sync(); } finally { await file.close(); }
  const directory = await open(path.dirname(outputFile), 'r');
  try { await directory.sync(); } finally { await directory.close(); }
  try { Object.assign(report, await evaluateProjection(input, choose), { status: 'completed' }); }
  catch (error) {
    const code = String(error.message || '');
    Object.assign(report, { status: 'failed', failure: /^typesafe_http_\d{3}$/.test(code) ? code : 'selection_failed', resultUnknown: true });
  }
  report.finishedAt = new Date().toISOString();
  const temporary = outputFile + '.tmp'; const target = await open(temporary, 'wx', 0o600);
  try { await target.writeFile(JSON.stringify(report, null, 2) + '\n'); await target.sync(); } finally { await target.close(); }
  await rename(temporary, outputFile);
  console.log(JSON.stringify({ report: outputFile, status: report.status, passed: report.passed ?? false, returnedChoice: report.returnedChoice, confidence: report.confidence, latencyMs: report.latencyMs, usage: report.usage, browserActions: 0 }));
  if (!report.passed) process.exitCode = 1;
}
if (import.meta.url === pathToFileURL(process.argv[1] || '').href) main().catch(() => {
  console.error(JSON.stringify({ status: 'stopped', reason: 'Invalid projection, expired snapshot, existing report, unavailable module/key, or local I/O failure. No automatic retry.' }));
  process.exitCode = 1;
});
