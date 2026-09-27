import { TOOL_FAMILIES, resolveToolFamily, scoreFamilies } from '../tool-families.js';
export const GATEWAY_TOOL_NAME = 'discover_tools';
export const GATEWAY_TOOL_DESCRIPTION = 'Discover more tools when the preferred tools are not enough. Pass a tool family id (e.g. "git"), a tool name (e.g. "git_diff") or a short query (e.g. "commit changes"). The matching family becomes available on the next turn.';
/** Plan the model-bound tool set for one turn. Pure; canonical tools untouched. */
export function planToolExposure(allTools, state, options = {}) {
    const mode = options.mode ?? 'observe';
    const gatewayName = options.gatewayName ?? GATEWAY_TOOL_NAME;
    const byName = new Set(allTools.map((t) => t.name));
    const preferredPresent = state.preferredTools.filter((n) => byName.has(n));
    if (mode !== 'gateway') {
        return {
            exposed: allTools.map((t) => t.name),
            hidden: [],
            gatewayPresent: false,
            preferredPresent,
            expandedFamilies: [...state.expandedFamilies],
            expandedTools: [...state.expandedTools],
        };
    }
    const exposedSet = new Set(preferredPresent);
    for (const name of state.expandedTools)
        if (byName.has(name))
            exposedSet.add(name);
    for (const tool of allTools) {
        if (!state.expandedFamilies.includes(resolveToolFamily(tool)))
            continue;
        exposedSet.add(tool.name);
    }
    for (const name of options.alwaysExpose ?? [])
        if (byName.has(name))
            exposedSet.add(name);
    if (byName.has(gatewayName))
        exposedSet.add(gatewayName);
    const exposed = [
        ...preferredPresent,
        ...[...exposedSet].filter((n) => !preferredPresent.includes(n) && n !== gatewayName).sort(),
        ...(byName.has(gatewayName) ? [gatewayName] : []),
    ];
    const hidden = allTools.map((t) => t.name).filter((n) => !exposedSet.has(n));
    return {
        exposed,
        hidden,
        gatewayPresent: byName.has(gatewayName),
        preferredPresent,
        expandedFamilies: [...state.expandedFamilies],
        expandedTools: [...state.expandedTools],
    };
}
/**
 * Apply a plan to a tool map for the model-bound request. Returns a new object;
 * the input map is not mutated. Values are the exact canonical descriptors.
 */
export function applyToolExposure(toolMap, plan) {
    const out = {};
    for (const name of plan.exposed) {
        const value = toolMap[name];
        if (value !== undefined)
            out[name] = value;
    }
    return out;
}
const norm = (s) => String(s ?? '').trim().toLowerCase();
/**
 * Expand one family (or one tool) from the canonical registry.
 * Deterministic; never fabricates; unknown requests fail safely.
 */
export function expandToolRequest(allTools, state, request) {
    const requested = String(request.query ?? '').trim();
    const query = norm(requested);
    const byName = new Map(allTools.map((t) => [t.name.toLowerCase(), t]));
    const familyIds = new Set(TOOL_FAMILIES.map((f) => f.id));
    const alreadyFamilies = new Set(state.expandedFamilies);
    const alreadyTools = new Set(state.expandedTools);
    const finish = (families, tools, message, cached) => {
        const nextFamilies = [...new Set([...state.expandedFamilies, ...families])];
        const nextTools = [...new Set([...state.expandedTools, ...tools])];
        return {
            ok: true,
            requested,
            matchedFamilies: families,
            matchedTools: tools,
            message,
            nextState: { ...state, expandedFamilies: nextFamilies, expandedTools: nextTools },
            cached,
        };
    };
    if (query && familyIds.has(query)) {
        const family = query;
        const members = allTools.filter((t) => resolveToolFamily(t) === family).map((t) => t.name).sort();
        if (members.length === 0) {
            return {
                ok: false,
                requested,
                matchedFamilies: [],
                matchedTools: [],
                message: `No tools are registered in family "${family}". Not exposed.`,
                nextState: state,
                cached: false,
            };
        }
        return finish([family], [], `${alreadyFamilies.has(family) ? 'Family already available' : 'Expanded family'}: ${family} -> ${members.join(', ')}.`, alreadyFamilies.has(family));
    }
    if (query && byName.has(query)) {
        const tool = byName.get(query);
        const family = resolveToolFamily(tool);
        const members = allTools.filter((t) => resolveToolFamily(t) === family).map((t) => t.name).sort();
        const cached = alreadyFamilies.has(family) || alreadyTools.has(tool.name);
        return finish([family], [], `${cached ? 'Family already available' : 'Expanded family'} ${family} for requested tool "${tool.name}": ${members.join(', ')}.`, cached);
    }
    if (!requested) {
        return {
            ok: false,
            requested,
            matchedFamilies: [],
            matchedTools: [],
            message: `Provide a family id, a tool name or a query. Families: ${[...familyIds].sort().join(', ')}.`,
            nextState: state,
            cached: false,
        };
    }
    // Lexical query over families (deterministic scoring).
    const tokenSet = new Set(query.split(/[^a-z0-9_]+/).filter((t) => t.length >= 2));
    const scores = scoreFamilies(allTools, tokenSet, (text, w) => {
        let s = 0;
        for (const token of new Set(String(text).toLowerCase().split(/[^a-z0-9_]+/)))
            if (tokenSet.has(token))
                s += w;
        return s;
    }).filter((f) => f.score > 0);
    if (scores.length === 0) {
        return {
            ok: false,
            requested,
            matchedFamilies: [],
            matchedTools: [],
            message: `No family matched "${requested}". Available families: ${[...familyIds].sort().join(', ')}.`,
            nextState: state,
            cached: false,
        };
    }
    const best = scores[0];
    const members = best.members.map((t) => t.name).sort();
    return finish([best.id], [], `${alreadyFamilies.has(best.id) ? 'Family already available' : 'Expanded family'}: ${best.id} -> ${members.join(', ')}.`, alreadyFamilies.has(best.id));
}
/** A compact summary for the session-level observability block. */
export function toolExposureSummary(allTools, state, gate) {
    const plan = planToolExposure(allTools, state, { mode: 'gateway' });
    return {
        registryTools: allTools.length,
        initiallyExposedTools: state.preferredTools.length,
        exposedNow: plan.exposed.length,
        expansions: gate.expansions,
        expansionTurns: gate.expansionTurns,
        schemaTokensFull: gate.schemaTokensFull,
        schemaTokensActuallySent: gate.schemaTokensSent,
        schemaTokensAvoided: gate.schemaTokensFull - gate.schemaTokensSent,
        familiesExpanded: plan.expandedFamilies,
    };
}
