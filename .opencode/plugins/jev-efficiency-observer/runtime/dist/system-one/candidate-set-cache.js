export class CandidateSetScorer {
    scorer;
    entries = new Map();
    warmAfterFirstCall;
    constructor(scorer, options = {}) {
        this.scorer = scorer;
        this.warmAfterFirstCall = options.warmAfterFirstCall ?? (scorer.kind === 'clm' || scorer.kind === 'deterministic');
    }
    register(input) {
        if (!input.id.trim())
            throw new Error('candidate set id must be non-empty');
        if (input.candidates.length === 0)
            throw new Error('candidate set must not be empty');
        const entry = {
            id: input.id,
            candidateCount: input.candidates.length,
            candidates: input.candidates.map((c) => ({ ...c })),
            ...(input.context ? { context: { ...input.context } } : {}),
            registeredAt: Date.now(),
            lastUsedAt: null,
            calls: 0,
            warmCalls: 0,
            totalLatencyMs: 0,
            warm: false,
            warmKnown: this.warmAfterFirstCall,
            scorer: this.scorer.name,
            provider: null,
            model: null,
            embeddingReuseRatio: null,
        };
        this.entries.set(input.id, entry);
        return entry;
    }
    registerMany(inputs) {
        return inputs.map((input) => this.register(input));
    }
    list() {
        return [...this.entries.values()].sort((a, b) => a.id.localeCompare(b.id));
    }
    get(id) {
        return this.entries.get(id);
    }
    has(id) {
        return this.entries.has(id);
    }
    /**
     * Rank a state against a registered candidate set. Returns the scorer result
     * plus the cache/warm bookkeeping for this call.
     */
    async scoreState(input) {
        const entry = this.entries.get(input.candidateSetId);
        if (!entry)
            throw new Error(`unknown candidate set: ${input.candidateSetId}`);
        const now = Date.now();
        const cacheAgeMs = entry.lastUsedAt === null ? null : now - entry.lastUsedAt;
        const warmBefore = entry.warm;
        const warmKnownBefore = entry.warmKnown;
        const result = await this.scorer.score({ state: input.state, candidates: entry.candidates, context: { ...(entry.context ?? {}), ...(input.context ?? {}) } });
        entry.calls += 1;
        entry.totalLatencyMs += result.latencyMs ?? 0;
        entry.lastUsedAt = Date.now();
        entry.provider = result.provider ?? entry.provider;
        entry.model = result.model ?? entry.model;
        // Prefer the scorer's own cache report when it provides one; otherwise use
        // first-call bookkeeping (CLM's server caches action projections, so call 2+
        // for the same set is warm).
        const cache = result.cache;
        let reportedWarm = null;
        if (cache) {
            if (typeof cache.actionsCached === 'number')
                reportedWarm = cache.actionsCached >= entry.candidateCount;
            else if (typeof cache.stateCached === 'boolean')
                reportedWarm = cache.stateCached;
        }
        if (reportedWarm === null) {
            entry.warmKnown = this.warmAfterFirstCall;
            entry.warm = this.warmAfterFirstCall ? entry.calls > 1 : false;
        }
        else {
            entry.warmKnown = true;
            entry.warm = reportedWarm;
        }
        // The current call counts as reused when it ran against a warm set.
        if (entry.warm)
            entry.warmCalls += 1;
        entry.embeddingReuseRatio = entry.calls > 0 ? entry.warmCalls / entry.calls : null;
        return {
            result,
            candidateSetId: entry.id,
            candidateCount: entry.candidateCount,
            warm: entry.warm,
            warmKnown: entry.warmKnown,
            cacheAgeMs,
            embeddingReuseRatio: entry.embeddingReuseRatio,
            latencyMs: result.latencyMs,
            scorer: this.scorer.name,
            provider: result.provider ?? null,
            model: result.model ?? null,
        };
    }
    stats(id) {
        const entries = id ? [this.entries.get(id)].filter(Boolean) : this.list();
        return {
            scorer: this.scorer.name,
            sets: entries.map((entry) => ({
                id: entry.id,
                candidateCount: entry.candidateCount,
                warm: entry.warm,
                warmKnown: entry.warmKnown,
                calls: entry.calls,
                warmCalls: entry.warmCalls,
                cacheAgeMs: entry.lastUsedAt === null ? null : Date.now() - entry.lastUsedAt,
                embeddingReuseRatio: entry.embeddingReuseRatio,
                meanLatencyMs: entry.calls > 0 ? entry.totalLatencyMs / entry.calls : null,
                provider: entry.provider,
                model: entry.model,
            })),
        };
    }
}
