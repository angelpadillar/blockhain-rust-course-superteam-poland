#!/usr/bin/env node
/**
 * `npm run browser:valen-readiness`
 *
 * Prints the retraining gates from the latest immutable snapshot, or from a
 * dry-run analysis when no snapshot exists yet. Never trains anything.
 */
import { existsSync } from 'node:fs';
import { collectAll } from '../lib/artifacts.mjs';
import { readDecisionLog, DECISION_LOG_FILE } from '../lib/logger.mjs';
import { defaultRepos, storePaths } from '../lib/paths.mjs';
import { dhashWithImageMagick, imageMagickAvailable } from '../lib/dedupe.mjs';
import { analyzeCorpus, latestSnapshotDir, loadSnapshot } from '../lib/snapshot.mjs';
import { readinessMetrics, readinessReport, THRESHOLDS } from '../lib/readiness.mjs';
import { join } from 'node:path';

const arg = (name, fallback = undefined) => {
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1];
};
const flag = (name) => process.argv.includes(name);

const paths = storePaths();
const latest = latestSnapshotDir(paths);
let records;
let leakage;
let source;

if (latest && !flag('--fresh')) {
  const snapshot = loadSnapshot(latest);
  records = snapshot.records;
  leakage = snapshot.splits.leakage;
  source = `snapshot ${snapshot.manifest.version}`;
} else {
  const repos = defaultRepos();
  const mainRepo = arg('--main-repo', repos.main);
  const browserRepo = arg('--browser-repo', repos.browser);
  const liveLogFile = join(paths.decisions, DECISION_LOG_FILE);
  const liveRecords = existsSync(liveLogFile) ? readDecisionLog(liveLogFile) : [];
  const collected = [...collectAll({ main: mainRepo, browser: browserRepo }, { hasher: imageMagickAvailable() ? dhashWithImageMagick : null }), ...liveRecords];
  const analysis = analyzeCorpus(collected, { paths, hasher: imageMagickAvailable() ? dhashWithImageMagick : undefined, persistRegistry: false });
  records = [...analysis.canonical, ...collected.filter((record) => record.dedupe?.role === 'near_duplicate')];
  leakage = analysis.leakage;
  source = 'dry-run (no snapshot yet)';
}

const metrics = readinessMetrics(records, { leakage });
const report = readinessReport(metrics);

console.log(`source: ${source}`);
for (const line of report.lines) console.log(line);
console.log(`EXACT_NEXT_RETRAIN_THRESHOLD=${report.readiness.exact_next_threshold}`);
if (report.readiness.blockers.length) {
  console.log('BLOCKERS:');
  for (const blocker of report.readiness.blockers) {
    console.log(`  ${blocker.gate}: have ${blocker.have}, need ${blocker.need} (+${blocker.missing})`);
  }
}
console.log(`THRESHOLDS=${JSON.stringify(THRESHOLDS)}`);
if (flag('--json')) console.log(JSON.stringify({ metrics, readiness: report.readiness }, null, 2));
