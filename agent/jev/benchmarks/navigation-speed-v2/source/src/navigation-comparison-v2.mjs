import { readFile, mkdir } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { assert } from './config.mjs';
import { saveJson } from './storage.mjs';
import { navigationContract } from './navigation.mjs';

export const baselineSourceSha256 = 'bc6cb6125007d2b18af7e8297668f5e60c09cb704b2523e5f1c4118d960f1e7a';
export const comparisonSequence = Object.freeze(['baseline', 'candidate', 'candidate', 'baseline', 'baseline', 'candidate']);
const baselineFiles = ['src/navigation.mjs', 'src/navigation-journal.mjs', 'src/navigation-diagnostics.mjs',
  'src/storage.mjs', 'src/jev.mjs', 'src/glovo.mjs', 'src/config.mjs', 'src/policy.mjs',
  'scripts/navigation-eval.mjs', 'scripts/navigation-desktop.mjs', 'package-lock.json'];
const harnessFiles = ['src/navigation-comparison-v2.mjs', 'scripts/navigation-compare-v2.mjs'];
const candidateFiles = ['src/navigation-candidate-v2.mjs', 'src/navigation-candidate-io.mjs'];
async function fingerprint(files) {
  const hash = createHash('sha256');
  for (const file of files) hash.update(file).update(await readFile(new URL(`../${file}`, import.meta.url)));
  return hash.digest('hex');
}

export async function comparisonProtocol(task) {
  navigationContract(task);
  assert(await fingerprint(baselineFiles) === baselineSourceSha256, 'comparison_baseline_source_drift');
  return { version: 2, sequence: comparisonSequence, plannedRunsPerArm: 3, baselineSourceSha256,
    sourceHashes: { baseline: await fingerprint([...baselineFiles, ...harnessFiles]),
      candidate: await fingerprint([...baselineFiles, ...harnessFiles, ...candidateFiles]),
      harness: await fingerprint(harnessFiles) },
    taskSha256: createHash('sha256').update(JSON.stringify(task)).digest('hex'),
    limits: { maxStepsPerRun: task.maxSteps, maxRunMs: task.maxRunMs, maxModelUsdPerRun: task.maxModelUsd },
    design: 'Three adjacent pairs in B/C, C/B, B/C order; fixed before live requests; fresh Chromium context for each run, same persistent profile and process-shared Jev client. No warm-up calls.',
    timing: 'Navigation total includes homepage through verification and journals. fullAttemptMs includes launch, navigation, close and pending diagnostic flush; excludes terminal journal and batch writes.',
    stopping: 'Continue ordinary incomplete navigation attempts. Stop the batch on setup/challenge, provider/usage failures, journaling failures or cancellation; preserve the partial sequence.' };
}

export async function createComparisonJournal(dataDir, { task, config, environment, batchId, run, arm, pair, protocol }) {
  assert(comparisonSequence.includes(arm) && protocol.sourceHashes[arm], 'invalid_comparison_arm');
  const directory = join(dataDir, 'navigation', 'runs');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const id = randomUUID(), path = join(directory, `${id}.json`);
  const report = { id, batchId, run, arm, pair, schemaVersion: 2, status: 'starting', createdAt: new Date().toISOString(),
    task: navigationContract(task), sourceSha256: protocol.sourceHashes[arm], baselineSourceSha256,
    environment, requestedModel: config.model,
    pricing: { inputUsdPerMillion: config.inputUsdPerMillion, outputUsdPerMillion: config.outputUsdPerMillion,
      scope: 'Estimated model API cost only; infrastructure, setup and operator time excluded.' }, events: [], result: null };
  await saveJson(path, report);
  return { id, path,
    async record(event) {
      report.status = 'running';
      report.events.push({ sequence: report.events.length + 1, at: new Date().toISOString(), ...structuredClone(event) });
      await saveJson(path, report);
    },
    async finish(result) {
      report.status = result.status; report.finishedAt = new Date().toISOString(); report.result = structuredClone(result);
      await saveJson(path, report);
    } };
}

export function shouldStopComparison(result) {
  const reason = result.reason || '';
  return result.metrics?.usageComplete === false || /^(?:provider_|invalid_provider_|missing_typesafe_key)/.test(reason)
    || ['destination_requires_setup', 'browser_challenge', 'age_confirmation_requires_user', 'repeated_age_confirmation_prompt',
      'age_confirmation_not_dismissed', 'navigation_journal_failed', 'cancelled_or_timed_out', 'AbortError',
      'startup_failed', 'browser_launch_failed', 'browser_close_failed', 'merchant_site_unavailable'].includes(reason);
}
