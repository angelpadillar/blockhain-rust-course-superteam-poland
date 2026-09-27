/**
 * AUTO router economics — decides whether a System One call earns its cost.
 *
 * This is the `EconomicsPolicy` extension the runtime uses for routing: an
 * obvious deterministic decision must NOT call CLM/Jev/DeepSeek, and a
 * non-obvious one only calls when the expected main-model benefit (fewer input
 * tokens, fewer turns, fewer wrong tool calls) exceeds router cost + latency
 * budget + margin.
 *
 * Unknown cost is null, never assumed to be zero.
 */
import { EconomicsPolicy, FROZEN_PRICING } from '../economics.js';
export function decideAutoRouter(input, pricing = FROZEN_PRICING) {
    const economics = new EconomicsPolicy(pricing);
    const ranked = input.deterministic?.ranked ?? [];
    const gap = input.decisiveGap ?? 0.35;
    let decisive = false;
    let why = '';
    if (input.candidateCount <= 1) {
        decisive = true;
        why = 'single candidate';
    }
    else if (ranked.length >= 2) {
        const top = ranked[0].score;
        const second = ranked[1].score;
        const denom = Math.abs(top) + 1e-9;
        if ((top - second) / denom >= gap) {
            decisive = true;
            why = `deterministic margin ${(((top - second) / denom) * 100).toFixed(0)}% >= ${(gap * 100).toFixed(0)}%`;
        }
    }
    const latencyEligible = input.routerLatencyMs === null || input.routerLatencyMs === undefined
        ? true
        : input.maxRouterLatencyMs === undefined || input.routerLatencyMs <= input.maxRouterLatencyMs;
    if (decisive) {
        return {
            call: false,
            reason: `deterministic decisive (${why})`,
            deterministicDecisive: true,
            expectedSavingUsd: null,
            routerCostUsd: input.routerCostUsd ?? null,
            netUsd: null,
            latencyEligible,
        };
    }
    const tokenSaving = economics.savingsFromAvoidedInput(input.expectedMainModelTokensSaved ?? 0);
    const turnSaving = economics.savingsFromAvoidedOutput((input.expectedTurnsSaved ?? 0) * (input.mainModelOutputTokensPerTurn ?? 400));
    const wrongCallSaving = (input.expectedWrongToolCallsAvoided ?? 0) * (input.wrongToolCallPenaltyUsd ?? 0);
    const anyExpectation = (input.expectedMainModelTokensSaved ?? 0) > 0 ||
        (input.expectedTurnsSaved ?? 0) > 0 ||
        (input.expectedWrongToolCallsAvoided ?? 0) > 0;
    const expectedSavingUsd = anyExpectation ? (tokenSaving ?? 0) + (turnSaving ?? 0) + wrongCallSaving : null;
    if (expectedSavingUsd === null) {
        return {
            call: false,
            reason: 'no expected-benefit model supplied',
            deterministicDecisive: false,
            expectedSavingUsd: null,
            routerCostUsd: input.routerCostUsd ?? null,
            netUsd: null,
            latencyEligible,
        };
    }
    if (input.routerCostUsd === null || input.routerCostUsd === undefined) {
        return {
            call: false,
            reason: 'router cost unknown (null, not assumed zero)',
            deterministicDecisive: false,
            expectedSavingUsd,
            routerCostUsd: null,
            netUsd: null,
            latencyEligible,
        };
    }
    const margin = input.marginUsd ?? 0;
    const netUsd = expectedSavingUsd - input.routerCostUsd - margin;
    if (!latencyEligible) {
        return {
            call: false,
            reason: `router latency ${input.routerLatencyMs}ms exceeds budget ${input.maxRouterLatencyMs}ms`,
            deterministicDecisive: false,
            expectedSavingUsd,
            routerCostUsd: input.routerCostUsd,
            netUsd,
            latencyEligible,
        };
    }
    return {
        call: netUsd > 0,
        reason: netUsd > 0 ? 'expected benefit exceeds router cost + margin' : 'expected benefit below router cost + margin',
        deterministicDecisive: false,
        expectedSavingUsd,
        routerCostUsd: input.routerCostUsd,
        netUsd,
        latencyEligible,
    };
}
