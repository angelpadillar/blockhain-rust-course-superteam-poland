/**
 * ClmScorer — S2. Thin adapter over the official CLM System One API
 * (https://github.com/Contrastive-LM/CLM):
 *
 *   POST /v1/rank        {context, question, answers[]} -> ranked best-first
 *   POST /v1/systemone   {state, model, questions}       -> TypeSafe answers
 *   GET  /health         -> {ok, embedder, models, cache}
 *   GET  /v1/models      -> {models:[...]}
 *
 * It never imports a CLM SDK; it speaks the documented HTTP contract, so it
 * works against a local `clm-serve`, a Modal deployment, or any compatible
 * server. Requests are Bearer-authenticated when an API key is configured.
 */
import type { ScoringInput, ScoringResult, SystemOneScorer } from './types.js';
export type ClmScoreMode = 'rank' | 'systemone';
export interface ClmScorerOptions {
    baseUrl?: string;
    apiKey?: string;
    model?: string;
    fetch?: typeof fetch;
    timeoutMs?: number;
    /** 'rank' (default) uses /v1/rank; 'systemone' uses a choice question. */
    mode?: ClmScoreMode;
    /** Optional GPU $/s to attribute cost from measured latency (null = unknown). */
    usdPerSecond?: number | null;
}
interface ClmHealth {
    ok?: boolean;
    embedder?: unknown;
    models?: string[];
    cache?: Record<string, unknown> | null;
    [key: string]: unknown;
}
export declare class ClmScorer implements SystemOneScorer {
    private readonly options;
    readonly name = "clm";
    readonly kind: "clm";
    private readonly baseUrl;
    private readonly apiKey;
    private readonly model;
    private readonly fetcher;
    private readonly timeoutMs;
    readonly mode: ClmScoreMode;
    constructor(options?: ClmScorerOptions);
    private headers;
    private request;
    /** GET /health (no auth required by the official server). */
    health(): Promise<ClmHealth>;
    /** GET /v1/models. */
    models(): Promise<Array<{
        name: string;
        description?: string;
        release_date?: string;
    }>>;
    private scoreRank;
    private scoreSystemOne;
    private costFrom;
    score(input: ScoringInput): Promise<ScoringResult>;
}
export {};
