/**
 * Lazy tool exposure / tool gateway — fallback-preserving schema reduction.
 *
 * SOFT shortlisting only *prefers* tools; every schema is still transmitted.
 * The gateway goes further: the model-bound request carries the preferred tools
 * plus ONE gateway tool (`discover_tools`). Any other tool stays reachable in
 * the canonical registry and can be exposed by calling the gateway, which
 * expands a single tool family at a time.
 *
 * Hard invariant: the gateway never fabricates a tool and never mutates the
 * registry. Every expansion is deterministic, cached per session, and the
 * exposed schemas are the exact canonical descriptors.
 */
import type { ToolDescriptor, ToolFamilyId } from '../types.js';
export type ToolExposureMode = 'off' | 'observe' | 'gateway';
export declare const GATEWAY_TOOL_NAME = "discover_tools";
export declare const GATEWAY_TOOL_DESCRIPTION = "Discover more tools when the preferred tools are not enough. Pass a tool family id (e.g. \"git\"), a tool name (e.g. \"git_diff\") or a short query (e.g. \"commit changes\"). The matching family becomes available on the next turn.";
export interface GatewayState {
    /** Preferred tools exposed from the start (deterministic order). */
    preferredTools: string[];
    /** Families already expanded in this session. */
    expandedFamilies: ToolFamilyId[];
    /** Individual tools added by name (always a subset of the registry). */
    expandedTools: string[];
}
export interface ToolExposurePlan {
    /** Tool names to send to the model, in order. */
    exposed: string[];
    /** Tool names omitted from this request (still canonical). */
    hidden: string[];
    gatewayPresent: boolean;
    /** Preferred tools that actually exist in the registry. */
    preferredPresent: string[];
    expandedFamilies: ToolFamilyId[];
    expandedTools: string[];
}
export interface ToolExposureOptions {
    mode?: ToolExposureMode;
    gatewayName?: string;
    /** Always keep these tools (e.g. the gateway itself, safety tools). */
    alwaysExpose?: string[];
}
/** Plan the model-bound tool set for one turn. Pure; canonical tools untouched. */
export declare function planToolExposure(allTools: readonly ToolDescriptor[], state: GatewayState, options?: ToolExposureOptions): ToolExposurePlan;
/**
 * Apply a plan to a tool map for the model-bound request. Returns a new object;
 * the input map is not mutated. Values are the exact canonical descriptors.
 */
export declare function applyToolExposure<T>(toolMap: Record<string, T>, plan: ToolExposurePlan): Record<string, T>;
export interface ExpansionRequest {
    /** The raw argument the model passed (family id, tool name, or query). */
    query?: string;
}
export interface ExpansionResult {
    ok: boolean;
    requested: string;
    matchedFamilies: ToolFamilyId[];
    matchedTools: string[];
    message: string;
    nextState: GatewayState;
    /** True when nothing changed because the family was already expanded. */
    cached: boolean;
}
/**
 * Expand one family (or one tool) from the canonical registry.
 * Deterministic; never fabricates; unknown requests fail safely.
 */
export declare function expandToolRequest(allTools: readonly ToolDescriptor[], state: GatewayState, request: ExpansionRequest): ExpansionResult;
/** A compact summary for the session-level observability block. */
export declare function toolExposureSummary(allTools: readonly ToolDescriptor[], state: GatewayState, gate: {
    expansions: number;
    expansionTurns: number;
    schemaTokensFull: number;
    schemaTokensSent: number;
}): Record<string, unknown>;
