/**
 * DeterministicScorer — S0. A model-free, reproducible baseline that scores
 * candidate actions by lexical overlap with the bounded state plus a few
 * explicit task heuristics. No network, no randomness.
 *
 * It is intentionally the *cheap first stage* the AUTO policy may accept
 * without calling CLM/Jev/DeepSeek.
 */
import type { ScoringInput, ScoringResult, SystemOneScorer } from './types.js';
export interface DeterministicScorerOptions {
    /** Weight on exact id / tool-name matches. */
    idWeight?: number;
    tagWeight?: number;
    descriptionWeight?: number;
}
export declare class DeterministicScorer implements SystemOneScorer {
    private readonly options;
    readonly name = "deterministic";
    readonly kind: "deterministic";
    constructor(options?: DeterministicScorerOptions);
    score(input: ScoringInput): Promise<ScoringResult>;
}
