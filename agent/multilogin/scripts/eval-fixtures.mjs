// G5: run the fixture benchmark and print the comparison table plus the frontier
// economics. Fixtures are synthetic and offline; nothing here touches an account.
//
//   node scripts/eval-fixtures.mjs [--configs A,B,C] [--fixtures all|name,name]
import { runBenchmark, configurations, measuredFrontierUsage, frontierLatencyMs,
  measuredJevUsage } from '../test/fixtures/state-benchmark.mjs';
import { fixtureNames } from '../test/fixtures/unexpected-states.mjs';
import { estimatedUsd, defaultPricing } from '../src/pricing.mjs';

// The real-provider reference point, measured on the live structured-JSON call.
export const liveReference = {
  latencyMs: frontierLatencyMs,
  promptTokens: measuredFrontierUsage.promptTokens,
  cachedTokens: measuredFrontierUsage.cachedTokens,
  outputTokens: measuredFrontierUsage.outputTokens,
  usd: estimatedUsd({ uncachedInputTokens: measuredFrontierUsage.promptTokens,
    cachedInputTokens: measuredFrontierUsage.cachedTokens,
    outputTokens: measuredFrontierUsage.outputTokens }, defaultPricing),
};

const flag = (argv, name, fallback) => {
  const index = argv.indexOf(`--${name}`);
  return index >= 0 && argv[index + 1] ? argv[index + 1] : fallback;
};

const argv = process.argv.slice(2);
const configs = (flag(argv, 'configs', configurations.join(','))).split(',').map(value => value.trim());
const fixtures = flag(argv, 'fixtures', 'all') === 'all'
  ? fixtureNames : flag(argv, 'fixtures').split(',').map(value => value.trim());

const { results, summary, frontierMetrics } = await runBenchmark({ configurationsToRun: configs, fixtures });

console.log('=== per state ===');
for (const result of results) {
  console.log([result.configuration, result.fixture.padEnd(23),
    `recovered=${String(result.recovered).padEnd(5)}`,
    `wrong=${result.wrongActions}`, `det=${result.deterministicActions}`,
    `jev=${result.jevCalls}`, `l3=${result.frontierCalls}`,
    `human=${result.humanCheckpoints}`, `postFail=${result.postconditionFailed}`,
    `ms=${result.latencyMs}`, `jevUsd=${result.jevCostUsd}`, `l3Usd=${result.frontierCostUsd}`,
    result.reason ? `(${result.reason})` : ''].join(' '));
}

console.log('\n=== configuration summary ===');
for (const configuration of configs) {
  const row = summary[configuration];
  console.log(`${configuration}: attempted=${row.attempted} recovered=${row.successfulRecoveries} ` +
    `recoveryRate=${row.recoveryRate} wrongActions=${row.wrongActions} wrongRate=${row.wrongActionRate} ` +
    `abstained=${row.abstentions} det=${row.deterministicActions} jev=${row.jevCalls} l3=${row.frontierCalls} ` +
    `human=${row.humanCheckpoints} humanRate=${row.humanInterventionRate} meanMs=${row.latencyMeanMs} ` +
    `jevUsd=${row.jevCostUsd} frontierUsd=${row.frontierCostUsd} totalUsd=${row.totalModelCostUsd} ` +
    `usdPerRecovery=${row.costPerSuccessfulRecoveryUsd} postOk=${row.postconditionSuccesses} ` +
    `postFail=${row.postconditionFailures}`);
}

const anyL3 = summary[configs[configs.length - 1]] || summary.C;
console.log('\n=== G5 frontier economics (fixture sample, priced from the measured live call) ===');
console.log(JSON.stringify({
  liveReference,
  fixtureSample: {
    calls: frontierMetrics.calls,
    tasksReachingL3: anyL3.frontierTasks,
    percentTasksRequiringL3: anyL3.attempted
      ? Math.round((anyL3.frontierTasks / anyL3.attempted) * 1000) / 10 : null,
    callsPerCompletedTask: frontierMetrics.calls && anyL3.frontierTasks
      ? Math.round((frontierMetrics.calls / anyL3.frontierTasks) * 100) / 100 : null,
    meanLatencyMs: frontierMetrics.latencyMeanMs,
    p50LatencyMs: frontierMetrics.latencyP50Ms,
    p95LatencyMs: frontierMetrics.latencyP95Ms,
    meanCostPerCallUsd: frontierMetrics.calls
      ? Math.round((anyL3.frontierCostUsd / frontierMetrics.calls) * 1e6) / 1e6 : null,
    costPerSuccessfulRecoveryUsd: anyL3.frontierCostPerSuccessfulRecoveryUsd,
    jevPlusFrontierCostPerCompletedTaskUsd: anyL3.attempted
      ? Math.round((anyL3.totalModelCostUsd / anyL3.attempted) * 1e6) / 1e6 : null,
    jevReferenceUsagePerCall: measuredJevUsage,
  },
  // Latency and per-call cost in the sample are the MEASURED live values applied to
  // fixture calls; rates are fixture behaviour, not a live-provider distribution.
  label: 'fixture sample priced with the measured live per-call usage (no extrapolation beyond it)',
}, null, 2));
