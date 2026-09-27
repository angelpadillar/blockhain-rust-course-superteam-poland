/**
 * ToolDescriptor / ToolRegistry / ToolShortlister — provider-neutral tool
 * catalog plus a cheap, deterministic router that narrows a large tool list to
 * a small relevant subset before the model sees it.
 *
 * Shortlisting is lexical and model-free on purpose: it is the cheap first
 * stage, not a substitute for the model's own choice.
 */
import type { ToolDescriptor, ToolFamilyId } from './types.js';
import { type DuplicateStatus } from './tool-families.js';
export declare class ToolRegistry {
    private readonly map;
    register(tool: ToolDescriptor): this;
    registerMany(tools: readonly ToolDescriptor[]): this;
    get(name: string): ToolDescriptor | undefined;
    has(name: string): boolean;
    list(): ToolDescriptor[];
    names(): string[];
}
export declare function createToolRegistry(tools?: readonly ToolDescriptor[]): ToolRegistry;
export declare function tokenize(text: string): string[];
export interface ShortlistOptions {
    maxTools?: number;
    /** Always keep tools flagged `alwaysInclude` even if over budget. */
    keepAlwaysInclude?: boolean;
}
export interface ShortlistResult {
    tools: ToolDescriptor[];
    scores: Array<{
        name: string;
        score: number;
    }>;
    reason: string;
}
export declare function shortlistTools(registry: ToolRegistry, query: string, options?: ShortlistOptions): ShortlistResult;
/** Lexical score of one tool against a query token set. Deterministic. */
export declare function scoreToolLexical(tool: ToolDescriptor, tokenSet: ReadonlySet<string>): number;
export interface HierarchicalShortlistOptions {
    /** Stage one: how many families to keep. */
    maxFamilies?: number;
    /** Stage two: how many tools to return. */
    maxTools?: number;
    /** Stage two: at most this many tools from one family before others get a turn. */
    perFamilyCap?: number;
}
export interface HierarchicalShortlistResult {
    families: Array<{
        id: ToolFamilyId;
        score: number;
        toolCount: number;
        taken: number;
    }>;
    tools: ToolDescriptor[];
    scores: Array<{
        name: string;
        score: number;
        family: ToolFamilyId;
        duplicateStatus?: DuplicateStatus;
        representativeOf?: string;
    }>;
    candidateCount: number;
    reason: string;
}
/**
 * Two-stage selection: rank tool families from the whole registry, then rank
 * tools only inside the selected families. Selection is **family-balanced round
 * robin** (at most `perFamilyCap` per family before others get a turn), so a
 * cluster of near-duplicate tools cannot flood the shortlist; always-include
 * tools are kept first.
 */
export declare function hierarchicalShortlist(registry: ToolRegistry, query: string, options?: HierarchicalShortlistOptions): HierarchicalShortlistResult;
