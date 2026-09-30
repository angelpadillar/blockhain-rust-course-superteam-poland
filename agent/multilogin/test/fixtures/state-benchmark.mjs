// G5: the fixture benchmark. It runs the PRODUCTION login flow (runLogin) against
// scripted unexpected states under three configurations:
//
//   A  L1 deterministic only           (no model at all)
//   B  L1 + L2 Jev                     (finite-choice text model)
//   C  L1 + L2 Jev + L3 FrontierVision  (visual escalation, mocked provider)
//
// Costs use the MEASURED live per-call usage, so the fixture cost measures calls
// rather than extrapolating: Jev 1533 input / 41 output tokens per call (recorded
// live run), frontier 549 prompt / 0 cached / 214 output tokens per call (measured
// structured-JSON vision call).
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runLogin, sites } from '../../src/login.mjs';
import { createAdvisorChain, createJevAdvisor, createFrontierVisionAdvisor } from '../../src/advisor.mjs';
import { createFrontierLedger, summarizeFrontierMetrics } from '../../src/frontier-ledger.mjs';
import { estimatedUsd, defaultPricing } from '../../src/pricing.mjs';
import { PilotError, errorCode } from '../../src/core.mjs';
import { createReceiptStore } from '../../src/receipts.mjs';
import { buildFixture, createFixturePage, fixtureNames } from './unexpected-states.mjs';

export const jevPricing = { uncachedInput: 0.042, cachedInput: 0, output: 0 };
export const measuredJevUsage = { inputTokens: 1533, outputTokens: 41 };
export const measuredFrontierUsage = { promptTokens: 549, cachedTokens: 0, outputTokens: 214 };
export const frontierLatencyMs = 2846;
export const configurations = ['A', 'B', 'C'];

const fixtureSite = { origins: ['https://www.youtube.com', 'https://accounts.google.com',
  'https://gds.google.com'], credentialOrigins: ['https://accounts.google.com'],
  homeUrl: 'https://www.youtube.com/', loginUrl: 'https://www.youtube.com/' };
