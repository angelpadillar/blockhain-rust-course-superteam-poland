import type { PricingTable } from '../types.js';
import type { ScoringResult } from './types.js';
export type AutoRouterV2Choice = 'deterministic' | 'clm' | 'jev' | 'main-model';
export interface AutoRouterV2Costs {
    /** Expected USD per CLM call (measured latency share or a configured rate). */
    clmUsdPerCall?: number | null;
    /** Expected USD per Jev call; null means unpublished/unknown. */
    jevUsdPerCall?: number | null;
    expectedClmLatencyMs?: number | null;
    expectedJevLatencyMs?: number | null;
    maxRouterLatencyMs?: number;
    marginUsd?: number;
}
export interface AutoRouterV2Input {
    candidateCount: number;
    deterministic: Pick<ScoringResult, 'ranked' | 'confidence'>;
    /** Calibrated deterministic margin threshold (see ROUTER-CONFIDENCE-CALIBRATION.md). */
    calibratedMargin: number;
    candidateSetId?: string | null;
    candidateSetWarm?: boolean | null;
    candidateSetStable?: boolean | null;
    clmAvailable?: boolean;
    jevAvailable?: boolean;
    expectedMainModelTokensSaved?: number | null;
    expectedTurnsSaved?: number | null;
    expectedWrongToolCallsAvoided?: number | null;
    mainModelOutputTokensPerTurn?: number;
    wrongToolCallPenaltyUsd?: number;
    costs?: AutoRouterV2Costs;
    pricing?: PricingTable;
}
export interface AutoRouterV2Decision {
    choice: AutoRouterV2Choice;
    reason: string;
    deterministicDecisive: boolean;
    expectedSavingUsd: number | null;
    routerCostUsd: number | null;
    netUsd: number | null;
    latencyMs: number | null;
    cacheWarm: boolean | null;
}
export declare function deterministicMargin(deterministic: Pick<ScoringResult, 'ranked' | 'confidence'>): number | null;
/** Expected USD of one router call from a measured/estimated latency share. */
export declare function latencyShareUsd(usdPerSecond: number, latencyMs: number): number;
export declare function decideAutoRouterV2(input: AutoRouterV2Input): AutoRouterV2Decision;
/** Convenience: cost attribution helper used by the plugin/eval harness. */
export declare function clmUsdPerCall(containerUsdPerSecond: number, expectedLatencyMs: number): number;
