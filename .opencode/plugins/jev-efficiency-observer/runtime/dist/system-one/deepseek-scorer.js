/**
 * DeepSeekFlashScorer — S3. Uses the main model itself (Fireworks
 * `deepseek-v4p1-flash`, OpenAI-compatible chat completions) as a prompted
 * System One ranker, so we can compare "ask the big model" against the cheap
 * scorers on the exact same states/candidates.
 *
 * Cost is derived from measured usage x the frozen price table; unknown stays
 * null.
 */
import { EconomicsPolicy, FROZEN_PRICING } from '../economics.js';
import { distributionConfidence, filterCandidates, rankScores, renderState } from './types.js';
function extractJson(text) {
    const trimmed = text.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
    try {
        return JSON.parse(trimmed);
    }
    catch {
        const match = trimmed.match(/\{[\s\S]*\}/);
        if (!match)
            throw new Error('DeepSeekScorer: response did not contain JSON');
        return JSON.parse(match[0]);
    }
}
export class DeepSeekScorer {
    options;
    name = 'deepseek';
    kind = 'deepseek';
    apiKey;
    baseUrl;
    model;
    fetcher;
    timeoutMs;
    economics;
    maxCandidates;
    constructor(options = {}) {
        this.options = options;
        this.apiKey = options.apiKey ?? process.env.FIREWORKS_API_KEY ?? '';
        this.baseUrl = (options.baseUrl ?? 'https://api.fireworks.ai/inference/v1').replace(/\/$/, '');
        this.model = options.model ?? FROZEN_PRICING.mainModel.split('::')[1] ?? 'accounts/fireworks/models/deepseek-v4p1-flash';
        this.fetcher = options.fetch ?? fetch;
        this.timeoutMs = options.timeoutMs ?? 60_000;
        this.economics = new EconomicsPolicy(options.pricing ?? FROZEN_PRICING);
        this.maxCandidates = options.maxCandidatesInPrompt ?? 40;
    }
    async score(input) {
        if (!this.apiKey)
            throw new Error('DeepSeekScorer: FIREWORKS_API_KEY is not configured');
        const candidates = filterCandidates(input).slice(0, this.maxCandidates);
        if (candidates.length === 0)
            throw new Error('DeepSeekScorer: no candidates');
        const state = renderState(input.state);
        const instruction = input.context?.instructions ?? input.state.goal;
        const candidateLines = candidates.map((c) => `${c.id}: ${c.description}`).join('\n');
        const body = {
            model: this.model,
            temperature: 0,
            max_tokens: 4096,
            response_format: { type: 'json_object' },
            messages: [
                {
                    role: 'system',
                    content: 'You are a deterministic action-ranker for a coding agent. Given the state and a closed set of candidate actions, ' +
                        'rank every candidate best-first. Reply with strict JSON only: {"ranking":[{"id":"<candidate id>","confidence":<0..1>}, ...]}. ' +
                        'Include every candidate exactly once. No prose.',
                },
                { role: 'user', content: `State:\n${state}\n\nQuestion: ${instruction}\n\nCandidates:\n${candidateLines}` },
            ],
        };
        const started = Date.now();
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), this.timeoutMs);
        let response;
        try {
            response = await this.fetcher(`${this.baseUrl}/chat/completions`, {
                method: 'POST',
                headers: { authorization: `Bearer ${this.apiKey}`, 'content-type': 'application/json' },
                body: JSON.stringify(body),
                signal: controller.signal,
            });
        }
        finally {
            clearTimeout(timer);
        }
        const text = await response.text();
        const latencyMs = Date.now() - started;
        if (!response.ok)
            throw new Error(`DeepSeekScorer: request failed (${response.status}): ${text.slice(0, 300)}`);
        const parsed = JSON.parse(text);
        const content = parsed.choices?.[0]?.message?.content ?? '';
        const rankingDoc = extractJson(content);
        const rawRanking = rankingDoc.ranking ?? [];
        const seen = new Set();
        const ordered = [];
        for (const item of rawRanking) {
            const id = typeof item === 'string' ? item : item?.id;
            if (!id || seen.has(id) || !candidates.some((c) => c.id === id))
                continue;
            seen.add(id);
            ordered.push({ id, confidence: typeof item === 'object' && typeof item.confidence === 'number' ? item.confidence : null });
        }
        // Any candidate the model omitted is appended in deterministic order.
        for (const candidate of candidates)
            if (!seen.has(candidate.id))
                ordered.push({ id: candidate.id, confidence: null });
        const n = ordered.length;
        const entries = ordered.map((item, index) => ({
            id: item.id,
            score: n - index,
            probability: item.confidence,
        }));
        const ranked = rankScores(entries);
        const usage = {
            inputTokens: parsed.usage?.prompt_tokens ?? null,
            outputTokens: parsed.usage?.completion_tokens ?? null,
            billingUnits: 1,
        };
        const cost = usage.inputTokens !== null && usage.outputTokens !== null
            ? {
                usd: this.economics.costOf({ uncachedInput: usage.inputTokens, cachedInput: 0, output: usage.outputTokens }),
                source: 'derived-usage-x-price-table',
            }
            : { usd: null, source: 'unavailable' };
        return {
            scorer: this.name,
            provider: 'fireworks',
            model: this.model,
            ranked,
            confidence: distributionConfidence(ordered.map((o) => o.confidence ?? 0)),
            latencyMs,
            usage,
            cost,
            audit: { endpoint: `${this.baseUrl}/chat/completions`, candidates: candidates.length, omittedByModel: candidates.length - seen.size },
        };
    }
}
