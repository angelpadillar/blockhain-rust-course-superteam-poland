import test from 'node:test';
import assert from 'node:assert/strict';
import { runBenchmark, runFixture } from './fixtures/state-benchmark.mjs';
import { buildFixture } from './fixtures/unexpected-states.mjs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { classifyPage } from '../src/login.mjs';

// G5: the fixture benchmark as a test. The fixtures are synthetic page doubles, so
// every configuration sees byte-identical states; these assertions are the
// behavioural contract, not a report of one lucky run.
const fast = ['dynamic_rerender', 'visual_onboarding', 'ambiguous_buttons', 'captcha_detection'];

async function withDirectory(run) {
  const directory = await mkdtemp(join(tmpdir(), 'g5-test-'));
  try { return await run(directory); } finally { await rm(directory, { recursive: true, force: true }); }
}

test('L1 alone recovers a deterministic unexpected state with zero model calls', async () => {
  await withDirectory(async directory => {
    const result = await runFixture({ fixtureName: 'dynamic_rerender', configuration: 'A', directory });
    assert.equal(result.recovered, true, 'the volatile re-render does not block the action');
    assert.equal(result.jevCalls, 0);
    assert.equal(result.frontierCalls, 0);
    assert.equal(result.wrongActions, 0);
    assert.equal(result.deterministicActions > 0, true, 'the decision was deterministic');
  });
});

test('a visual/ambiguous state is abstained by L1, decided by L2, and L3 is not consulted when L2 suffices', async () => {
  await withDirectory(async directory => {
    const l1 = await runFixture({ fixtureName: 'visual_onboarding', configuration: 'A', directory });
    assert.equal(l1.recovered, false, 'L1 alone does not guess how to dismiss an interstitial');
    assert.equal(l1.jevCalls, 0);
    assert.equal(l1.wrongActions, 0);

    const l2 = await runFixture({ fixtureName: 'visual_onboarding', configuration: 'B', directory });
    assert.equal(l2.recovered, true);
    assert.equal(l2.jevCalls > 0, true, 'the capability came from the text model');
    assert.equal(l2.frontierCalls, 0);

    const l3 = await runFixture({ fixtureName: 'visual_onboarding', configuration: 'C', directory });
    assert.equal(l3.recovered, true);
    assert.equal(l3.frontierCalls, 0, 'L3 stays unused while L2 can decide');
  });
});

test('two identical controls are never guessed at, even with a visual model', async () => {
  await withDirectory(async directory => {
    const result = await runFixture({ fixtureName: 'ambiguous_buttons', configuration: 'C', directory });
    assert.equal(result.wrongActions, 0, 'the model is never licensed to pick between identical controls');
    assert.equal(result.recovered, false, 'and the run stops safely instead');
    assert.equal(result.frontierCalls > 0, true, 'the state did reach L3');
    assert.equal(result.humanCheckpoints >= 0, true);
  });
});

test('a CAPTCHA is classified for a person in every configuration and never acted on', async () => {
  await withDirectory(async directory => {
    for (const configuration of ['A', 'B', 'C']) {
      const result = await runFixture({ fixtureName: 'captcha_detection', configuration, directory });
      assert.equal(result.humanRequired, true, `${configuration}: a person is asked`);
      assert.equal(result.humanCheckpoints, 1);
      assert.equal(result.wrongActions, 0, `${configuration}: no click is ever attempted`);
      assert.equal(result.actions.length, 0, `${configuration}: no browser action runs`);
      assert.equal(result.frontierCalls, 0, `${configuration}: vision is never asked about a challenge`);
      assert.equal(result.reason, 'human_verification_required');
      // With the advisor chain the classified checkpoint is escalated before any
      // model is consulted; a bare chooser may be asked to pick an escape, which is
      // still not an attempt to solve the challenge.
      if (configuration === 'C') assert.equal(result.jevCalls, 0);
    }
    // The classification itself is the existing page classifier.
    const fixture = buildFixture('captcha_detection');
    assert.equal(classifyPage({ ...fixture.frames[0], controls: [] }), 'human_verification_required');
  });
});

test('the benchmark reports every metric the comparison needs', async () => {
  const { summary, results, frontierMetrics } = await runBenchmark({
    configurationsToRun: ['A', 'B', 'C'], fixtures: fast });
  assert.equal(results.length, fast.length * 3);
  for (const configuration of ['A', 'B', 'C']) {
    const row = summary[configuration];
    for (const key of ['attempted', 'successfulRecoveries', 'recoveryRate', 'wrongActions', 'wrongActionRate',
      'abstentions', 'deterministicActions', 'jevCalls', 'frontierCalls', 'humanCheckpoints',
      'humanInterventionRate', 'latencyMeanMs', 'jevCostUsd', 'frontierCostUsd', 'totalModelCostUsd',
      'costPerSuccessfulRecoveryUsd', 'postconditionSuccesses', 'postconditionFailures']) {
      assert.equal(Object.hasOwn(row, key), true, `${configuration}.${key}`);
    }
    assert.equal(row.attempted, fast.length);
  }
  // Costs are priced from the measured live per-call usage, so they are small but
  // never negative, and only a configuration that reaches L3 spends frontier money.
  assert.equal(summary.A.frontierCostUsd, 0);
  assert.equal(summary.B.frontierCostUsd, 0);
  assert.equal(summary.C.frontierCalls > 0, true);
  assert.equal(summary.C.frontierCostUsd > 0, true);
  assert.equal(summary.C.jevCostUsd > 0, true, 'the Jev calls are priced too');
  assert.equal(frontierMetrics.calls, summary.C.frontierCalls);
  // No configuration produced a wrong action anywhere in this sample.
  assert.equal(summary.A.wrongActions + summary.B.wrongActions + summary.C.wrongActions, 0);
  // Recovery rates are ordered: more capability never recovers less.
  assert.equal(summary.C.recoveryRate >= summary.B.recoveryRate, true);
  assert.equal(summary.B.recoveryRate >= summary.A.recoveryRate, true);
});
