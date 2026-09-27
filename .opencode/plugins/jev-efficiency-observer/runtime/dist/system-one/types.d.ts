/**
 * SystemOneScorer — a model-agnostic fast-decision scorer contract.
 *
 * Implementations (deterministic, Jev, CLM, DeepSeek Flash, future) all answer
 * the same question: given a bounded agent state and a closed set of candidate
 * actions, which candidates are most likely to be correct, and at what cost?
 *
 * The rest of the runtime never branches on which scorer is active; it consumes
 * `ScoringResult.ranked` (and the audit/economics fields) uniformly.
 */
import type { JsonSchema } from '../types.js';
/**
 * A local or inline media reference for a scorer that accepts visual state.
 *
 * `url` is a local path, a `data:` URL, or (for hosts that pre-upload assets)
 * an `asset:<id>` reference. Scorers never assume the provider can reach the
 * caller's filesystem: text-only scorers ignore media entirely, while the
 * `ValenScorer` materializes local bytes into the request body.
 */
export interface SystemOneImage {
    /** Local path, `data:` URL, or provider asset reference. */
    url: string;
    /** Optional content hash of the exact bytes, for audit/replay. */
    sha256?: string;
    /** Optional MIME type hint (inferred from the path/extension when absent). */
    mediaType?: string;
    /** Optional originating screenshot id / browser observation epoch. */
    id?: string;
}
export interface SystemOneVideo {
    /** Local path, `data:` URL, or provider asset reference. */
    url: string;
    sha256?: string;
    mediaType?: string;
    id?: string;
}
export interface AgentState {
    /** The bounded task goal / current objective. */
    goal: string;
    /** Bounded recent actions (tool call summaries), oldest first. */
    recentActions?: string[];
    /** Bounded recent results (truncated), aligned with recentActions when possible. */
    recentResults?: string[];
    /** Errors/failures that should bias the decision. */
    errors?: string[];
    /**
     * Optional compact structured state (normalized browser state, form
     * summary, observation epoch, ...). Text scorers ignore it unless a host
     * renders it into `rendered`; multimodal scorers may serialize it verbatim.
     */
    structured?: Record<string, unknown>;
    /** Optional visual state (screenshots, viewport frames). */
    images?: SystemOneImage[];
    /** Optional video state (clips, recorded trajectories). */
    video?: SystemOneVideo[];
    /** Arbitrary decision metadata (fixture id, turn index, ...). */
    metadata?: Record<string, unknown>;
    /** Optional pre-rendered prose state; when present it is used verbatim. */
    rendered?: string;
}
export interface CandidateAction {
    /** Stable id used to map scores back to actions (tool name, episode id, ...). */
    id: string;
    /** Text the action head / prompt sees. Should be self-contained prose. */
    description: string;
    /** Optional originating tool name. */
    toolName?: string;
    tags?: string[];
    risk?: 'low' | 'medium' | 'high';
    inputSchema?: JsonSchema;
}
export type DecisionType = 'tool-routing' | 'recovery' | 'memory' | 'best-of-n';
export interface ScoringContext {
    decisionType?: DecisionType;
    /** Restrict scoring to these candidate ids (deterministic prefilter). */
    allowedCandidateIds?: string[];
    /** Extra instructions appended after the state. */
    instructions?: string;
    /** Soft latency budget (ms). */
    budgetMs?: number;
}
export interface ScoringInput {
    state: AgentState;
    candidates: CandidateAction[];
    context?: ScoringContext;
}
export interface ScoreEntry {
    id: string;
    /** Comparable score, higher is better. */
    score: number;
    /** Probability when the provider returns a distribution. */
    probability?: number | null;
    /** 1-based rank. */
    rank: number;
}
export interface SystemOneUsage {
    inputTokens?: number | null;
    outputTokens?: number | null;
    /** Provider billing units (CLM: number of questions). */
    billingUnits?: number | null;
}
export interface CacheStatus {
    stateCached?: boolean | null;
    actionsCached?: number | null;
    actionsTotal?: number | null;
    hitRate?: number | null;
}
export interface ScoringResult {
    scorer: string;
    provider?: string | null;
    model?: string | null;
    ranked: ScoreEntry[];
    confidence?: number | null;
    latencyMs: number | null;
    usage?: SystemOneUsage;
    cost?: {
        usd: number | null;
        source: string;
    };
    cache?: CacheStatus;
    /** Everything needed to audit or replay the decision. */
    audit: Record<string, unknown>;
}
export interface SystemOneScorer {
    readonly name: string;
    readonly kind: 'deterministic' | 'jev' | 'clm' | 'deepseek' | 'valen' | 'custom';
    score(input: ScoringInput): Promise<ScoringResult>;
}
export declare function renderState(state: AgentState, maxChars?: number): string;
/** True when the state carries any visual/structured payload a multimodal scorer can use. */
export declare function hasMedia(state: AgentState): boolean;
/** Apply a deterministic candidate filter from the context. */
export declare function filterCandidates(input: ScoringInput): CandidateAction[];
/** Attach ranks to a score map, deterministically (score desc, id asc). */
export declare function rankScores(entries: Array<{
    id: string;
    score: number;
    probability?: number | null;
}>): ScoreEntry[];
/** TypeSafe-style confidence: top probability minus the mean of the rest. */
export declare function distributionConfidence(probabilities: number[]): number | null;
