import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildSnapshot, loadSnapshot, latestSnapshotDir } from '../lib/snapshot.mjs';
import { storePaths } from '../lib/paths.mjs';

const fakeHasher = () => '0000000000000000';

function record(index, { label = 'VERIFIED_SUCCESSFUL_ACTION', withImage = false, dir = null } = {}) {
  const record = {
    schema: 'buena.browser-decision.record/1',
    decision_id: `dec_${index}`,
    job_id: `job-${index}`,
    profile_id: 'prof_test',
    trajectory_id: `traj-${index}`,
    timestamp: '2026-09-25T00:00:00.000Z',
    step: 0,
    state: { text: `state ${index}`, page_class: `family.${index % 4}`, fingerprint_material: [`fp-${index}`] },
    candidates: [{ id: 'click_a', description: 'A' }, { id: 'click_b', description: 'B' }],
    chosen: 'click_a',
    label_quality: label,
    label: { target_action: 'click_a', basis: 'receipt' },
    outcome: { status: 'success', verified: true },
    provenance: { source: 'test' },
  };
  if (withImage && dir) {
    const image = join(dir, `img-${index}.png`);
    writeFileSync(image, `fake-image-${index}`);
    record.evidence = { screenshot: { source_path: image, sha256: `sha-${index}`, dhash: '0000000000000000', bytes: 10 } };
  }
  return record;
}

function tempStore() {
  const root = mkdtempSync(join(tmpdir(), 'flywheel-snapshot-'));
  return { paths: storePaths({ root }), root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test('snapshot writes manifest, hashes, images and splits', () => {
  const { paths, root, cleanup } = tempStore();
  try {
    mkdirSync(root, { recursive: true });
    const records = Array.from({ length: 10 }, (_, index) => record(index, { withImage: index < 3, dir: root }));
    const result = buildSnapshot({ records, paths, hasher: fakeHasher });
    assert.equal(result.version, 'browser-decision-v001');
    const manifest = JSON.parse(readFileSync(join(result.dir, 'manifest.json'), 'utf8'));
    assert.equal(manifest.counts.total_decisions, 10);
    assert.equal(manifest.leakage.clean, true);
    assert.equal(manifest.counts.image_records, 3);
    const imageHashes = JSON.parse(readFileSync(join(result.dir, 'image-hashes.json'), 'utf8'));
    assert.equal(Object.keys(imageHashes).length, 3);
    const hashFile = JSON.parse(readFileSync(join(result.dir, 'record-hashes.json'), 'utf8'));
    assert.equal(Object.keys(hashFile).length, 10);
    assert.ok(readFileSync(join(result.dir, 'decisions.jsonl'), 'utf8').split('\n').filter(Boolean).length === 10);
    assert.ok(readFileSync(join(result.dir, 'records.canonical.jsonl'), 'utf8').length > 0);
  } finally {
    cleanup();
  }
});

test('snapshots are versioned and existing versions are never overwritten', () => {
  const { paths, root, cleanup } = tempStore();
  try {
    const records = Array.from({ length: 6 }, (_, index) => record(index));
    const first = buildSnapshot({ records, paths, hasher: fakeHasher });
    assert.throws(() => buildSnapshot({ records, paths, hasher: fakeHasher, version: first.version }), /already exists/);
    const second = buildSnapshot({ records, paths, hasher: fakeHasher });
    assert.equal(second.version, 'browser-decision-v002');
    assert.ok(latestSnapshotDir(paths).endsWith('browser-decision-v002'));
  } finally {
    cleanup();
  }
});

test('the immutable test set cannot be moved by a later build', () => {
  const { paths, cleanup } = tempStore();
  try {
    const records = Array.from({ length: 12 }, (_, index) => record(index));
    buildSnapshot({ records, paths, hasher: fakeHasher });
    const heldoutPath = paths.heldout;
    const heldout = JSON.parse(readFileSync(heldoutPath, 'utf8'));
    const testTrajectory = Object.entries(heldout.assignments).find(([, entry]) => entry.split === 'test')[0];
    heldout.assignments[testTrajectory] = { split: 'train', frozen_at: 'tampered' };
    writeFileSync(heldoutPath, `${JSON.stringify(heldout, null, 2)}\n`);
    assert.throws(() => buildSnapshot({ records, paths, hasher: fakeHasher }), /immutable test set violation/);
  } finally {
    cleanup();
  }
});

test('loadSnapshot exposes records and manifest', () => {
  const { paths, cleanup } = tempStore();
  try {
    const records = Array.from({ length: 4 }, (_, index) => record(index));
    const built = buildSnapshot({ records, paths, hasher: fakeHasher });
    const loaded = loadSnapshot(built.dir);
    assert.equal(loaded.records.length, 4);
    assert.equal(loaded.manifest.version, 'browser-decision-v001');
  } finally {
    cleanup();
  }
});
