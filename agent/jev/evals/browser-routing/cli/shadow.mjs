#!/usr/bin/env node
/**
 * Valen shadow runner.
 *
 *   VALEN_MODE=shadow VALEN_BASE_URL=... npm run browser:valen-shadow -- --limit 20
 *
 * Records top1/top3/confidence/latency only. Valen never executes an action;
 * every recommendation carries executable:false. Use --dry-run to validate the
 * pipeline with VALEN_MODE=off and no network.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { shadowBatch, shadowConfig } from '../lib/shadow.mjs';
import { compareRecommendations } from '../lib/compare.mjs';
import { storePaths } from '../lib/paths.mjs';
import { latestSnapshotDir, loadSnapshot } from '../lib/snapshot.mjs';

const arg = (name, fallback = undefined) => {
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1];
};
const flag = (name) => process.argv.includes(name);

const paths = storePaths();
const snapshotDir = arg('--snapshot') ? join(paths.snapshots, arg('--snapshot')) : latestSnapshotDir(paths);
if (!snapshotDir) {
  console.error('no snapshot found; run `npm run browser:flywheel:build` first');
  process.exit(1);
}
const snapshot = loadSnapshot(snapshotDir);
const split = arg('--split', null);
let records = snapshot.records.filter((record) => record.dedupe?.role !== 'near_duplicate');
if (split) records = records.filter((record) => record.split === split);
records = records.filter((record) => record.candidates?.length >= 2);
const limit = Number(arg('--limit', '0'));
if (limit > 0) records = records.slice(0, limit);

const env = { ...process.env };
if (flag('--dry-run')) env.VALEN_MODE = 'off';
if (arg('--base-url')) env.VALEN_BASE_URL = arg('--base-url');
if (arg('--checkpoint')) env.VALEN_CHECKPOINT = arg('--checkpoint');
if (arg('--mode')) env.VALEN_MODE = arg('--mode');
const config = shadowConfig(env);

const started = new Date().toISOString();
const { records: shadowed, summary } = await shadowBatch(records, { config, imageBase: snapshotDir });

const withLabels = shadowed.filter((record) => record.label?.target_action);
const comparison = compareRecommendations(withLabels);
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const outFile = join(paths.registry, 'shadow', `${snapshot.manifest.version}-${stamp}.json`);
mkdirSync(dirname(outFile), { recursive: true });
writeFileSync(
  outFile,
  `${JSON.stringify(
    {
      schema: 'buena.browser-decision.shadow/1',
      snapshot: snapshot.manifest.version,
      mode: config.mode,
      base_url: config.baseUrl || null,
      checkpoint: config.checkpoint,
      started_at: started,
      finished_at: new Date().toISOString(),
      summary,
      comparison,
      executable: false,
      recommendations: shadowed.map((record) => ({
        decision_id: record.decision_id,
        trajectory_id: record.trajectory_id,
        label_quality: record.label_quality,
        split: record.split ?? null,
        target: record.label?.target_action ?? null,
        valen: record.recommendations?.valen ?? null,
        deterministic: record.recommendations?.deterministic ?? null,
        jev: record.recommendations?.jev ?? null,
      })),
    },
    null,
    2,
  )}\n`,
);

console.log(`snapshot: ${snapshot.manifest.version} | VALEN_MODE=${config.mode} | records=${shadowed.length}`);
console.log(`summary: ${JSON.stringify(summary)}`);
console.log('scorer              top1    top3    conf    p50(ms)  false_esc  missed_esc  n   self  indep  indep_top1');
for (const scorer of ['deterministic', 'jev', 'valen']) {
  const entry = comparison[scorer];
  const pct = (value) => (value === null ? '  n/a ' : `${(value * 100).toFixed(1).padStart(5)}%`);
  console.log(
    `${scorer.padEnd(18)} ${pct(entry.top1_agreement)} ${pct(entry.top3_required_action_recall)} ${(entry.confidence_mean === null ? 'n/a' : entry.confidence_mean.toFixed(2)).padStart(6)} ${String(entry.latency_p50_ms ?? 'n/a').padStart(8)} ${String(entry.false_human_escalation_count).padStart(9)} ${String(entry.missed_human_escalation_count).padStart(10)} ${String(entry.records_scored).padStart(4)} ${String(entry.self_recorded_count).padStart(4)} ${String(entry.independent_count).padStart(6)} ${pct(entry.independent_top1_accuracy)}`,
  );
}
console.log('note: deterministic/JEV rows are recorded decision-maker agreement; `self` counts records those scorers decided themselves (circular for accuracy).');
console.log(`results: ${outFile}`);
console.log('Valen executed no actions; all recommendations are advisory (executable=false).');
