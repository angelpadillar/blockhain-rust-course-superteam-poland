import { readFile, readdir, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { saveJson } from './storage.mjs';
import { navigationContract } from './navigation.mjs';

// Only task data, public navigation evidence and provider decisions belong here.
// Callers must never pass a full DOM, account configuration, cookies or headers.
export async function createNavigationJournal(dataDir, { task, config, environment, batchId, run }) {
  const directory = join(dataDir, 'navigation', 'runs');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const source = createHash('sha256');
  for (const file of ['src/navigation.mjs', 'src/navigation-journal.mjs', 'src/navigation-diagnostics.mjs', 'src/storage.mjs', 'src/jev.mjs',
    'src/glovo.mjs', 'src/config.mjs', 'src/policy.mjs', 'scripts/navigation-eval.mjs', 'scripts/navigation-desktop.mjs', 'package-lock.json']) {
    source.update(file).update(await readFile(new URL(`../${file}`, import.meta.url)));
  }
  const id = randomUUID(), path = join(directory, `${id}.json`);
  const report = { id, batchId, run, schemaVersion: 1, createdAt: new Date().toISOString(), status: 'starting',
    task: navigationContract(task), sourceSha256: source.digest('hex'), environment,
    requestedModel: config.model, pricing: { inputUsdPerMillion: config.inputUsdPerMillion,
      outputUsdPerMillion: config.outputUsdPerMillion, scope: 'Estimated model cost; infrastructure and operator time excluded.' },
    events: [], result: null };
  await saveJson(path, report);
  return { id, path,
    async record(event) {
      report.status = 'running';
      report.events.push({ sequence: report.events.length + 1, at: new Date().toISOString(), ...structuredClone(event) });
      await saveJson(path, report);
    },
    async finish(result) {
      report.status = result.status;
      report.finishedAt = new Date().toISOString();
      report.result = structuredClone(result);
      await saveJson(path, report);
    } };
}

// Call only while holding the profile lock. Interrupted actions are never replayed.
export async function recoverNavigationJournals(dataDir) {
  const directory = join(dataDir, 'navigation', 'runs');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  let recovered = 0;
  for (const file of await readdir(directory)) {
    if (!/^[a-f0-9-]{36}\.json$/.test(file)) continue;
    const path = join(directory, file), report = JSON.parse(await readFile(path, 'utf8'));
    if (!['starting', 'running'].includes(report.status)) continue;
    report.status = 'interrupted';
    report.recoveredAt = new Date().toISOString();
    report.result = { status: 'interrupted', reason: 'process_ended_before_final_result',
      completionVerified: false, usageComplete: false, actionOutcomeMayBeUnknown: true,
      resumePolicy: 'Inspect the live page and start a new run; never replay pending actions automatically.' };
    await saveJson(path, report); recovered++;
  }
  return recovered;
}
