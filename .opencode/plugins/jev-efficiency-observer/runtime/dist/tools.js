import { clusterNearDuplicates, intentFamilyBoosts, resolveToolFamily, scoreFamilies } from './tool-families.js';
export class ToolRegistry {
    map = new Map();
    register(tool) {
        if (!tool.name.trim())
            throw new Error('tool name must be non-empty');
        this.map.set(tool.name, { ...tool, tags: [...tool.tags] });
        return this;
    }
    registerMany(tools) {
        for (const tool of tools)
            this.register(tool);
        return this;
    }
    get(name) {
        return this.map.get(name);
    }
    has(name) {
        return this.map.has(name);
    }
    list() {
        return [...this.map.values()].sort((a, b) => a.name.localeCompare(b.name));
    }
    names() {
        return this.list().map((t) => t.name);
    }
}
export function createToolRegistry(tools = []) {
    return new ToolRegistry().registerMany(tools);
}
const STOPWORDS = new Set([
    'a', 'an', 'the', 'and', 'or', 'of', 'to', 'in', 'on', 'for', 'with', 'please', 'help',
    'me', 'my', 'i', 'we', 'you', 'it', 'this', 'that', 'is', 'are', 'be', 'can', 'do', 'how',
]);
export function tokenize(text) {
    return text
        .toLowerCase()
        .split(/[^a-z0-9_]+/)
        .filter((t) => t.length >= 2 && !STOPWORDS.has(t));
}
export function shortlistTools(registry, query, options = {}) {
    const maxTools = options.maxTools ?? 8;
    const keepAlwaysInclude = options.keepAlwaysInclude ?? true;
    const tokens = tokenize(query);
    const tokenSet = new Set(tokens);
    const scored = registry.list().map((tool) => ({ tool, score: scoreToolLexical(tool, tokenSet) }));
    const ranked = scored
        .slice()
        .sort((a, b) => b.score - a.score || a.tool.name.localeCompare(b.tool.name));
    const always = ranked.filter((s) => s.tool.alwaysInclude === true);
    const rest = ranked.filter((s) => s.tool.alwaysInclude !== true);
    const selected = [];
    for (const s of always)
        selected.push(s);
    for (const s of rest) {
        if (selected.length >= maxTools && !(keepAlwaysInclude && s.tool.alwaysInclude))
            break;
        selected.push(s);
        if (selected.length >= maxTools)
            break;
    }
    return {
        tools: selected.map((s) => s.tool),
        scores: selected.map((s) => ({ name: s.tool.name, score: s.score })),
        reason: `lexical shortlist: ${selected.length}/${registry.names().length} tools, ${tokens.length} query token(s)`,
    };
}
/** Lexical score of one tool against a query token set. Deterministic. */
export function scoreToolLexical(tool, tokenSet) {
    let score = 0;
    const name = tool.name.toLowerCase();
    const description = tool.description.toLowerCase();
    const tags = (tool.tags ?? []).map((t) => t.toLowerCase());
    for (const token of tokenSet) {
        if (name === token)
            score += 4;
        else if (name.includes(token))
            score += 2;
        if (tags.includes(token))
            score += 3;
        else if (tags.some((tag) => tag.includes(token)))
            score += 1;
        if (description.includes(token))
            score += 1;
    }
    if (tool.alwaysInclude)
        score += 100;
    return score;
}
/**
 * Two-stage selection: rank tool families from the whole registry, then rank
 * tools only inside the selected families. Selection is **family-balanced round
 * robin** (at most `perFamilyCap` per family before others get a turn), so a
 * cluster of near-duplicate tools cannot flood the shortlist; always-include
 * tools are kept first.
 */
export function hierarchicalShortlist(registry, query, options = {}) {
    const maxFamilies = options.maxFamilies ?? 3;
    const maxTools = options.maxTools ?? 8;
    const perFamilyCap = options.perFamilyCap ?? 2;
    const tokens = tokenize(query);
    const tokenSet = new Set(tokens);
    const weight = (text, w) => {
        let score = 0;
        for (const token of new Set(tokenize(text)))
            if (tokenSet.has(token))
                score += w;
        return score;
    };
    const all = registry.list();
    const boosts = intentFamilyBoosts(query);
    const familyScores = scoreFamilies(all, tokenSet, weight)
        .map((f) => ({ ...f, score: Number((f.score + (boosts.get(f.id) ?? 0)).toFixed(3)) }))
        .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
    const duplicates = clusterNearDuplicates(all);
    const duplicateBoost = (name) => {
        const status = duplicates.status.get(name);
        return status === 'representative' ? 3 : status === 'suppressed' ? -3 : 0;
    };
    // Always-include tools pull their family in.
    const forcedFamilies = new Set();
    for (const tool of all)
        if (tool.alwaysInclude)
            forcedFamilies.add(resolveToolFamily(tool));
    const selectedFamilies = familyScores
        .filter((f) => forcedFamilies.has(f.id) || f.score > 0)
        .slice(0, Math.max(maxFamilies, forcedFamilies.size));
    const selectedIds = new Set(selectedFamilies.map((f) => f.id));
    const rankedByFamily = selectedFamilies.map((family) => ({
        id: family.id,
        tools: family.members
            .map((tool) => ({ tool, score: scoreToolLexical(tool, tokenSet) + duplicateBoost(tool.name) }))
            .sort((a, b) => b.score - a.score || a.tool.name.localeCompare(b.tool.name)),
    }));
    const selected = [];
    const chosen = new Set();
    const take = (tool, score, family) => {
        if (chosen.has(tool.name) || selected.length >= maxTools)
            return;
        chosen.add(tool.name);
        selected.push({ tool, score, family });
    };
    // Always-include tools first.
    for (const family of rankedByFamily) {
        for (const row of family.tools)
            if (row.tool.alwaysInclude)
                take(row.tool, row.score, family.id);
    }
    // Family-balanced round robin.
    for (let round = 0; round < perFamilyCap; round += 1) {
        for (const family of rankedByFamily) {
            if (selected.length >= maxTools)
                break;
            const row = family.tools[round];
            if (row)
                take(row.tool, row.score, family.id);
        }
    }
    // Fill any remaining budget by raw score across selected families.
    const leftovers = rankedByFamily
        .flatMap((family) => family.tools.map((row) => ({ ...row, family: family.id })))
        .filter((row) => !chosen.has(row.tool.name))
        .sort((a, b) => b.score - a.score || a.tool.name.localeCompare(b.tool.name));
    for (const row of leftovers) {
        if (selected.length >= maxTools)
            break;
        take(row.tool, row.score, row.family);
    }
    return {
        families: familyScores
            .filter((f) => selectedIds.has(f.id))
            .map((f) => ({
            id: f.id,
            score: Number(f.score.toFixed(3)),
            toolCount: f.toolCount,
            taken: selected.filter((s) => s.family === f.id).length,
        })),
        tools: selected.map((s) => s.tool),
        scores: selected.map((s) => ({
            name: s.tool.name,
            score: s.score,
            family: s.family,
            duplicateStatus: duplicates.status.get(s.tool.name) ?? 'unique',
            representativeOf: duplicates.representativeOf.get(s.tool.name),
        })),
        candidateCount: rankedByFamily.reduce((acc, f) => acc + f.tools.length, 0),
        reason: `hierarchical shortlist: ${selectedFamilies.length} families -> ${selected.length}/${all.length} tools (round-robin cap ${perFamilyCap}, ${duplicates.clusters.length} near-duplicate cluster(s))`,
    };
}
