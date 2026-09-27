import { filterCandidates, rankScores, renderState } from './types.js';
const STOP = new Set([
    'a', 'an', 'the', 'and', 'or', 'of', 'to', 'in', 'on', 'for', 'with', 'is', 'are', 'be', 'do', 'does',
    'it', 'this', 'that', 'as', 'at', 'by', 'from', 'we', 'i', 'you', 'please', 'can', 'should', 'will',
]);
function tokens(text) {
    return text
        .toLowerCase()
        .split(/[^a-z0-9_]+/)
        .filter((t) => t.length >= 2 && !STOP.has(t));
}
function overlap(query, text, weight) {
    let score = 0;
    for (const token of new Set(tokens(text)))
        if (query.has(token))
            score += weight;
    return score;
}
function heuristicBoost(queryText, candidate) {
    const text = `${candidate.id} ${candidate.toolName ?? ''} ${candidate.description} ${(candidate.tags ?? []).join(' ')}`.toLowerCase();
    let boost = 0;
    if (/\b(test|spec|vitest|verify|failing|failed)\b/.test(queryText)) {
        if (/(run|test|vitest|shell|command|verify)/.test(text))
            boost += 2.5;
    }
    if (/(not found|missing|enoent|cannot find|no such file)/.test(queryText)) {
        if (/(read|file|search|grep|glob|list)/.test(text))
            boost += 2.5;
    }
    if (/(edit|fix|correct|implement|change|patch|write|add)\b/.test(queryText)) {
        if (/(write|edit|replace|patch|apply|file)/.test(text))
            boost += 1.5;
    }
    if (/(error|traceback|exception|type error|tsc)/.test(queryText)) {
        if (/(typecheck|build|compile|diagnos)/.test(text))
            boost += 1.25;
    }
    if (candidate.risk === 'high')
        boost -= 0.5;
    return boost;
}
export class DeterministicScorer {
    options;
    name = 'deterministic';
    kind = 'deterministic';
    constructor(options = {}) {
        this.options = options;
    }
    async score(input) {
        const started = Date.now();
        const candidates = filterCandidates(input);
        const stateText = renderState(input.state);
        const queryText = `${stateText} ${input.context?.instructions ?? ''}`.toLowerCase();
        const query = new Set(tokens(queryText));
        const idWeight = this.options.idWeight ?? 4;
        const tagWeight = this.options.tagWeight ?? 2;
        const descriptionWeight = this.options.descriptionWeight ?? 1.5;
        const raw = candidates.map((candidate) => {
            let score = 0;
            const idText = `${candidate.id} ${candidate.toolName ?? ''}`;
            if (query.has((candidate.toolName ?? candidate.id).toLowerCase()))
                score += idWeight + 1;
            score += overlap(query, idText, idWeight);
            score += overlap(query, (candidate.tags ?? []).join(' '), tagWeight);
            score += overlap(query, candidate.description, descriptionWeight);
            score += heuristicBoost(queryText, candidate);
            return { candidate, score };
        });
        const total = raw.reduce((a, r) => a + Math.max(0, r.score), 0);
        const entries = raw.map((r) => ({
            id: r.candidate.id,
            score: Number(r.score.toFixed(6)),
            probability: total > 0 ? Number((Math.max(0, r.score) / total).toFixed(6)) : null,
        }));
        const ranked = rankScores(entries);
        return {
            scorer: this.name,
            provider: 'local',
            model: 'deterministic-lexical-v1',
            ranked,
            confidence: ranked.length > 1 && ranked[0].score > 0 ? Number(((ranked[0].score - ranked[1].score) / (Math.abs(ranked[0].score) + 1e-9)).toFixed(6)) : null,
            latencyMs: Date.now() - started,
            usage: { inputTokens: null, outputTokens: null, billingUnits: 0 },
            cost: { usd: 0, source: 'local-deterministic' },
            audit: { candidates: candidates.length, queryTokens: query.size, stateChars: stateText.length },
        };
    }
}