const account = { platform: 'youtube', username: 'fixture@example.com', password: 'fixture-password',
  totp: 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ', id: 'fixture' };
const round6 = value => Math.round(value * 1e6) / 1e6;

// A Jev double that models the finite-choice contract: it answers with the control
// the fixture needs when such a candidate is offered, and otherwise asks for
// attention exactly like an uncertain real answer.
export function jevDouble({ fixture }) {
  const calls = [];
  const metrics = { calls: 0 };
  const choose = async ({ actions }) => {
    // A call is a call, including an uncertain answer: the model consumed tokens.
    metrics.calls++;
    calls.push(actions.map(action => action.id));
    const wanted = fixture.expectation.capability;
    const match = wanted ? actions.find(action => action.description.startsWith(`${wanted}:`)) : null;
    if (!match) throw new PilotError('jev_uncertain_or_invalid');
    return { action: match, method: 'typesafe-choice', confidence: 0.95, probability: 0.95 };
  };
  choose.metrics = metrics;
  choose.calls = calls;
  return choose;
}

// A frontier double that only ever chooses among the permitted capabilities, and
// abstains when the fixture offers nothing it could legitimately do.
export function frontierDouble({ fixture, ledger }) {
  const calls = [];
  const usage = { uncachedInputTokens: measuredFrontierUsage.promptTokens,
    cachedInputTokens: measuredFrontierUsage.cachedTokens, outputTokens: measuredFrontierUsage.outputTokens };
  const vision = {
    async available() { return true; },
    async capture() { return { base64: 'cG5n', width: 800, height: 600, bytes: 3, name: 'fixture.png' }; },
    async decide({ permittedActions = [], observation }) {
      calls.push({ permitted: permittedActions.map(action => action.id), epoch: observation?.epoch ?? null });
      const wanted = fixture.expectation.capability;
      const match = wanted ? permittedActions.find(action => action.description.startsWith(`${wanted}:`)) : null;
      if (ledger) {
        await ledger.record({ at: new Date().toISOString(), jobId: fixture.name, trigger: 'visual_only_ui',
          observationEpoch: observation?.epoch ?? null, latencyMs: frontierLatencyMs, usageSource: 'provider',
          ...usage, reasoningTokens: 180, requestId: 'fixture', pricing: defaultPricing,
          estimatedUsd: estimatedUsd(usage, defaultPricing), decision: match ? 'action' : 'abstain',
          chosenAction: match?.id ?? null, policy: 'accepted' });
      }
      return match ? { actionId: match.id, confidence: 0.9, reason: 'fixture' } : { abstain: true };
    },
  };
  vision.calls = calls;
  return createFrontierVisionAdvisor({ vision, name: 'frontier-vision-fixture' });
}

export function buildChooser({ configuration, fixture, ledger }) {
  if (configuration === 'A') {
    // L1 = the deterministic layer alone: a single permitted action is taken with
    // zero model calls (the production exact-single-match shortcut), and anything
    // ambiguous is an abstention rather than a guess.
    const calls = [];
    const choose = async ({ actions }) => {
      calls.push(actions.map(action => action.id));
      if (actions.length === 1) {
        return { action: actions[0], method: 'exact-single-match', confidence: null, probability: null };
      }
      throw new PilotError('no_model_configured');
    };
    choose.metrics = { calls: 0 }; choose.calls = calls;
    return { choose, frontier: null };
  }
  if (configuration === 'B') {
    // Production behaviour: the exact-single-match shortcut means one permitted
    // action costs zero model calls, and only a genuine choice reaches Jev.
    const jev = jevDouble({ fixture });
    const calls = [];
    const choose = async ({ actions }) => {
      calls.push(actions.map(action => action.id));
      if (actions.length === 1) {
        return { action: actions[0], method: 'exact-single-match', confidence: null, probability: null };
      }
      return jev({ actions });
    };
    choose.metrics = jev.metrics; choose.calls = calls;
    return { choose, frontier: null };
  }
  const jev = createJevAdvisor({ choose: jevDouble({ fixture }) });
  const frontier = frontierDouble({ fixture, ledger });
  return { choose: createAdvisorChain({ jev, frontier, classifySecurityCheckpoint: null }), frontier };
}

// One (fixture, configuration) run of the production flow.
export async function runFixture({ fixtureName, configuration, directory }) {
  const fixture = buildFixture(fixtureName);
  const page = createFixturePage(fixture);
  const ledger = createFrontierLedger({ directory: join(directory, `ledger-${fixtureName}-${configuration}`) });
  // The kernel writes its own durable receipts here, which is what the
  // postcondition success/failure metrics are read from.
  const receipts = createReceiptStore({ directory: join(directory, `receipts-${fixtureName}-${configuration}`) });
  const { choose, frontier } = buildChooser({ configuration, fixture, ledger });
  const events = [];
  let humanCheckpoints = 0;
  const started = Date.now();
  let outcome;
  try {
    outcome = await runLogin({ page, account, choose, site: fixtureSite, maxSteps: 6, maxSeconds: 20,
      readyWindowMs: 0, recoveryBudget: 3, goal: 'Recover the unexpected browser state, or stop safely.',
      receipts, onStep: async event => { events.push(event); },
      requestHumanCheckpoint: async () => { humanCheckpoints++; return null; } });
  } catch (error) { outcome = { failed: true, reason: errorCode(error) }; }
  const latencyMs = Date.now() - started;
  const frontierEntries = await ledger.entries();
  const kernelReceipts = await receipts.entries();
  const jevCalls = choose?.advisors?.jev?.metrics?.calls ?? choose?.metrics?.calls ?? 0;
  const frontierCalls = frontier ? frontier.metrics.calls : 0;
  const actionEvents = events.filter(event => event.action && event.state === 'before');
  const frontierCost = frontierEntries.reduce((total, receipt) =>
    total + (Number.isFinite(receipt.estimatedUsd) ? receipt.estimatedUsd : 0), 0);
  return {
    fixture: fixtureName, label: fixture.label, configuration,
    recovered: outcome.verified === true,
    postconditionFailed: kernelReceipts.some(receipt => receipt.postconditionMet === false),
    postconditionVerified: kernelReceipts.some(receipt => receipt.postconditionMet === true),
    humanCheckpoints, humanRequired: humanCheckpoints > 0,
    halted: outcome.failed === true, reason: outcome.reason ?? null,
    wrongActions: page.state.wrong,
    deterministicActions: actionEvents.filter(event => event.method === 'exact-single-match').length,
    jevCalls, frontierCalls,
    actions: actionEvents.map(event => event.action), clicks: page.state.clicks,
    receiptsRecorded: kernelReceipts.length, latencyMs,
    jevCostUsd: round6((jevCalls * measuredJevUsage.inputTokens / 1e6) * jevPricing.uncachedInput),
    frontierCostUsd: round6(frontierCost),
  };
}

export async function runBenchmark({ configurationsToRun = configurations, fixtures = fixtureNames } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'g5-benchmark-'));
  const results = [];
  try {
    for (const fixtureName of fixtures) {
      for (const configuration of configurationsToRun) {
        results.push(await runFixture({ fixtureName, configuration, directory }));
      }
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
  const summary = {};
  for (const configuration of configurationsToRun) {
    const own = results.filter(result => result.configuration === configuration);
    const attempted = own.length;
    const recovered = own.filter(result => result.recovered).length;
    const jevCost = own.reduce((total, result) => total + result.jevCostUsd, 0);
    const frontierCost = own.reduce((total, result) => total + result.frontierCostUsd, 0);
    const wrongActions = own.reduce((total, result) => total + result.wrongActions, 0);
    const human = own.filter(result => result.humanRequired).length;
    summary[configuration] = {
      attempted,
      successfulRecoveries: recovered,
      recoveryRate: attempted ? Math.round((recovered / attempted) * 1000) / 1000 : null,
      wrongActions,
      wrongActionRate: attempted ? Math.round((wrongActions / attempted) * 1000) / 1000 : null,
      abstentions: own.filter(result => !result.recovered && result.wrongActions === 0
        && result.postconditionFailed === false).length,
      deterministicActions: own.reduce((total, result) => total + result.deterministicActions, 0),
      jevCalls: own.reduce((total, result) => total + result.jevCalls, 0),
      frontierCalls: own.reduce((total, result) => total + result.frontierCalls, 0),
      frontierTasks: own.filter(result => result.frontierCalls > 0).length,
      humanCheckpoints: own.reduce((total, result) => total + result.humanCheckpoints, 0),
      humanInterventionRate: attempted ? Math.round((human / attempted) * 1000) / 1000 : null,
      latencyMeanMs: attempted
        ? Math.round(own.reduce((total, result) => total + result.latencyMs, 0) / attempted) : null,
      jevCostUsd: round6(jevCost),
      frontierCostUsd: round6(frontierCost),
      totalModelCostUsd: round6(jevCost + frontierCost),
      costPerSuccessfulRecoveryUsd: recovered ? round6((jevCost + frontierCost) / recovered) : null,
      frontierCostPerSuccessfulRecoveryUsd: recovered ? round6(frontierCost / recovered) : null,
      postconditionSuccesses: own.filter(result => result.recovered && !result.postconditionFailed).length,
      postconditionFailures: own.filter(result => result.postconditionFailed).length,
    };
  }
  const l3Runs = results.filter(result => result.frontierCalls > 0);
  const frontierMetrics = summarizeFrontierMetrics(l3Runs.map(result => ({
    jobId: result.fixture, trigger: 'visual_only_ui', latencyMs: frontierLatencyMs, usageSource: 'provider',
    uncachedInputTokens: measuredFrontierUsage.promptTokens, cachedInputTokens: 0,
    outputTokens: measuredFrontierUsage.outputTokens,
    estimatedUsd: round6(result.frontierCostUsd / Math.max(result.frontierCalls, 1)),
    decision: 'action', policy: 'accepted', postconditionSuccess: result.recovered,
  })), { jobs: fixtureNames.length, completedTasks: l3Runs.length });
  return { results, summary, frontierMetrics };
}
