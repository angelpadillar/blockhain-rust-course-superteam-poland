import type { PricingTable } from '../types.js';
import type { ScoringInput, ScoringResult, SystemOneScorer } from './types.js';
export interface DeepSeekScorerOptions {
    apiKey?: string;
    baseUrl?: string;
    model?: string;
    fetch?: typeof fetch;
    timeoutMs?: number;
    pricing?: PricingTable;
    maxCandidatesInPrompt?: number;
}
export declare class DeepSeekScorer implements SystemOneScorer {
    private readonly options;
    readonly name = "deepseek";
    readonly kind: "deepseek";
    private readonly apiKey;
    private readonly baseUrl;
    private readonly model;
    private readonly fetcher;
    private readonly timeoutMs;
    private readonly economics;
    private readonly maxCandidates;
    constructor(options?: DeepSeekScorerOptions);
    score(input: ScoringInput): Promise<ScoringResult>;
}
