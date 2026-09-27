/**
 * Immutable, versioned corpus snapshots.
 *
 * browser-decision-vNNN contains the manifest, every record (with hashes), image
 * hashes, split assignment and label quality. Existing versions are never
 * overwritten; the snapshot index is append-only.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { clusterDuplicates, imageMagickAvailable } from './dedupe.mjs';
import { assignSplits, loadHeldout, saveHeldout } from './splits.mjs';
import { hashRecord, isSecurityExample, canonicalJson, SCHEMA } from './schema.mjs';
import { storePaths } from './paths.mjs';

export const SNAPSHOT_SCHEMA = 'buena.browser-decision.snapshot/1';

export function loadSnapshotIndex(paths) {
  if (!existsSync(paths.snapshotIndex)) {
    return { schema: 'buena.browser-decision.snapshot-index/1', snapshots: [] };
  }
  return JSON.parse(readFileSync(paths.snapshotIndex, 'utf8'));
}

export function nextVersion(index) {
  const numbers = index.snapshots.map((entry) => Number(/v(\d+)/.exec(entry.version)?.[1] ?? 0));
  const next = (numbers.length ? Math.max(...numbers) : 0) + 1;
  return `browser-decision-v${String(next).padStart(3, '0')}`;
}

/**
 * Dedupe + split + leakage analysis without writing anything (used by readiness
 * and by the snapshot builder).
 */
export function analyzeCorpus(records, { paths, hasher = undefined, persistRegistry = false, now = () => new Date().toISOString() } = {}) {
  const store = paths ?? storePaths();
  const dedupe = clusterDuplicates(records, hasher ? { hasher } : {});
  const { registry, assignments, splitIds, trainOnlyDuplicates, counts, leakage, newAssignments } = assignSplits(dedupe.canonical, records.filter((record) => record.dedupe?.role === 'near_duplicate'), {
    heldoutPath: store.heldout,
    now,
  });
  if (persistRegistry) saveHeldout(store.heldout, registry);
  return { ...dedupe, ...{ registry, assignments, splitIds, trainOnlyDuplicates, splitCounts: counts, leakage, newAssignments } };
}

