import type { PricingTable } from '../types.js';
import type { DecisionType, ScoringResult } from './types.js';
export interface AutoRouterInput {
    deterministic: Pick<ScoringResult, 'ranked' | 'confidence'> | null;
    /** Number of candidates under consideration. */
    candidateCount: number;
    decisionType?: DecisionType;
    /** Expected main-model input tokens avoided by a better ranking. */
    expectedMainModelTokensSaved?: number | null;
    /** Expected extra turns avoided. */
    expectedTurnsSaved?: number | null;
    /** Expected wrong tool calls avoided. */
    expectedWrongToolCallsAvoided?: number | null;
    /** Main-model output tokens per turn (for the turn-saved term). */
    mainModelOutputTokensPerTurn?: number;
    /** Explicit USD penalty per wrong tool call. */
    wrongToolCallPenaltyUsd?: number;
    routerCostUsd?: number | null;
    routerLatencyMs?: number | null;
    /** Minimum net benefit required to call out. */
    marginUsd?: number;
    maxRouterLatencyMs?: number;
    /** Minimum normalised top-1 vs top-2 gap that counts as decisive. */
    decisiveGap?: number;
}
export interface AutoRouterDecision {
    call: boolean;
    reason: string;
    deterministicDecisive: boolean;
    expectedSavingUsd: number | null;
    routerCostUsd: number | null;
    netUsd: number | null;
    latencyEligible: boolean;
}
export declare function decideAutoRouter(input: AutoRouterInput, pricing?: PricingTable): AutoRouterDecision;
