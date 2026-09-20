import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { comparisonProtocol, comparisonSequence, baselineSourceSha256, createComparisonJournal, shouldStopComparison } from '../src/navigation-comparison.mjs';
import { createNavigationDiagnostics } from '../src/navigation-diagnostics.mjs';
import { config, temp } from './helpers.mjs';
const task = JSON.parse(await readFile(new URL('../cases/foczka-navigation.json', import.meta.url)));

test('comparison freezes the measured baseline and records distinct complete source identities', async () => {
  const protocol = await comparisonProtocol(task);
  assert.deepEqual(protocol.sequence, ['baseline', 'candidate', 'candidate', 'baseline', 'baseline', 'candidate']);
  assert.equal(protocol.sequence.filter(a => a === 'baseline').length, 3);
  assert.equal(protocol.baselineSourceSha256, baselineSourceSha256);
  for (const hash of Object.values(protocol.sourceHashes)) assert.match(hash, /^[a-f0-9]{64}$/);
  assert.notEqual(protocol.sourceHashes.baseline, protocol.sourceHashes.candidate);
  assert.equal(protocol.limits.maxModelUsdPerRun, task.maxModelUsd);
});

test('comparison retains failed attempts with arm provenance but no account configuration', async t => {
  const protocol = await comparisonProtocol(task);
  const journal = await createComparisonJournal(await temp(t), { task, config, protocol, arm: 'candidate', run: 2, pair: 1,
    environment: 'fixture', batchId: 'fixture' });
  const diagnostics = createNavigationDiagnostics({ journal, abort: () => {} });
  await diagnostics.onEvent({ type: 'action_planned', step: 1, kind: 'click' });
  await diagnostics.blockMutation('POST', 'https://example.test/carts/private-id', async () => {});
  await diagnostics.finish({ status: 'incomplete', reason: 'candidate_stale_recovery_limit' });
  const raw = await readFile(journal.path, 'utf8'), report = JSON.parse(raw);
  assert.equal(report.arm, 'candidate'); assert.equal(report.pair, 1);
  assert.equal(report.sourceSha256, protocol.sourceHashes.candidate);
  assert.equal(report.baselineSourceSha256, baselineSourceSha256);
  assert.equal(report.status, 'incomplete'); assert.equal(report.events.length, 2);
  assert(!raw.includes(config.expectedAddress)); assert(!raw.includes('private-id'));
});

test('comparison preserves ordinary failures but stops when further attempts need attention or accounting is incomplete', () => {
  for (const reason of ['step_limit', 'product_open_rollback_limit', 'model_unavailable', 'candidate_stale_recovery_limit']) {
    assert.equal(shouldStopComparison({ reason, metrics: { usageComplete: true } }), false);
  }
  for (const reason of ['provider_http_402', 'provider_network_error', 'destination_requires_setup', 'browser_challenge',
    'merchant_site_unavailable', 'navigation_journal_failed', 'browser_close_failed', 'AbortError']) {
    assert.equal(shouldStopComparison({ reason }), true);
  }
  assert.equal(shouldStopComparison({ metrics: { usageComplete: false } }), true);
});
