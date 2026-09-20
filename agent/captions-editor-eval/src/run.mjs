import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID, createHash } from 'node:crypto';
import { buildRequest, callChoice, ContractError } from './choice.mjs';
import { summarize } from './metrics.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
function arg(name, fallback) { const index = args.indexOf(name); return index < 0 ? fallback : args[index + 1]; }
function integer(name, fallback, max) { const value = Number(arg(name, fallback)); if (!Number.isInteger(value) || value < 1 || value > max) throw new ContractError(`invalid_${name.slice(2)}`); return value; }

async function main() {
  const live = args.includes('--live');
  const repeats = integer('--repeats', 1, 10);
  const maxRequests = integer('--max-requests', 20, 100);
  const timeoutMs = integer('--timeout-ms', 15000, 60000);
  const threshold = Number(arg('--threshold', 0.8));
  if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) throw new ContractError('invalid_threshold');
  const dataset = JSON.parse(await fs.readFile(path.join(root, 'fixtures/cases.json'), 'utf8'));
  const cases = dataset.cases.filter(c => !arg('--case', null) || c.id === arg('--case', null));
  if (!cases.length) throw new ContractError('no_matching_cases');
  const prepared = cases.map(fixture => {
    const request = buildRequest(fixture);
    if (!Object.hasOwn(request.body.questions.action.criteria, fixture.expected)) throw new ContractError('invalid_expected_choice');
    return { fixture, ...request };
  });
  const requestedCalls = prepared.filter(p => !p.localOnly).length * repeats;
  if (live && requestedCalls > maxRequests) throw new ContractError('request_cap_exceeded');
  let apiKey;
  if (live) {
    // Only explicit environment configuration is read. Never search the filesystem for credentials.
    if (process.env.TYPESAFE_API_KEY && process.env.TYPESAFE_KEY_FILE) throw new ContractError('ambiguous_key_configuration');
    apiKey = process.env.TYPESAFE_API_KEY;
    if (process.env.TYPESAFE_KEY_FILE) {
      const stat = await fs.stat(process.env.TYPESAFE_KEY_FILE);
      if (!stat.isFile() || (stat.mode & 0o077) !== 0) throw new ContractError('key_file_must_be_private');
      apiKey = (await fs.readFile(process.env.TYPESAFE_KEY_FILE, 'utf8')).trim();
    }
    if (!apiKey?.trim()) throw new ContractError('missing_typesafe_key_no_requests_sent');
  }
  const runId = `${new Date().toISOString().replaceAll(':', '-')}-${randomUUID().slice(0, 8)}`;
  const outputDir = path.join(root, 'reports', runId);
  await fs.mkdir(outputDir, { recursive: true, mode: 0o700 });
  const journalPath = path.join(outputDir, 'attempts.ndjson');
  const journal = entry => fs.appendFile(journalPath, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
  const attempts = [];
  let stoppedReason = null;
  runLoop: for (const { fixture, body, localOnly } of prepared) {
    for (let repetition = 1; repetition <= repeats; repetition++) {
      const base = { caseId: fixture.id, repetition, expected: fixture.expected, fixtureKind: fixture.kind };
      if (!live || localOnly) {
        const record = { ...base, mode: localOnly ? 'local-policy' : 'offline-contract', status: 'validated', ...(localOnly ? { choice: 'none' } : {}), requestBytes: Buffer.byteLength(JSON.stringify(body)), candidates: body.state.candidates.length };
        attempts.push(record); await journal(record); continue;
      }
      const requestDigest = createHash('sha256').update(JSON.stringify(body)).digest('hex');
      await journal({ ...base, mode: 'live', status: 'started', requestDigest, startedAt: new Date().toISOString() });
      let record;
      try { record = { ...base, mode: 'live', status: 'ok', ...await callChoice(body, { apiKey, timeoutMs }) }; }
      catch (error) { record = { ...base, mode: 'live', status: 'failed', failure: error instanceof ContractError ? error.code : 'unexpected_client_failure', latencyMs: error.latencyMs ?? null }; }
      attempts.push(record); await journal(record);
      if (['typesafe_http_401', 'typesafe_http_403'].includes(record.failure)) {
        stoppedReason = 'authentication_or_authorization_error';
        break runLoop;
      }
    }
  }
  const report = {
    schemaVersion: 1, runId, mode: live ? 'live-model-evaluation' : 'offline-contract-check', generatedAt: new Date().toISOString(),
    dataset: { version: dataset.version, cases: prepared.length, provenance: dataset.provenance },
    repetitions: repeats, plannedLiveRequests: live ? requestedCalls : 0, stoppedReason,
    offlineContractsValidated: prepared.length, ...summarize(attempts, threshold), attempts,
    limitations: ['Static selection evaluation only: no browser execution or editor export.', 'Small hand-labeled fixture set; not a production accuracy estimate.', 'Expected labels and fixture explanations are never sent to the model.', 'Existing 0.8 threshold is illustrative until evaluated on representative real observations.'],
  };
  const reportPath = path.join(outputDir, 'report.json');
  await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  console.log(JSON.stringify({ report: reportPath, mode: report.mode, cases: prepared.length, liveRequests: report.liveRequests, rawAccuracy: report.rawAccuracy, latencyMs: report.latencyMs, failures: report.failures.length }, null, 2));
  if (report.failures.length) process.exitCode = 1;
}
main().catch(error => {
  console.error(JSON.stringify({ status: 'failed', error: error instanceof ContractError ? error.code : 'local_setup_failure', note: 'Consult any existing run journal for started requests; setup failures occur before network calls.' }));
  process.exitCode = 1;
});
