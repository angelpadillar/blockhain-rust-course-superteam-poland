/**
 * Causal memory — a bounded, provider-neutral `MemoryProvider` plus ranking
 * helpers. Episodes carry short causal summaries and outcomes; raw historical
 * transcripts are never injected.
 *
 * `DeterministicMemoryProvider` is the cheap baseline; `rankMemoryWithScorer`
 * lets any `SystemOneScorer` (Jev, CLM, DeepSeek, deterministic) re-rank the
 * same candidate episodes so memory ranking is measured on one scale.
 */
import type { AgentState, ScoringResult, SystemOneScorer } from './types.js';
import type { CandidateAction } from './types.js';
export interface MemoryEpisode {
    id: string;
    /** Bounded causal summary: what happened, why it mattered, how it ended. */
    summary: string;
    tags?: string[];
    outcome?: 'success' | 'failure' | 'unknown';
    sourceRunId?: string;
    createdAt?: number;
}
export interface MemoryQuery {
    state: AgentState;
    /** Candidate pool to rank (the provider may also retrieve its own). */
    candidates?: MemoryEpisode[];
    k?: number;
}
export interface MemoryProvider {
    retrieve(query: MemoryQuery): Promise<MemoryEpisode[]>;
}
export declare class DeterministicMemoryProvider implements MemoryProvider {
    private readonly episodes;
    constructor(episodes?: MemoryEpisode[]);
    retrieve(query: MemoryQuery): Promise<MemoryEpisode[]>;
}
export declare function episodesToCandidates(episodes: MemoryEpisode[]): CandidateAction[];
export interface RankedMemory {
    episodes: MemoryEpisode[];
    scoring: ScoringResult;
}
/** Rank memory episodes with any SystemOneScorer, preserving the scorer's audit. */
export declare function rankMemoryWithScorer(scorer: SystemOneScorer, episodes: MemoryEpisode[], state: AgentState, k?: number): Promise<RankedMemory>;
export interface MemoryMetrics {
    recallAt1: number | null;
    recallAt3: number | null;
    irrelevantInjected: number | null;
    finalContextTokens: number | null;
}
/** Compare a ranked list against a set of required episode ids. */
export declare function memoryMetrics(ranked: MemoryEpisode[], requiredIds: string[], tokenEstimate: (text: string) => number): MemoryMetrics;
