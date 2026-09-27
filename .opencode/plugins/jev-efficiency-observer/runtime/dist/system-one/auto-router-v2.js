/**
 * AUTO Router V2 — the measured routing policy.
 *
 * Decision order:
 *   1 candidate                          -> deterministic
 *   deterministic margin >= calibrated   -> deterministic
 *   stable candidate set + warm CLM      -> CLM (only if economics are favorable)
 *   ambiguity remains, top-K matters     -> Jev (only if economics are favorable)
 *   otherwise                            -> main-model fallback
 *
 * DeepSeek Flash is intentionally NOT in the default tree: measured p50 9.1 s /
 * p95 32.3 s at ~70x CLM's latency with no top-1 gain over the free baseline.
 * It stays available to experiments, never as the default System One router.
 */
import { FROZEN_PRICING } from '../economics.js';
import { decideAutoRouter } from './auto-policy.js';
export function deterministicMargin(deterministic) {
    const ranked = deterministic.ranked ?? [];
    if (ranked.length < 2)
        return ranked.length === 1 ? 1 : null;
    const top = ranked[0].score;
    const second = ranked[1].score;
    const denom = Math.abs(top) + 1e-9;
    return (top - second) / denom;
}
/** Expected USD of one router call from a measured/estimated latency share. */
export function latencyShareUsd(usdPerSecond, latencyMs) {
    return (latencyMs / 1000) * usdPerSecond;
}
export function decideAutoRouterV2(input) {
    const costs = input.costs ?? {};
    const pricing = input.pricing ?? FROZEN_PRICING;
    const base = {
        deterministicDecisive: false,
        expectedSavingUsd: null,
        routerCostUsd: null,
        netUsd: null,
        latencyMs: null,
        cacheWarm: input.candidateSetWarm ?? null,
    };
    if (input.candidateCount <= 1) {
        return { ...base, choice: 'deterministic', reason: 'single candidate' };
    }
    const margin = deterministicMargin(input.deterministic);
    if (margin === null) {
        return { ...base, choice: 'main-model', reason: 'deterministic margin unavailable' };
    }
    if (margin >= input.calibratedMargin) {
        return {
            ...base,
            choice: 'deterministic',
            deterministicDecisive: true,
            reason: `deterministic margin ${(margin * 100).toFixed(0)}% >= calibrated ${(input.calibratedMargin * 100).toFixed(0)}%`,
        };
    }
    const preferClm = Boolean(input.clmAvailable) &&
        input.candidateSetStable === true &&
        input.candidateSetWarm === true &&
        typeof input.candidateSetId === 'string' &&
        input.candidateSetId.length > 0;
    const order = preferClm ? ['clm', 'jev'] : ['jev', 'clm'];
    let lastReason = 'no router available';
    let lastSaving = null;
    let lastRouterCost = null;
    let lastNet = null;
    for (const candidate of order) {
        if (candidate === 'clm' && !input.clmAvailable)
            continue;
        if (candidate === 'jev' && !input.jevAvailable)
            continue;
        const routerCostUsd = candidate === 'clm' ? (costs.clmUsdPerCall ?? null) : (costs.jevUsdPerCall ?? null);
        const routerLatencyMs = candidate === 'clm' ? (costs.expectedClmLatencyMs ?? null) : (costs.expectedJevLatencyMs ?? null);
        const economics = decideAutoRouter({
            deterministic: input.deterministic,
            candidateCount: input.candidateCount,
            expectedMainModelTokensSaved: input.expectedMainModelTokensSaved ?? null,
            expectedTurnsSaved: input.expectedTurnsSaved ?? null,
            expectedWrongToolCallsAvoided: input.expectedWrongToolCallsAvoided ?? null,
            mainModelOutputTokensPerTurn: input.mainModelOutputTokensPerTurn,
            wrongToolCallPenaltyUsd: input.wrongToolCallPenaltyUsd,
            routerCostUsd,
            routerLatencyMs,
            marginUsd: costs.marginUsd,
            maxRouterLatencyMs: costs.maxRouterLatencyMs,
            // Never let the economics layer return "deterministic decisive"; we
            // already handled that above. Set decisiveGap above any real margin.
            decisiveGap: 2,
        }, pricing);
        lastReason = economics.reason;
        lastSaving = economics.expectedSavingUsd;
        lastRouterCost = economics.routerCostUsd;
        lastNet = economics.netUsd;
        if (economics.call) {
            return {
                choice: candidate,
                reason: `${candidate} selected: ${economics.reason}`,
                deterministicDecisive: false,
                expectedSavingUsd: economics.expectedSavingUsd,
                routerCostUsd: economics.routerCostUsd,
                netUsd: economics.netUsd,
                latencyMs: routerLatencyMs,
                cacheWarm: candidate === 'clm' ? (input.candidateSetWarm ?? null) : null,
            };
        }
    }
    return {
        ...base,
        choice: 'main-model',
        reason: `no System One call justified: ${lastReason}`,
        expectedSavingUsd: lastSaving,
        routerCostUsd: lastRouterCost,
        netUsd: lastNet,
    };
}
/** Convenience: cost attribution helper used by the plugin/eval harness. */
export function clmUsdPerCall(containerUsdPerSecond, expectedLatencyMs) {
    return latencyShareUsd(containerUsdPerSecond, expectedLatencyMs);
}
