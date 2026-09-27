#!/usr/bin/env node
/** Diagnostic: per-source ingest counts and label distribution (no writes). */
import { collectAll } from '../lib/artifacts.mjs';
import { defaultRepos } from '../lib/paths.mjs';
import { dhashWithImageMagick, imageMagickAvailable } from '../lib/dedupe.mjs';

const arg = (name, fallback = undefined) => {
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1];
};
const repos = defaultRepos();
const mainRepo = arg('--main-repo', repos.main);
const browserRepo = arg('--browser-repo', repos.browser);
const hasher = imageMagickAvailable() ? dhashWithImageMagick : null;
const records = collectAll({ main: mainRepo, browser: browserRepo }, { hasher });
const bySource = {};
const byLabel = {};
const bySourceLabel = {};
for (const record of records) {
  const source = record.provenance?.source ?? 'unknown';
  bySource[source] = (bySource[source] ?? 0) + 1;
  byLabel[record.label_quality] = (byLabel[record.label_quality] ?? 0) + 1;
  bySourceLabel[source] = bySourceLabel[source] ?? {};
  bySourceLabel[source][record.label_quality] = (bySourceLabel[source][record.label_quality] ?? 0) + 1;
}
console.log(JSON.stringify({ total: records.length, bySource, byLabel, bySourceLabel, dhash_available: Boolean(hasher) }, null, 2));
