/** Text of a tool result value, or null when it is not safely reducible text. */
export function toolResultText(result) {
    if (!result || typeof result !== 'object')
        return null;
    const value = result;
    if (value.type === 'text')
        return typeof value.value === 'string' ? value.value : String(value.value ?? '');
    if (value.type === 'content') {
        if (!Array.isArray(value.value))
            return null;
        const texts = [];
        for (const part of value.value) {
            if (!part || typeof part !== 'object')
                return null;
            const p = part;
            if (p.type !== 'text' || typeof p.text !== 'string')
                return null; // file/media parts are never reduced
            texts.push(p.text);
        }
        return texts.join('\n');
    }
    return null; // json / error / unknown values are passed through
}
function walkParts(messages, options, outMessages, records, totals) {
    for (let messageIndex = 0; messageIndex < messages.length; messageIndex += 1) {
        const message = messages[messageIndex];
        if (!message || typeof message !== 'object' || !Array.isArray(message.content)) {
            outMessages.push(message);
            continue;
        }
        let changed = false;
        const content = message.content.map((part, partIndex) => {
            if (!part || typeof part !== 'object')
                return part;
            const p = part;
            if (p.type !== 'tool-result')
                return part;
            const text = toolResultText(p.result);
            if (text === null || text.length === 0)
                return part;
            const decision = options.policy.evaluate({ toolName: String(p.name ?? 'tool'), text });
            if (decision.action !== 'reduce')
                return part;
            if (options.allowedClasses && decision.resultClass && !options.allowedClasses.includes(decision.resultClass))
                return part;
            if (!decision.evidence)
                return part;
            const rawTokens = options.estimator.estimate(text);
            const projectedTokens = options.estimator.estimate(decision.text);
            const recovered = options.recover(decision.evidence.evidenceId);
            const evidenceRecoveryExact = recovered === text;
            changed = true;
            records.push({
                messageIndex,
                partIndex,
                toolName: String(p.name ?? 'tool'),
                resultType: p.result.type === 'content' ? 'content' : 'text',
                rawTokens,
                projectedTokens,
                tokensAvoided: rawTokens - projectedTokens,
                classification: decision.resultClass,
                strategy: decision.strategy,
                evidencePointer: decision.evidence,
                evidenceRecoveryExact,
                rawSha256: decision.evidence.evidenceId,
            });
            totals.raw += rawTokens;
            totals.projected += projectedTokens;
            totals.avoided += rawTokens - projectedTokens;
            const result = p.result;
            if (result.type === 'text') {
                return { ...p, result: { ...result, value: decision.text } };
            }
            // content with only text parts -> collapse to one text part with the admitted text
            return { ...p, result: { type: 'text', value: decision.text } };
        });
        outMessages.push(changed ? { ...message, content } : message);
    }
}
/**
 * Project a message array: returns new messages plus per-result records.
 * Never mutates `messages`.
 */
export function projectToolResults(messages, options) {
    const outMessages = [];
    const records = [];
    const totals = { raw: 0, projected: 0, avoided: 0 };
    walkParts(messages, options, outMessages, records, totals);
    return {
        messages: outMessages,
        records,
        rawTokens: totals.raw,
        projectedTokens: totals.projected,
        tokensAvoided: totals.avoided,
    };
}
/**
 * Fail-open wrapper for production: any classifier/reducer/evidence error, or a
 * projection that fails validation, returns the ORIGINAL messages with no
 * records, so the coding agent always keeps working and the model sees the
 * canonical result.
 */
export function projectToolResultsFailOpen(messages, options) {
    const abandoned = (reason) => ({
        messages,
        records: [],
        rawTokens: 0,
        projectedTokens: 0,
        tokensAvoided: 0,
        fellBack: true,
        fallbackReason: reason.slice(0, 240),
    });
    try {
        if (!Array.isArray(messages))
            return abandoned('messages is not an array');
        const projection = projectToolResults(messages, options);
        if (projection.messages.length !== messages.length)
            return abandoned('projection changed the message count');
        for (const record of projection.records) {
            if (record.evidenceRecoveryExact !== true)
                return abandoned(`evidence round-trip failed for ${record.rawSha256.slice(0, 12)}`);
            if (!Number.isFinite(record.projectedTokens) || record.projectedTokens < 0)
                return abandoned('projected token estimate invalid');
            if (record.projectedTokens >= record.rawTokens)
                return abandoned('projection did not reduce the result');
        }
        return { ...projection, fellBack: false, fallbackReason: null };
    }
    catch (error) {
        return abandoned(String(error?.message ?? error));
    }
}
