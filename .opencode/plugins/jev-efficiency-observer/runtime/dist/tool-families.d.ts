/**
 * Tool taxonomy — a hierarchical layer over the flat ToolRegistry.
 *
 * Motivation (measured): flat lexical ranking confuses near-duplicate tools
 * (`run_tests` / `run_typecheck` / `run_linter`, or `read_files` / `open_file`).
 * Family routing first narrows to the right *kind* of tool, then ranks within
 * the family, which is both cheaper (fewer candidates) and more robust.
 *
 * Non-breaking: `ToolDescriptor.family` is optional. A descriptor without a
 * family is resolved deterministically from its name/tags, and unknown tools
 * fall back to `other`.
 */
import type { ToolDescriptor, ToolFamilyId } from './types.js';
export interface ToolFamily {
    id: ToolFamilyId;
    description: string;
    /** Explicit member tool names. Heuristics handle everything else. */
    members?: string[];
    /** Query words that should strongly select this family. */
    keywords?: string[];
}
export declare const TOOL_FAMILIES: ToolFamily[];
export declare function getToolFamily(id: ToolFamilyId): ToolFamily | undefined;
/** Deterministic family resolution for any descriptor. */
export declare function resolveToolFamily(tool: ToolDescriptor): ToolFamilyId;
/**
 * Intent -> family boosts. A change request must surface the edit family even
 * when the surrounding text is dominated by read/test words (the failure mode
 * observed for T4 type-drift tasks). Deterministic and explainable.
 */
export declare const INTENT_FAMILY_RULES: Array<{
    family: ToolFamilyId;
    test: RegExp;
    boost: number;
}>;
export declare function intentFamilyBoosts(query: string): Map<ToolFamilyId, number>;
export declare function groupByFamily(tools: readonly ToolDescriptor[]): Map<ToolFamilyId, ToolDescriptor[]>;
export type DuplicateStatus = 'representative' | 'suppressed' | 'unique';
export interface NearDuplicateCluster {
    members: string[];
    representative: string;
}
/**
 * Cluster near-duplicate tools. The representative is the member whose
 * signature covers the most of the cluster union (widest capability), with a
 * deterministic tie-break on shorter name then alphabetical.
 */
export declare function clusterNearDuplicates(tools: readonly ToolDescriptor[]): {
    clusters: NearDuplicateCluster[];
    status: Map<string, DuplicateStatus>;
    representativeOf: Map<string, string>;
};
/**
 * Stage-one family ranking: score each family by query overlap with its
 * description, keywords, member names and member descriptors.
 */
export interface FamilyScore {
    id: ToolFamilyId;
    score: number;
    toolCount: number;
    members: ToolDescriptor[];
}
export declare function scoreFamilies(tools: readonly ToolDescriptor[], queryTokens: ReadonlySet<string>, weight: (text: string, w: number) => number): FamilyScore[];
