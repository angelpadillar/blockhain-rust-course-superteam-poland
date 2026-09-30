const tokens = (text) => new Set(text
    .toLowerCase()
    .split(/[^a-z0-9_]+/)
    .filter((t) => t.length >= 3));
export class DeterministicMemoryProvider {
    episodes;
    constructor(episodes = []) {
        this.episodes = episodes;
    }
    async retrieve(query) {
        const k = query.k ?? 3;
        const pool = query.candidates ?? this.episodes;
        const queryText = `${query.state.goal} ${(query.state.errors ?? []).join(' ')} ${(query.state.recentActions ?? []).join(' ')}`;
        const queryTokens = tokens(queryText);
        return pool
            .map((episode) => {
            const episodeTokens = tokens(`${episode.summary} ${(episode.tags ?? []).join(' ')}`);
            let score = 0;
            for (const token of episodeTokens)
                if (queryTokens.has(token))
                    score += 1;
            if (episode.outcome === 'success')
                score += 0.5;
            return { episode, score };
        })
            .sort((a, b) => b.score - a.score || a.episode.id.localeCompare(b.episode.id))
            .slice(0, k)
            .map((entry) => entry.episode);
    }
}
export function episodesToCandidates(episodes) {
    return episodes.map((episode) => ({
        id: episode.id,
        description: episode.summary,
        tags: episode.tags,
        risk: episode.outcome === 'failure' ? 'medium' : 'low',
    }));
}
/** Rank memory episodes with any SystemOneScorer, preserving the scorer's audit. */
export async function rankMemoryWithScorer(scorer, episodes, state, k = 3) {
    const candidates = episodesToCandidates(episodes);
    const input = {
        state,
        candidates,
        context: { decisionType: 'memory', instructions: 'Which of these past episodes is most relevant to the current state?' },
    };
    const scoring = await scorer.score(input);
    const byId = new Map(episodes.map((e) => [e.id, e]));
    const ordered = scoring.ranked
        .map((entry) => byId.get(entry.id))
        .filter((e) => Boolean(e))
        .slice(0, k);
    return { episodes: ordered, scoring };
}
/** Compare a ranked list against a set of required episode ids. */
export function memoryMetrics(ranked, requiredIds, tokenEstimate) {
    if (requiredIds.length === 0)
        return { recallAt1: null, recallAt3: null, irrelevantInjected: null, finalContextTokens: null };
    const top1 = ranked.slice(0, 1).map((e) => e.id);
    const top3 = ranked.slice(0, 3).map((e) => e.id);
    const required = new Set(requiredIds);
    const hit = (ids) => (ids.some((id) => required.has(id)) ? 1 : 0);
    const irrelevant = ranked.filter((e) => !required.has(e.id)).length;
    return {
        recallAt1: hit(top1),
        recallAt3: hit(top3),
        irrelevantInjected: irrelevant,
        finalContextTokens: ranked.reduce((acc, e) => acc + tokenEstimate(e.summary), 0),
    };
}
