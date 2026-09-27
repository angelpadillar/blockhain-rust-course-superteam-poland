import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assignSplits, loadHeldout, saveHeldout } from '../lib/splits.mjs';

function makeRecord(id, trajectory, { label = 'VERIFIED_SUCCESSFUL_ACTION', target = 'click_a', sha = null } = {}) {
  return {
    decision_id: id,
    trajectory_id: trajectory,
    timestamp: '2026-09-25T00:00:00Z',
    label_quality: label,
    label: target ? { target_action: target, basis: 'receipt' } : undefined,
    candidates: [{ id: 'click_a', description: 'A' }, { id: 'click_b', description: 'B' }],
    state: { page_class: 'p', fingerprint_material: [id] },
    evidence: sha ? { screenshot: { sha256: sha } } : undefined,
    dedupe: { role: 'representative' },
  };
}

function tempPaths() {
  const root = mkdtempSync(join(tmpdir(), 'flywheel-splits-'));
  return { root, heldoutPath: join(root, 'heldout.json'), cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test('every trajectory lands in exactly one split and leakage is clean', () => {
  const { heldoutPath, cleanup } = tempPaths();
  try {
    const records = [];
    for (let index = 0; index < 12; index += 1) {
      records.push(makeRecord(`dec_${index}`, `traj-${index}`, { sha: `sha-${index}` }));
    }
    const result = assignSplits(records, [], { heldoutPath });
    const seen = new Map();
    for (const record of records) {
      const split = record.split;
      assert.ok(['train', 'valid', 'test'].includes(split));
      if (seen.has(record.trajectory_id)) assert.equal(seen.get(record.trajectory_id), split);
      seen.set(record.trajectory_id, split);
    }
    assert.equal(result.leakage.clean, true);
    assert.ok(result.splitIds.test.length >= 1, 'test must not be empty');
    assert.ok(result.splitIds.valid.length >= 1, 'valid must not be empty');
  } finally {
    cleanup();
  }
});

test('a frozen held-out trajectory never moves across subsequent runs', () => {
  const { heldoutPath, cleanup } = tempPaths();
  try {
    const first = Array.from({ length: 6 }, (_, index) => makeRecord(`dec_${index}`, `traj-${index}`, { sha: `sha-${index}` }));
    const result = assignSplits(first, [], { heldoutPath });
    const testTrajectory = Object.entries(result.registry.assignments).find(([, entry]) => entry.split === 'test')[0];
    // Add new records for the frozen test trajectory plus many new trajectories.
    const expanded = [
      ...first,
      makeRecord('dec_new', testTrajectory, { sha: 'sha-new' }),
      ...Array.from({ length: 10 }, (_, index) => makeRecord(`dec_x${index}`, `traj-x${index}`, { sha: `sha-x${index}` })),
    ];
    const second = assignSplits(expanded, [], { heldoutPath });
    assert.equal(second.registry.assignments[testTrajectory].split, 'test');
    assert.ok(second.splitIds.test.includes('dec_new'));
  } finally {
    cleanup();
  }
});

test('cross-trajectory duplicates are excluded from evaluation', () => {
  const { heldoutPath, cleanup } = tempPaths();
  try {
    const canonical = [makeRecord('dec_a', 'traj-a', { sha: 'shared' }), makeRecord('dec_b', 'traj-b', { sha: 'own' })];
    const duplicate = makeRecord('dec_dup', 'traj-b', { sha: 'shared' });
    duplicate.dedupe = { role: 'near_duplicate', near_duplicate_of: 'dec_a' };
    const result = assignSplits(canonical, [duplicate], { heldoutPath });
    assert.equal(duplicate.split, null);
    assert.ok(result.crossTrajectoryDuplicates.includes('dec_dup'));
    assert.equal(result.leakage.clean, true);
  } finally {
    cleanup();
  }
});

test('heldout registry persists assignments across runs', () => {
  const { heldoutPath, cleanup } = tempPaths();
  try {
    const records = Array.from({ length: 6 }, (_, index) => makeRecord(`dec_${index}`, `traj-${index}`, { sha: `sha-${index}` }));
    const first = assignSplits(records, [], { heldoutPath });
    saveHeldout(heldoutPath, first.registry);
    const persisted = loadHeldout(heldoutPath);
    const second = assignSplits(records, [], { heldoutPath });
    assert.deepEqual(Object.keys(persisted.assignments).sort(), Object.keys(second.registry.assignments).sort());
    for (const trajectory of Object.keys(persisted.assignments)) {
      assert.equal(second.registry.assignments[trajectory].split, persisted.assignments[trajectory].split);
    }
  } finally {
    cleanup();
  }
});
