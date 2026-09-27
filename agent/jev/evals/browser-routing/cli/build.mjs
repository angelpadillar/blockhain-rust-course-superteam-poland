#!/usr/bin/env node
/** Build the next immutable browser-decision snapshot. */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { collectAll } from '../lib/artifacts.mjs';
import { readDecisionLog, DECISION_LOG_FILE } from '../lib/logger.mjs';
import { defaultRepos, repoInstallation, storePaths } from '../lib/paths.mjs';
import { buildSnapshot } from '../lib/snapshot.mjs';
import { dhashWithImageMagick, imageMagickAvailable } from '../lib/dedupe.mjs';

const arg = (name, fallback = undefined) => {
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1];
};
const flag = (name) => process.argv.includes(name);

const repos = defaultRepos();
const paths = storePaths({ root: arg('--out', undefined) ?? undefined });
const mainRepo = arg('--main-repo', repos.main);
const browserRepo = arg('--browser-repo', repos.browser);
const useHash = flag('--ingest-only') ? false : imageMagickAvailable();
const hasher = useHash ? dhashWithImageMagick : null;

const liveLogFile = join(paths.decisions, DECISION_LOG_FILE);
const liveRecords = existsSync(liveLogFile) ? readDecisionLog(liveLogFile) : [];
const ingested = collectAll({ main: mainRepo, browser: browserRepo }, { hasher });
const allRecords = [...ingested, ...liveRecords];

if (!allRecords.length) {
  console.error('no decisions found to snapshot');
  process.exit(1);
}

const result = buildSnapshot({
  records: allRecords,
  paths,
  hasher: hasher ?? undefined,
  sourceCheckout: repoInstallation({ main: mainRepo, browser: browserRepo }),
  sourceCommit: null,
  version: arg('--version', null),
});

console.log(
  JSON.stringify(
    {
      snapshot: result.version,
      dir: result.dir,
      counts: result.manifest.counts,
      label_quality: result.manifest.label_quality,
      splits: result.manifest.splits,
      leakage: result.manifest.leakage,
      sources: { ingested: ingested.length, live_log: liveRecords.length },
      dhash_available: Boolean(hasher),
    },
    null,
    2,
  ),
);
