import { hierarchicalShortlist, shortlistTools } from '../tools.js';
import { StructuralTokenEstimator, estimateToolSchemaTokens } from '../tokens.js';
export const DEFAULT_SHORTLIST_POLICY = {
    mode: 'observe',
    hierarchy: true,
    maxFamilies: 3,
    maxTools: 5,
    hardMinRequiredToolRecall: 0.95,
};
export function planShortlist(registry, query, config = {}, estimator = new StructuralTokenEstimator()) {
    const mode = config.mode ?? DEFAULT_SHORTLIST_POLICY.mode;
    const hierarchy = config.hierarchy ?? DEFAULT_SHORTLIST_POLICY.hierarchy;
    const maxFamilies = config.maxFamilies ?? DEFAULT_SHORTLIST_POLICY.maxFamilies;
    const maxTools = config.maxTools ?? DEFAULT_SHORTLIST_POLICY.maxTools;
    const hardFloor = config.hardMinRequiredToolRecall ?? DEFAULT_SHORTLIST_POLICY.hardMinRequiredToolRecall;
    const all = registry.list();
    const schemaTokensBefore = estimateToolSchemaTokens(estimator, all);
    if (mode === 'off') {
        return {
            mode,
            exposed: all,
            proposed: all,
            removed: [],
            fallbackAccess: true,
            families: [],
            candidateCount: all.length,
            schemaTokensBefore,
            schemaTokensAfter: schemaTokensBefore,
            safety: { allowed: true, reason: 'mode=off' },
            reason: 'shortlisting disabled',
        };
    }
    let familyRows = [];
    let candidateCount = all.length;
    let proposed;
    if (hierarchy) {
        const result = hierarchicalShortlist(registry, query, { maxFamilies, maxTools });
        proposed = result.tools;
        familyRows = result.families;
        candidateCount = result.candidateCount;
    }
    else {
        const result = shortlistTools(registry, query, { maxTools });
        proposed = result.tools;
    }
    const proposedNames = new Set(proposed.map((t) => t.name));
    const omitted = all.filter((t) => !proposedNames.has(t.name));
    const schemaTokensAfter = estimateToolSchemaTokens(estimator, proposed);
    // HARD safety gate.
    const measured = config.measuredRequiredToolRecall ?? null;
    const safety = mode === 'hard'
        ? measured === null
            ? { allowed: false, reason: 'HARD blocked: no measured required-tool recall configured (null is not 0)' }
            : measured >= hardFloor
                ? { allowed: true, reason: `HARD allowed: measured recall ${measured} >= ${hardFloor}` }
                : { allowed: false, reason: `HARD blocked: measured recall ${measured} < ${hardFloor}` }
        : { allowed: true, reason: `mode=${mode}` };
    const effectiveMode = mode === 'hard' && !safety.allowed ? 'soft' : mode;
    const exposed = effectiveMode === 'soft' || effectiveMode === 'hard' ? proposed : all;
    const removed = effectiveMode === 'hard' ? omitted : [];
    const fallbackAccess = effectiveMode !== 'hard';
    return {
        mode: effectiveMode,
        exposed,
        proposed,
        removed,
        fallbackAccess,
        families: familyRows,
        candidateCount,
        schemaTokensBefore,
        schemaTokensAfter,
        safety,
        reason: effectiveMode === 'observe'
            ? `observe: proposed ${proposed.length}/${all.length} tools (${new Set(familyRows.map((f) => f.id)).size} families); exposing all`
            : effectiveMode === 'soft'
                ? `soft: exposing ${proposed.length}/${all.length} prominently with fallback access`
                : `hard: exposing ${proposed.length}/${all.length}, removed ${removed.length}`,
    };
}
