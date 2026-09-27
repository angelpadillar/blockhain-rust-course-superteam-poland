import { distributionConfidence, filterCandidates, rankScores, renderState } from './types.js';
export class JevScorer {
    options;
    name = 'jev';
    kind = 'jev';
    apiKey;
    baseUrl;
    model;
    fetcher;
    timeoutMs;
    constructor(options = {}) {
        this.options = options;
        this.apiKey = options.apiKey ?? process.env.TYPESAFE_API_KEY ?? '';
        this.baseUrl = options.baseUrl ?? 'https://api.typesafe.ai/v1/systemone';
        this.model = options.model ?? 'jev-latest';
        this.fetcher = options.fetch ?? fetch;
        this.timeoutMs = options.timeoutMs ?? 30_000;
    }
    async score(input) {
        if (!this.apiKey)
            throw new Error('JevScorer: TYPESAFE_API_KEY is not configured');
        const candidates = filterCandidates(input);
        if (candidates.length === 0)
            throw new Error('JevScorer: no candidates');
        const state = renderState(input.state);
        const instructions = input.context?.instructions ?? input.state.goal;
        const criteria = {};
        for (const candidate of candidates)
            criteria[candidate.id] = candidate.description;
        const started = Date.now();
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), this.timeoutMs);
        let response;
        try {
            response = await this.fetcher(this.baseUrl, {
                method: 'POST',
                headers: { authorization: `Bearer ${this.apiKey}`, 'content-type': 'application/json' },
                body: JSON.stringify({
                    model: this.model,
                    state,
                    questions: { action: { type: 'choice', instructions, criteria } },
                }),
                signal: controller.signal,
            });
        }
        finally {
            clearTimeout(timer);
        }
        const text = await response.text();
        const latencyMs = Date.now() - started;
        if (!response.ok)
            throw new Error(`JevScorer: request failed (${response.status}): ${text.slice(0, 200)}`);
        let parsed;
        try {
            parsed = JSON.parse(text);
        }
        catch {
            throw new Error('JevScorer: malformed JSON');
        }
        const answer = parsed.answers?.action;
        if (!answer?.probabilities)
            throw new Error('JevScorer: response is missing choice probabilities');
        const entries = candidates.map((candidate) => ({
            id: candidate.id,
            score: Number((answer.probabilities[candidate.id] ?? 0).toFixed(6)),
            probability: answer.probabilities[candidate.id] ?? null,
        }));
        const ranked = rankScores(entries);
        const probabilities = entries.map((e) => e.probability ?? 0);
        return {
            scorer: this.name,
            provider: 'typesafe',
            model: this.model,
            ranked,
            confidence: typeof answer.confidence === 'number' ? answer.confidence : distributionConfidence(probabilities),
            latencyMs,
            usage: {
                inputTokens: parsed.usage?.input_tokens ?? null,
                outputTokens: parsed.usage?.output_tokens ?? null,
                billingUnits: 1,
            },
            cost: {
                usd: typeof this.options.usdPerQuestion === 'number' ? this.options.usdPerQuestion : null,
                source: typeof this.options.usdPerQuestion === 'number' ? 'configured' : 'unavailable',
            },
            audit: { endpoint: this.baseUrl, choice: answer.choice ?? null, candidates: candidates.length },
        };
    }
}
