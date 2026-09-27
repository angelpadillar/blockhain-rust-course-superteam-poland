/**
 * Trajectory-atomic splits with an immutable held-out test registry.
 *
 * - A trajectory (job/profile sequence) lands in exactly one split, forever.
 * - The first snapshot freezes every assignment into registry/heldout.json.
 * - Later snapshots may add new trajectories but may never move a frozen one.
 * - Only dedupe representatives enter valid/test; duplicates are train-only and
 *   only when their representative is in train.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export const SPLIT_RATIOS = { train: 0.6, valid: 0.2, test: 0.2 };
export const SPLIT_SEED = 42;

export function loadHeldout(heldoutPath) {
  if (!existsSync(heldoutPath)) {
    return { schema: 'buena.browser-decision.heldout/1', immutable_test: true, created_at: null, assignments: {} };
  }
  const registry = JSON.parse(readFileSync(heldoutPath, 'utf8'));
  if (registry.schema !== 'buena.browser-decision.heldout/1') throw new Error(`unexpected heldout registry schema ${registry.schema}`);
  return registry;
}

export function saveHeldout(heldoutPath, registry) {
  mkdirSync(dirname(heldoutPath), { recursive: true });
  writeFileSync(heldoutPath, `${JSON.stringify(registry, null, 2)}\n`, { encoding: 'utf8' });
}

function orderKey(trajectoryId, seed = SPLIT_SEED) {
  return createHash('sha256').update(`${seed}:${trajectoryId}`).digest('hex');
}

/**
 * @param {Array} canonicalRecords dedupe representatives
 * @param {Array} duplicates non-representative records (follow their representative)
 */
export function assignSplits(canonicalRecords, duplicates, { heldoutPath, seed = SPLIT_SEED, now = () => new Date().toISOString() }) {
  const registry = loadHeldout(heldoutPath);
  const assignments = { ...registry.assignments };
  const created = registry.created_at ?? now();

  const groups = new Map();
  for (const record of canonicalRecords) {
    if (!groups.has(record.trajectory_id)) groups.set(record.trajectory_id, []);
    groups.get(record.trajectory_id).push(record);
  }

  const fresh = [...groups.keys()].filter((trajectory) => !assignments[trajectory]).sort((a, b) => orderKey(a, seed).localeCompare(orderKey(b, seed)));
  const counts = { train: 0, valid: 0, test: 0 };
  for (const trajectory of Object.keys(assignments)) {
    const split = assignments[trajectory].split;
    counts[split] = (counts[split] ?? 0) + (groups.get(trajectory)?.length ?? 0);
  }
  const totalCanonical = canonicalRecords.length;

  // Guarantee strict examples in valid/test when the fresh pool allows.
  const strictScore = (records) => records.filter((record) => record.label_quality !== 'AMBIGUOUS' && record.label?.target_action).length;
  const freshSorted = fresh.slice().sort((a, b) => strictScore(groups.get(b)) - strictScore(groups.get(a)) || orderKey(a, seed).localeCompare(orderKey(b, seed)));
  const seeded = [];
  if (!Object.values(assignments).some((entry) => entry.split === 'test') && freshSorted.length >= 2) seeded.push(['test', freshSorted.shift()]);
  if (!Object.values(assignments).some((entry) => entry.split === 'valid') && freshSorted.length >= 1) seeded.push(['valid', freshSorted.shift()]);
  for (const [split, trajectory] of seeded) {
    assignments[trajectory] = { split, frozen_at: now() };
    counts[split] += groups.get(trajectory).length;
  }

  const remaining = fresh.filter((trajectory) => !assignments[trajectory]);
  for (const trajectory of remaining) {
    let best = 'train';
    let bestDeficit = -Infinity;
    for (const split of ['train', 'valid', 'test']) {
      const deficit = SPLIT_RATIOS[split] * totalCanonical - counts[split];
      if (deficit > bestDeficit) {
        bestDeficit = deficit;
        best = split;
      }
    }
    assignments[trajectory] = { split: best, frozen_at: now() };
    counts[best] += groups.get(trajectory).length;
  }

  // Immutability guard: nothing frozen may ever leave test/valid.
  for (const [trajectory, entry] of Object.entries(registry.assignments)) {
    if (assignments[trajectory]?.split !== entry.split) {
      throw new Error(`held-out split for trajectory ${trajectory} may not move (${entry.split} -> ${assignments[trajectory]?.split})`);
    }
    if (entry.split === 'test' && !registry.immutable_test) throw new Error('held-out test registry is not immutable');
  }

  const splitIds = { train: [], valid: [], test: [] };
  const representBy = new Map(canonicalRecords.map((record) => [record.decision_id, record]));
  for (const record of canonicalRecords) {
    const split = assignments[record.trajectory_id].split;
    record.split = split;
    splitIds[split].push(record.decision_id);
  }
  const trainOnlyDuplicates = [];
  const crossTrajectoryDuplicates = [];
  for (const duplicate of duplicates) {
    const representative = representBy.get(duplicate.dedupe?.near_duplicate_of);
    if (!representative || representative.trajectory_id !== duplicate.trajectory_id) {
      // A frame lineage that crosses trajectories is excluded entirely: it may
      // never ride into another trajectory's split.
      duplicate.split = null;
      crossTrajectoryDuplicates.push(duplicate.decision_id);
      continue;
    }
    duplicate.split = representative.split === 'train' ? 'train' : null;
    if (duplicate.split === 'train') trainOnlyDuplicates.push(duplicate.decision_id);
  }

  const updated = {
    schema: registry.schema,
    immutable_test: true,
    created_at: created,
    updated_at: now(),
    seed,
    assignments,
  };

  const leakage = checkLeakage(canonicalRecords, duplicates, assignments);
  return { registry: updated, assignments, splitIds, trainOnlyDuplicates, crossTrajectoryDuplicates, counts, leakage, newAssignments: remaining.length + seeded.length };
}

export function checkLeakage(canonicalRecords, duplicates, assignments) {
  const shaMap = new Map();
  const trajectoryMap = new Map();
  const crossings = { sha256: [], trajectory: [], duplicate_in_eval: [] };
  const all = [...canonicalRecords, ...duplicates.filter((record) => record.split)];
  for (const record of all) {
    const split = record.split ?? (assignments[record.trajectory_id]?.split ?? 'train');
    if (record.evidence?.screenshot?.sha256) {
      const sha = record.evidence.screenshot.sha256;
      if (shaMap.has(sha) && shaMap.get(sha) !== split) crossings.sha256.push(record.decision_id);
      shaMap.set(sha, split);
    }
    if (trajectoryMap.has(record.trajectory_id) && trajectoryMap.get(record.trajectory_id) !== split) crossings.trajectory.push(record.decision_id);
    trajectoryMap.set(record.trajectory_id, split);
    if (split !== 'train' && record.dedupe?.role === 'near_duplicate') crossings.duplicate_in_eval.push(record.decision_id);
  }
  return {
    sha256_crossing: [...new Set(crossings.sha256)],
    trajectory_crossing: [...new Set(crossings.trajectory)],
    duplicate_in_eval: [...new Set(crossings.duplicate_in_eval)],
    clean: crossings.sha256.length === 0 && crossings.trajectory.length === 0 && crossings.duplicate_in_eval.length === 0,
  };
}
