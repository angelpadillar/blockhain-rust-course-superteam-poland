/**
 * TokenEstimator — a swappable, dependency-free structural token estimate.
 *
 * The default is the same cheap `chars / N` heuristic used by the frozen
 * governor's structural accounting. A provider can inject a real tokenizer
 * (tiktoken, a provider count endpoint, etc.) behind this interface without
 * the rest of the runtime changing.
 */
export interface TokenEstimator {
    readonly name: string;
    estimate(text: string): number;
}
export declare class StructuralTokenEstimator implements TokenEstimator {
    private readonly charsPerToken;
    readonly name: string;
    constructor(charsPerToken?: number);
    estimate(text: string): number;
}
/** Estimates the total cost of a list of message texts. */
export declare function estimateMessages(estimator: TokenEstimator, texts: readonly string[]): number;
/** Estimates the schema tokens of a tool list (name + description + input schema). */
export declare function estimateToolSchemaTokens(estimator: TokenEstimator, tools: readonly {
    name: string;
    description: string;
    inputSchema?: unknown;
}[]): number;
