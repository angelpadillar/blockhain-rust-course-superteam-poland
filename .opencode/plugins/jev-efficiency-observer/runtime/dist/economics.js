export const FROZEN_PRICING = {
    mainModel: 'fireworks::accounts/fireworks/models/deepseek-v4p1-flash',
    uncachedInputPerM: 0.22,
    cachedInputPerM: 0.007,
    outputPerM: 0.66,
    jevInputPerM: 0.042,
    jevOutputPerM: 0,
};
export class EconomicsPolicy {
    pricing;
    constructor(pricing = FROZEN_PRICING) {
        this.pricing = pricing;
    }
    get table() {
        return { ...this.pricing };
    }
    /** USD for `tokens` at `perMillion`. Returns null when the rate is unknown. */
    costOfTokens(tokens, perMillion) {
        if (!Number.isFinite(tokens) || !Number.isFinite(perMillion))
            return null;
        return (tokens * perMillion) / 1e6;
    }
    costOf(usage) {
        const parts = [
            this.costOfTokens(usage.uncachedInput, this.pricing.uncachedInputPerM),
            this.costOfTokens(usage.cachedInput, this.pricing.cachedInputPerM),
            this.costOfTokens(usage.output, this.pricing.outputPerM),
        ];
        if (parts.some((p) => p === null))
            return null;
        return parts[0] + parts[1] + parts[2];
    }
    /** USD avoided by not sending `tokensAvoided` uncached input tokens. */
    savingsFromAvoidedInput(tokensAvoided) {
        return this.costOfTokens(tokensAvoided, this.pricing.uncachedInputPerM);
    }
    /** USD avoided by not generating `tokensAvoided` output tokens. */
    savingsFromAvoidedOutput(tokensAvoided) {
        return this.costOfTokens(tokensAvoided, this.pricing.outputPerM);
    }
    /** Cost of a JEV refinement pass over the given token counts. */
    jevCost(inputTokens, outputTokens) {
        const a = this.costOfTokens(inputTokens, this.pricing.jevInputPerM);
        const b = this.costOfTokens(outputTokens, this.pricing.jevOutputPerM);
        if (a === null || b === null)
            return null;
        return a + b;
    }
    /**
     * Whether a JEV refinement is net-positive: the main-model output it avoids
     * must outweigh the cost of running JEV.
     */
    shouldUseJev(input) {
        const saved = this.savingsFromAvoidedOutput(input.avoidedOutputTokens);
        const cost = this.jevCost(input.jevInputTokens, input.jevOutputTokens);
        if (saved === null || cost === null)
            return false;
        return saved > cost;
    }
}
