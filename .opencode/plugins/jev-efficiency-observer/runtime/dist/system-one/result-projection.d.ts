/**
 * Model-bound result projection.
 *
 * Applies `ResultAdmissionPolicy` to the *outgoing* message projection only:
 * the caller's message objects are never mutated, and persisted/canonical
 * history is never touched. Unknown, error and non-text results pass through
 * unchanged.
 *
 * The traversal is structural and provider-agnostic: it recognises the
 * `{ type: "tool-result", name, result }` part shape used by OpenCode's message
 * schema (and ignores anything it does not recognise).
 */
import type { EvidencePointer, ResultClass } from '../types.js';
import type { TokenEstimator } from '../tokens.js';
import type { ResultAdmissionPolicy } from '../admission.js';
/** Text of a tool result value, or null when it is not safely reducible text. */
export declare function toolResultText(result: unknown): string | null;
export interface ProjectionRecord {
    messageIndex: number;
    partIndex: number;
    toolName: string;
    resultType: 'text' | 'content';
    rawTokens: number;
    projectedTokens: number;
    tokensAvoided: number;
    classification: ResultClass | null;
    strategy: string | null;
    evidencePointer: EvidencePointer | null;
    evidenceRecoveryExact: boolean | null;
    rawSha256: string;
}
export interface ProjectionResult {
    /** New message array; unchanged entries are the original references. */
    messages: unknown[];
    records: ProjectionRecord[];
    rawTokens: number;
    projectedTokens: number;
    tokensAvoided: number;
}
export interface FailOpenProjectionResult extends ProjectionResult {
    /** True when the projection was abandoned and the original messages are returned. */
    fellBack: boolean;
    fallbackReason: string | null;
}
export interface ProjectionOptions {
    policy: ResultAdmissionPolicy;
    estimator: TokenEstimator;
    /** Recover the exact original for the evidence round-trip check. */
    recover: (evidenceId: string) => string | undefined;
    /** Extra guard: only these classes may be projected. Defaults to all policy-eligible classes. */
    allowedClasses?: ResultClass[];
}
/**
 * Project a message array: returns new messages plus per-result records.
 * Never mutates `messages`.
 */
export declare function projectToolResults(messages: unknown[], options: ProjectionOptions): ProjectionResult;
/**
 * Fail-open wrapper for production: any classifier/reducer/evidence error, or a
 * projection that fails validation, returns the ORIGINAL messages with no
 * records, so the coding agent always keeps working and the model sees the
 * canonical result.
 */
export declare function projectToolResultsFailOpen(messages: unknown[], options: ProjectionOptions): FailOpenProjectionResult;
