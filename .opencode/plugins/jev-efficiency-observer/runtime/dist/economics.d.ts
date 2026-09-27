/**
 * EconomicsPolicy — prices token flows using an explicit, frozen price table.
 *
 * Kept deliberately provider-neutral: the caller supplies the table. Unknown
 * prices are `null`, never silently treated as zero.
 */
import type { PricingTable, TokenUsage } from './types.js';
export declare const FROZEN_PRICING: PricingTable;
export declare class EconomicsPolicy {
    private readonly pricing;
    constructor(pricing?: PricingTable);
    get table(): PricingTable;
    /** USD for `tokens` at `perMillion`. Returns null when the rate is unknown. */
    costOfTokens(tokens: number, perMillion: number | null | undefined): number | null;
    costOf(usage: TokenUsage): number | null;
    /** USD avoided by not sending `tokensAvoided` uncached input tokens. */
    savingsFromAvoidedInput(tokensAvoided: number): number | null;
    /** USD avoided by not generating `tokensAvoided` output tokens. */
    savingsFromAvoidedOutput(tokensAvoided: number): number | null;
    /** Cost of a JEV refinement pass over the given token counts. */
    jevCost(inputTokens: number, outputTokens: number): number | null;
    /**
     * Whether a JEV refinement is net-positive: the main-model output it avoids
     * must outweigh the cost of running JEV.
     */
    shouldUseJev(input: {
        jevInputTokens: number;
        jevOutputTokens: number;
        avoidedOutputTokens: number;
    }): boolean;
}
