/**
 * Candidate-set cache — formalises CLM's measured advantage: fast *warm*
 * ranking over a reusable candidate set (action embeddings are independent of
 * the state and can be reused across states).
 *
 * Measured on our workload: warm-action ranking stayed at ~1-3 ms from 5 to 500
 * candidates (127x-1355x faster than a cold set), while a non-caching scorer
 * (Jev) stayed at ~220-640 ms. CLM's explicit role in the runtime is therefore:
 *
 *   FAST WARM RANKING OVER REUSABLE CANDIDATE SETS
 *
 * It is not a general memory ranker, text compressor, or universal router.
 *
 * The interface is provider-independent: any `SystemOneScorer` can back a
 * registered set; warm/cold is derived from the scorer's own cache report when
 * available, and otherwise from first-call bookkeeping.
 */
import type { AgentState, CandidateAction, ScoringContext, ScoringResult, SystemOneScorer } from './types.js';
export interface CandidateSetRegistration {
    id: string;
    candidates: CandidateAction[];
    context?: ScoringContext;
}
export interface CandidateSetEntry {
    id: string;
    candidateCount: number;
    candidates: CandidateAction[];
    context?: ScoringContext;
    registeredAt: number;
    lastUsedAt: number | null;
    calls: number;
    warmCalls: number;
    totalLatencyMs: number;
    warm: boolean;
    warmKnown: boolean;
    scorer: string;
    provider: string | null;
    model: string | null;
    embeddingReuseRatio: number | null;
}
export interface CandidateSetScore {
    result: ScoringResult;
    candidateSetId: string;
    candidateCount: number;
    /** Warm at the time of the call (action embeddings reusable). */
    warm: boolean;
    warmKnown: boolean;
    cacheAgeMs: number | null;
    embeddingReuseRatio: number | null;
    latencyMs: number | null;
    scorer: string;
    provider: string | null;
    model: string | null;
}
export interface CandidateSetScorerOptions {
    /** Defaults to true for scorer.kind === 'clm' (its server caches projections). */
    warmAfterFirstCall?: boolean;
}
export declare class CandidateSetScorer {
    private readonly scorer;
    private readonly entries;
    private readonly warmAfterFirstCall;
    constructor(scorer: SystemOneScorer, options?: CandidateSetScorerOptions);
    register(input: CandidateSetRegistration): CandidateSetEntry;
    registerMany(inputs: readonly CandidateSetRegistration[]): CandidateSetEntry[];
    list(): CandidateSetEntry[];
    get(id: string): CandidateSetEntry | undefined;
    has(id: string): boolean;
    /**
     * Rank a state against a registered candidate set. Returns the scorer result
     * plus the cache/warm bookkeeping for this call.
     */
    scoreState(input: {
        state: AgentState;
        candidateSetId: string;
        context?: ScoringContext;
    }): Promise<CandidateSetScore>;
    stats(id?: string): Record<string, unknown>;
}