export function buildSnapshot({
  records,
  paths = storePaths(),
  sourceCheckout = {},
  sourceCommit = null,
  hasher = undefined,
  now = () => new Date().toISOString(),
  version = null,
}) {
  const index = loadSnapshotIndex(paths);
  const snapshotVersion = version ?? nextVersion(index);
  const snapshotDir = join(paths.snapshots, snapshotVersion);
  if (existsSync(snapshotDir)) throw new Error(`snapshot ${snapshotVersion} already exists; snapshots are immutable`);

  const analysis = analyzeCorpus(records, { paths, hasher, persistRegistry: true, now });
  const all = [...analysis.canonical, ...records.filter((record) => record.dedupe?.role === 'near_duplicate')];
  const createdAt = now();

  // Immutable test set: every trajectory that was test in the previous snapshot
  // must still be test (or absent), never moved.
  const previous = index.snapshots[index.snapshots.length - 1];
  if (previous) {
    const previousSplits = JSON.parse(readFileSync(join(paths.snapshots, previous.version, 'splits.json'), 'utf8'));
    const byDecision = new Map(analysis.canonical.map((record) => [record.decision_id, record]));
    for (const decisionId of previousSplits.canonical.test) {
      const record = byDecision.get(decisionId);
      if (!record) continue;
      const assignment = analysis.assignments[record.trajectory_id];
      if (assignment && assignment.split !== 'test') {
        throw new Error(`immutable test set violation: ${record.trajectory_id} was test in ${previous.version} but is ${assignment.split} now`);
      }
    }
  }

  // Stage images content-addressed inside the snapshot.
  const imageHashes = {};
  const imagesDir = join(snapshotDir, 'images');
  for (const record of all) {
    const screenshot = record.evidence?.screenshot;
    if (!screenshot?.source_path || !screenshot.sha256 || !existsSync(screenshot.source_path)) continue;
    mkdirSync(imagesDir, { recursive: true });
    const name = `${screenshot.sha256.slice(0, 12)}-${screenshot.source_path.split('/').pop()}`;
    const target = join(imagesDir, name);
    if (!existsSync(target)) copyFileSync(screenshot.source_path, target);
    screenshot.snapshot_path = `images/${name}`;
    imageHashes[screenshot.snapshot_path] = {
      sha256: screenshot.sha256,
      bytes: screenshot.bytes,
      dhash: screenshot.dhash,
      source_path: screenshot.source_path,
    };
  }

  const labelCounts = {};
  const splitLabelCounts = { train: {}, valid: {}, test: {} };
  for (const record of all) {
    labelCounts[record.label_quality] = (labelCounts[record.label_quality] ?? 0) + 1;
    if (record.split) {
      splitLabelCounts[record.split][record.label_quality] = (splitLabelCounts[record.split][record.label_quality] ?? 0) + 1;
    }
  }

  const recordHashes = {};
  for (const record of all) {
    recordHashes[record.decision_id] = { hash: hashRecord(record), label_quality: record.label_quality, split: record.split ?? null };
  }

  const securityRecords = all.filter((record) => isSecurityExample(record) || record.security === true);
  const families = [...new Set(all.map((record) => record.state?.page_class).filter(Boolean))].sort();

  mkdirSync(snapshotDir, { recursive: true });
  const sortedAll = all.slice().sort((a, b) => a.decision_id.localeCompare(b.decision_id));
  writeFileSync(join(snapshotDir, 'decisions.jsonl'), `${sortedAll.map((record) => JSON.stringify(record)).join('\n')}\n`);
  writeFileSync(join(snapshotDir, 'record-hashes.json'), `${JSON.stringify(recordHashes, null, 2)}\n`);
  writeFileSync(join(snapshotDir, 'image-hashes.json'), `${JSON.stringify(imageHashes, null, 2)}\n`);
  writeFileSync(
    join(snapshotDir, 'splits.json'),
    `${JSON.stringify(
      {
        schema: 'buena.browser-decision.splits/1',
        canonical: analysis.splitIds,
        train_only_duplicates: analysis.trainOnlyDuplicates.sort(),
        counts: analysis.splitCounts,
        leakage: analysis.leakage,
      },
      null,
      2,
    )}\n`,
  );
  writeFileSync(join(snapshotDir, 'label-quality.json'), `${JSON.stringify({ counts: labelCounts, by_split: splitLabelCounts }, null, 2)}\n`);

  const manifest = {
    schema: SNAPSHOT_SCHEMA,
    version: snapshotVersion,
    created_at: createdAt,
    tool: { record_schema: SCHEMA, dhash_available: imageMagickAvailable() },
    source_checkout: sourceCheckout,
    source_commit: sourceCommit,
    counts: {
      total_decisions: all.length,
      canonical_decisions: analysis.canonical.length,
      near_duplicates_removed: analysis.duplicates,
      clusters: analysis.clusters,
      image_records: Object.keys(imageHashes).length,
      security_examples: securityRecords.length,
      failed_action_negatives: all.filter((record) => record.label_quality === 'FAILED_ACTION').length,
      page_families: families.length,
    },
    page_families: families,
    label_quality: labelCounts,
    splits: analysis.splitCounts,
    leakage: analysis.leakage,
    secrets_checked: true,
    notes: 'Immutable snapshot; no secrets, cookies, tokens, proxy credentials or webhook URLs.',
  };
  writeFileSync(join(snapshotDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  writeFileSync(join(snapshotDir, 'records.canonical.jsonl'), `${analysis.canonical.slice().sort((a, b) => a.decision_id.localeCompare(b.decision_id)).map((record) => canonicalJson(record).trimEnd()).join('\n')}\n`);

  const updatedIndex = {
    ...index,
    snapshots: [...index.snapshots, { version: snapshotVersion, created_at: createdAt, manifest: join(snapshotVersion, 'manifest.json') }],
  };
  mkdirSync(join(paths.registry), { recursive: true });
  writeFileSync(paths.snapshotIndex, `${JSON.stringify(updatedIndex, null, 2)}\n`);

  return { version: snapshotVersion, dir: snapshotDir, manifest, analysis };
}

export function loadSnapshot(snapshotDir) {
  const records = readFileSync(join(snapshotDir, 'decisions.jsonl'), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  const manifest = JSON.parse(readFileSync(join(snapshotDir, 'manifest.json'), 'utf8'));
  const splits = JSON.parse(readFileSync(join(snapshotDir, 'splits.json'), 'utf8'));
  return { records, manifest, splits };
}

export function latestSnapshotDir(paths = storePaths()) {
  const index = loadSnapshotIndex(paths);
  if (!index.snapshots.length) return null;
  const latest = index.snapshots[index.snapshots.length - 1];
  return join(paths.snapshots, latest.version);
}
