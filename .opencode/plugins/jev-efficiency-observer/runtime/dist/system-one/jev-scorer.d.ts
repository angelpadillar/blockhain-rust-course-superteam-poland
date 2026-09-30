/**
 * JevScorer — S1. Asks TypeSafe Jev a `choice` question over the candidate
 * ids using the exact wire shape the frozen Cline plugin already uses
 * (`{model, state, questions}` -> `{answers}`), so it is also wire-compatible
 * with CLM's `/v1/systemone`.
 *
 * Pricing for Jev is not published here, so `cost.usd` is null unless the
 * caller supplies a per-question price.
 */
import type { ScoringInput, ScoringResult, SystemOneScorer } from './types.js';
export interface JevScorerOptions {
    apiKey?: string;
    baseUrl?: string;
    model?: string;
    fetch?: typeof fetch;
    timeoutMs?: number;
    /** Optional explicit price; leave unset to keep cost unknown (null). */
    usdPerQuestion?: number | null;
}
export declare class JevScorer implements SystemOneScorer {
    private readonly options;
    readonly name = "jev";
    readonly kind: "jev";
    private readonly apiKey;
    private readonly baseUrl;
    private readonly model;
    private readonly fetcher;
    private readonly timeoutMs;
    constructor(options?: JevScorerOptions);
    score(input: ScoringInput): Promise<ScoringResult>;
}
