/**
 * Shared contracts for the provider-agnostic Agent Efficiency Runtime.
 *
 * Nothing in this package imports Kanban, Cline, Fireworks, LangChain or any
 * network SDK. Providers and agent factories integrate through the small
 * adapter surface in `adapters.ts` plus the interfaces here.
 */
/** How a tool result should be treated structurally (not which tool produced it). */
export type ToolResultKind = 'file-read' | 'shell' | 'search' | 'json' | 'browser' | 'image' | 'text' | 'unknown';
export type JsonSchema = Record<string, unknown>;
/** Family ids for hierarchical tool routing. Defined here so ToolDescriptor can
 *  carry an optional family without a circular import. */
export type ToolFamilyId = 'file_read' | 'file_search' | 'code_edit' | 'code_validation' | 'shell' | 'git' | 'browser_observation' | 'browser_navigation' | 'browser_interaction' | 'memory' | 'mcp_external' | 'human_escalation' | 'task_control' | 'other';
/** A tool the agent can call. Provider-neutral. */
export interface ToolDescriptor {
    /** Stable function name the model sees. */
    name: string;
    description: string;
    /** Structural kind of the result this tool yields. */
    kind: ToolResultKind;
    /** Free-form tags used by the shortlister (e.g. `filesystem`, `web`, `code`). */
    tags: string[];
    /** Optional hierarchical family for two-stage routing. */
    family?: ToolFamilyId;
    /** Optional JSON schema for the tool input (OpenAI-compatible by convention). */
    inputSchema?: JsonSchema;
    /** Never shortlisted away (e.g. a safety/stop tool). */
    alwaysInclude?: boolean;
    /** Relative token weight of a typical call; used for budgeted shortlisting. */
    costHint?: number;
    risk?: 'low' | 'medium' | 'high';
}
/** A concrete tool result an agent received, reduced to the fields we reason over. */
export interface ToolResult {
    toolName: string;
    /** Optional structural hint from the adapter; the classifier may refine it. */
    kind?: ToolResultKind;
    /** The exact text payload the model would otherwise see. */
    text: string;
    /** Adapter/provider correlation id (opaque to the core). */
    id?: string;
    isError?: boolean;
    metadata?: Record<string, unknown>;
}
/** The finite set of result classes the default reducer registry understands. */
export type ResultClass = 'long-file-read' | 'shell-build-log' | 'test-failure' | 'search-results' | 'large-json';
export interface Classification {
    resultClass: ResultClass | null;
    /** 0..1; deterministic, not model-derived. */
    confidence: number;
    reasons: string[];
}
/** Exact, recoverable reference to the original (pre-reduction) result. */
export interface EvidencePointer {
    /** sha256 hex of the exact original UTF-8 bytes. */
    evidenceId: string;
    toolName: string;
    resultClass: ResultClass | null;
    byteLength: number;
    tokenEstimate: number;
    locator: EvidenceLocator;
}
export interface EvidenceLocator {
    kind: 'full-result';
    strategy: string | null;
    /** Line numbers (0-based) the admitted text preserved verbatim, when known. */
    preservedLines?: number[];
}
export interface EvidenceRecord extends EvidencePointer {
    /** The exact original text. Recoverable byte-for-byte. */
    text: string;
    createdAt: number;
}
export type AdmissionAction = 'keep' | 'reduce';
export interface AdmissionDecision {
    action: AdmissionAction;
    toolName: string;
    resultClass: ResultClass | null;
    /** The text the model should see (original when action === 'keep'). */
    text: string;
    originalTokenEstimate: number;
    admittedTokenEstimate: number;
    tokensAvoided: number;
    strategy: string | null;
    /** Present iff a reduction was admitted under requireExactEvidence. */
    evidence: EvidencePointer | null;
    reason: string;
}
export interface PricingTable {
    mainModel: string;
    uncachedInputPerM: number;
    cachedInputPerM: number;
    outputPerM: number;
    jevInputPerM?: number | null;
    jevOutputPerM?: number | null;
}
export interface TokenUsage {
    uncachedInput: number;
    cachedInput: number;
    output: number;
}
