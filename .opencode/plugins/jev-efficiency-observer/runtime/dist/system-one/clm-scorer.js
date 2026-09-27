import { distributionConfidence, filterCandidates, rankScores, renderState } from './types.js';
function parseHitRate(cache) {
    if (!cache)
        return null;
    const direct = cache.hit_rate ?? cache.hitRate;
    if (typeof direct === 'number')
        return direct;
    const hits = typeof cache.hits === 'number' ? cache.hits : null;
    const misses = typeof cache.misses === 'number' ? cache.misses : null;
    if (hits !== null && misses !== null && hits + misses > 0)
        return hits / (hits + misses);
    return null;
}
export class ClmScorer {
    options;
    name = 'clm';
    kind = 'clm';
    baseUrl;
    apiKey;
    model;
    fetcher;
    timeoutMs;
    mode;
    constructor(options = {}) {
        this.options = options;
        this.baseUrl = (options.baseUrl ?? process.env.CLM_BASE_URL ?? 'http://127.0.0.1:8700').replace(/\/$/, '');
        this.apiKey = options.apiKey ?? process.env.CLM_API_KEY ?? '';
        this.model = options.model ?? 'clm-latest';
        this.fetcher = options.fetch ?? fetch;
        this.timeoutMs = options.timeoutMs ?? 60_000;
        this.mode = options.mode ?? 'rank';
    }
    headers() {
        const headers = { 'content-type': 'application/json' };
        if (this.apiKey)
            headers.authorization = `Bearer ${this.apiKey}`;
        return headers;
    }
    async request(path, init) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), this.timeoutMs);
        try {
            const response = await this.fetcher(`${this.baseUrl}${path}`, { ...init, headers: { ...this.headers(), ...(init.headers ?? {}) }, signal: controller.signal });
            const text = await response.text();
            const header = response.headers.get('x-clm-latency-ms');
            return { status: response.status, text, latencyHeaderMs: header ? Number(header) : null };
        }
        finally {
            clearTimeout(timer);
        }
    }
    /** GET /health (no auth required by the official server). */
    async health() {
        const { status, text } = await this.request('/health', { method: 'GET' });
        if (status >= 400)
            throw new Error(`CLM /health failed (${status}): ${text.slice(0, 200)}`);
        return JSON.parse(text);
    }
    /** GET /v1/models. */
    async models() {
        const { status, text } = await this.request('/v1/models', { method: 'GET' });
        if (status >= 400)
            throw new Error(`CLM /v1/models failed (${status}): ${text.slice(0, 200)}`);
        const parsed = JSON.parse(text);
        return parsed.models ?? [];
    }
    async scoreRank(input, candidates, state) {
        const answers = candidates.map((c) => c.description);
        const question = input.context?.instructions ?? input.state.goal;
        const started = Date.now();
        const { status, text, latencyHeaderMs } = await this.request('/v1/rank', {
            method: 'POST',
            body: JSON.stringify({ context: state, question, answers, model: this.model }),
        });
        const wallMs = Date.now() - started;
        if (status >= 400)
            throw new Error(`CLM /v1/rank failed (${status}): ${text.slice(0, 200)}`);
        const parsed = JSON.parse(text);
        const rankedItems = parsed.ranked ?? [];
        // Map result candidates back to ids. Descriptions are expected unique.
        const byText = new Map();
        for (const candidate of candidates)
            if (!byText.has(candidate.description))
                byText.set(candidate.description, candidate.id);
        const entries = rankedItems.map((item) => {
            const id = byText.get(item.candidate ?? '') ?? `unknown:${item.candidate ?? ''}`;
            return { id, score: typeof item.prob === 'number' ? item.prob : 0, probability: item.prob ?? null };
        });
        const ranked = entries.map((entry, index) => ({ ...entry, rank: index + 1 }));
        const probabilities = entries.map((e) => e.probability ?? 0);
        return {
            scorer: this.name,
            provider: 'modal-clm',
            model: parsed.model ?? this.model,
            ranked,
            confidence: distributionConfidence(probabilities),
            latencyMs: latencyHeaderMs ?? wallMs,
            usage: { inputTokens: null, outputTokens: null, billingUnits: 1 },
            cost: this.costFrom(latencyHeaderMs ?? wallMs),
            audit: { endpoint: `${this.baseUrl}/v1/rank`, mode: 'rank', wallMs, serverLatencyMs: latencyHeaderMs, candidates: candidates.length },
        };
    }
    async scoreSystemOne(input, candidates, state) {
        const instructions = input.context?.instructions ?? input.state.goal;
        const criteria = {};
        for (const candidate of candidates)
            criteria[candidate.id] = candidate.description;
        const started = Date.now();
        const { status, text, latencyHeaderMs } = await this.request('/v1/systemone', {
            method: 'POST',
            body: JSON.stringify({
                model: this.model,
                state,
                questions: { action: { type: 'choice', instructions, criteria } },
            }),
        });
        const wallMs = Date.now() - started;
        if (status >= 400)
            throw new Error(`CLM /v1/systemone failed (${status}): ${text.slice(0, 200)}`);
        const parsed = JSON.parse(text);
        const answer = parsed.answers?.action;
        if (!answer?.probabilities)
            throw new Error('CLM /v1/systemone returned no choice probabilities');
        const entries = candidates.map((candidate) => ({
            id: candidate.id,
            score: Number((answer.probabilities[candidate.id] ?? 0).toFixed(6)),
            probability: answer.probabilities[candidate.id] ?? null,
        }));
        const ranked = rankScores(entries);
        return {
            scorer: this.name,
            provider: 'modal-clm',
            model: parsed.model ?? this.model,
            ranked,
            confidence: typeof answer.confidence === 'number' ? answer.confidence : distributionConfidence(entries.map((e) => e.probability ?? 0)),
            latencyMs: latencyHeaderMs ?? wallMs,
            usage: {
                inputTokens: parsed.usage?.input_tokens ?? null,
                outputTokens: parsed.usage?.output_tokens ?? null,
                billingUnits: parsed.usage?.billing_units ?? 1,
            },
            cost: this.costFrom(latencyHeaderMs ?? wallMs),
            audit: { endpoint: `${this.baseUrl}/v1/systemone`, mode: 'systemone', wallMs, serverLatencyMs: latencyHeaderMs, choice: answer.choice ?? null },
        };
    }
    costFrom(latencyMs) {
        const rate = this.options.usdPerSecond;
        if (typeof rate !== 'number')
            return { usd: null, source: 'unavailable' };
        return { usd: (latencyMs / 1000) * rate, source: 'gpu-latency-share' };
    }
    async score(input) {
        const candidates = filterCandidates(input);
        if (candidates.length === 0)
            throw new Error('ClmScorer: no candidates');
        if (candidates.length === 1) {
            return {
                scorer: this.name,
                provider: 'modal-clm',
                model: this.model,
                ranked: [{ id: candidates[0].id, score: 1, probability: 1, rank: 1 }],
                confidence: null,
                latencyMs: 0,
                usage: { inputTokens: 0, outputTokens: null, billingUnits: 0 },
                cost: { usd: 0, source: 'single-candidate' },
                audit: { skipped: true, reason: 'one candidate needs no ranking' },
            };
        }
        const state = renderState(input.state);
        return this.mode === 'systemone' ? this.scoreSystemOne(input, candidates, state) : this.scoreRank(input, candidates, state);
    }
}
