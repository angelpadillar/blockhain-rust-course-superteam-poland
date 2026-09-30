/**
 * Adapters — thin, dependency-free bridges between concrete agent factories and
 * the runtime's `ToolResult` contract.
 *
 * Each adapter does exactly one job: turn a provider-shaped result into the
 * neutral shape. No adapter imports the provider's SDK.
 */
import type { ToolDescriptor, ToolResult, ToolResultKind } from './types.js';
/** Best-effort structural kind from a tool name (adapters may override). */
export declare function inferToolKind(toolName: string): ToolResultKind;
/** Normalise the many Cline/OpenAI content shapes into one text payload. */
export declare function contentToText(content: unknown): string;
export interface ClineToolResultInput {
    toolName: string;
    content: unknown;
    isError?: boolean;
    id?: string;
    kind?: ToolResultKind;
}
export declare function clineToolResult(input: ClineToolResultInput): ToolResult;
export interface OpenAIFunctionTool {
    type: 'function';
    function: {
        name: string;
        description: string;
        parameters: Record<string, unknown>;
    };
}
export declare function openAIToolSchemas(tools: readonly ToolDescriptor[]): OpenAIFunctionTool[];
export interface OpenAIToolResultInput {
    toolCallId: string;
    name: string;
    content: unknown;
    kind?: ToolResultKind;
}
export declare function openAIToolResult(input: OpenAIToolResultInput): ToolResult;
export type BrowserObservationKind = 'screenshot' | 'dom' | 'console' | 'html' | 'url';
export interface BrowserObservationInput {
    kind: BrowserObservationKind;
    text: string;
    url?: string;
    isError?: boolean;
}
export declare function browserObservation(input: BrowserObservationInput): ToolResult;
