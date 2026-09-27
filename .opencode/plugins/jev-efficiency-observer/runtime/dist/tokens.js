export class StructuralTokenEstimator {
    charsPerToken;
    name;
    constructor(charsPerToken = 4) {
        this.charsPerToken = charsPerToken;
        if (!Number.isFinite(charsPerToken) || charsPerToken <= 0) {
            throw new Error('charsPerToken must be a positive number');
        }
        this.name = `structural/chars-${charsPerToken}`;
    }
    estimate(text) {
        if (typeof text !== 'string' || text.length === 0)
            return 0;
        return Math.ceil(text.length / this.charsPerToken);
    }
}
/** Estimates the total cost of a list of message texts. */
export function estimateMessages(estimator, texts) {
    let total = 0;
    for (const text of texts)
        total += estimator.estimate(text);
    return total;
}
/** Estimates the schema tokens of a tool list (name + description + input schema). */
export function estimateToolSchemaTokens(estimator, tools) {
    let total = 0;
    for (const tool of tools) {
        total += estimator.estimate(`${tool.name}: ${tool.description} ${JSON.stringify(tool.inputSchema ?? {})}`);
    }
    return total;
}
