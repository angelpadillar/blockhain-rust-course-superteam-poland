import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clusterDuplicates, hammingDistance, stateFingerprint } from '../lib/dedupe.mjs';

function record(id, { family = 'page', fingerprint = null, dhash = null, sha = null, label = 'AMBIGUOUS', verified = false, timestamp = '2026-09-25T00:00:00Z', trajectory = 't' } = {}) {
  return {
    decision_id: id,
    trajectory_id: trajectory,
    timestamp,
    label_quality: label,
    outcome: { verified },
    state: { page_class: family, fingerprint_material: fingerprint ?? [id], text: `state-${id}` },
    evidence: sha || dhash ? { screenshot: { sha256: sha, dhash } } : undefined,
  };
}

test('hamming distance is symmetric and zero for identical hashes', () => {
  assert.equal(hammingDistance('0000000000000000', '0000000000000000'), 0);
  assert.equal(hammingDistance('0000000000000001', '0000000000000000'), 1);
  assert.equal(hammingDistance('ffffffffffffffff', '0000000000000000'), 64);
});

test('exact sha duplicates cluster and the best label becomes representative', () => {
  const inputs = [record('a', { sha: 'same-sha', label: 'AMBIGUOUS' }), record('b', { sha: 'same-sha', label: 'VERIFIED_SUCCESSFUL_ACTION', verified: true }), record('c', { sha: 'other-sha' })];
  const { canonical, duplicates } = clusterDuplicates(inputs);
  assert.equal(canonical.length, 2);
  assert.equal(duplicates, 1);
  assert.ok(canonical.some((item) => item.decision_id === 'b'));
  const duplicate = inputs.find((item) => item.decision_id === 'a');
  assert.equal(duplicate.dedupe.role, 'near_duplicate');
  assert.equal(duplicate.dedupe.near_duplicate_of, 'b');
  assert.equal(duplicate.dedupe.similarity, 'exact_sha');
});

test('dhash proximity clusters within the same family but never across families', () => {
  const hashes = { x: '0000000000000000', y: '0000000000000003', z: '0000000000000000' };
  const hasher = (path) => hashes[path];
  const { canonical, duplicates } = clusterDuplicates(
    [
      record('a', { family: 'p1', dhash: '0000000000000000' }),
      record('b', { family: 'p1', dhash: '0000000000000003' }),
      record('c', { family: 'p2', dhash: '0000000000000000' }),
    ],
    { hasher },
  );
  assert.equal(duplicates, 1);
  assert.equal(canonical.length, 2);
  assert.equal(hasher('x'), '0000000000000000');
});

test('identical state fingerprints cluster regardless of image', () => {
  const a = record('a', { fingerprint: ['menu', 'open'] });
  const b = record('b', { fingerprint: ['menu', 'open'] });
  const c = record('c', { fingerprint: ['menu', 'closed'] });
  const { canonical, duplicates } = clusterDuplicates([a, b, c]);
  assert.equal(canonical.length, 2);
  assert.equal(duplicates, 1);
  assert.notEqual(stateFingerprint(a), stateFingerprint(c));
});

test('label quality wins over capture time when choosing a representative', () => {
  const early = record('early', { sha: 'dup', label: 'AMBIGUOUS', timestamp: '2026-01-01T00:00:00Z' });
  const strong = record('strong', { sha: 'dup', label: 'VERIFIED_SUCCESSFUL_ACTION', timestamp: '2026-02-01T00:00:00Z' });
  const { canonical } = clusterDuplicates([early, strong]);
  assert.equal(canonical[0].decision_id, 'strong');
});
