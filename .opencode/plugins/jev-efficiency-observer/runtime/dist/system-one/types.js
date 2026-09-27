/* ------------------------------------------------------------------ *
 * Shared rendering helpers.
 *
 * CLM/Jev heads are trained on prose, never JSON, so `renderState` emits
 * `key: value`-style lines and candidate descriptions are sent verbatim.
 * ------------------------------------------------------------------ */
const bound = (text, max) => (text.length <= max ? text : `${text.slice(0, max)}\n[... truncated ...]`);
export function renderState(state, maxChars = 1500) {
    if (state.rendered)
        return bound(state.rendered, maxChars);
    const lines = [];
    lines.push(`Goal: ${bound(state.goal, 700)}`);
    const actions = (state.recentActions ?? []).slice(-6);
    if (actions.length > 0) {
        lines.push('Recent actions:');
        for (const action of actions)
            lines.push(`- ${bound(action, 240)}`);
    }
    const results = (state.recentResults ?? []).slice(-4);
    if (results.length > 0) {
        lines.push('Recent results:');
        for (const result of results)
            lines.push(`- ${bound(result, 240)}`);
    }
    if ((state.errors ?? []).length > 0) {
        lines.push('Errors:');
        for (const error of (state.errors ?? []).slice(-3))
            lines.push(`- ${bound(error, 240)}`);
    }
    return bound(lines.join('\n'), maxChars);
}
/** True when the state carries any visual/structured payload a multimodal scorer can use. */
export function hasMedia(state) {
    return (state.images?.length ?? 0) > 0 || (state.video?.length ?? 0) > 0;
}
/** Apply a deterministic candidate filter from the context. */
export function filterCandidates(input) {
    const allowed = input.context?.allowedCandidateIds;
    if (!allowed || allowed.length === 0)
        return input.candidates;
    const set = new Set(allowed);
    return input.candidates.filter((c) => set.has(c.id));
}
/** Attach ranks to a score map, deterministically (score desc, id asc). */
export function rankScores(entries) {
    return entries
        .slice()
        .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
        .map((entry, index) => ({ ...entry, rank: index + 1 }));
}
/** TypeSafe-style confidence: top probability minus the mean of the rest. */
export function distributionConfidence(probabilities) {
    if (probabilities.length < 2)
        return null;
    const total = probabilities.reduce((a, b) => a + b, 0);
    if (!(total > 0))
        return null;
    const normalized = probabilities.map((p) => p / total);
    const max = Math.max(...normalized);
    const rest = normalized.filter((p) => p !== max);
    const meanRest = rest.length > 0 ? rest.reduce((a, b) => a + b, 0) / rest.length : 0;
    return Math.max(0, Math.min(1, max - meanRest));
}
