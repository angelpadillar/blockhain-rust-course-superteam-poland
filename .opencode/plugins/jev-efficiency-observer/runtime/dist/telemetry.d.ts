/**
 * Telemetry contracts — a tiny, provider-neutral event surface so any harness
 * (Cline, an OpenAI-compatible agent, LangGraph, a browser agent) can record
 * what the runtime decided without depending on a specific metrics backend.
 */
import type { AdmissionAction, ResultClass } from './types.js';
export interface TelemetryEventBase {
    at: number;
    runId?: string;
}
export type TelemetryEvent = (TelemetryEventBase & {
    type: 'admission_decision';
    toolName: string;
    resultClass: ResultClass | null;
    action: AdmissionAction;
    reason: string;
    originalTokens: number;
    admittedTokens: number;
}) | (TelemetryEventBase & {
    type: 'reduction_applied';
    toolName: string;
    resultClass: ResultClass;
    strategy: string;
    tokensAvoided: number;
    exact: boolean;
}) | (TelemetryEventBase & {
    type: 'evidence_stored';
    toolName: string;
    resultClass: ResultClass | null;
    evidenceId: string;
    byteLength: number;
}) | (TelemetryEventBase & {
    type: 'shortlist_computed';
    query: string;
    selected: string[];
    reason: string;
}) | (TelemetryEventBase & {
    type: 'economics_evaluated';
    tokensAvoided: number;
    usdAvoided: number | null;
});
export interface TelemetrySink {
    emit(event: TelemetryEvent): void;
}
export declare class InMemoryTelemetrySink implements TelemetrySink {
    private readonly runId?;
    readonly events: TelemetryEvent[];
    constructor(runId?: string | undefined);
    emit(event: TelemetryEvent): void;
    drain(): TelemetryEvent[];
    count(type?: TelemetryEvent['type']): number;
}
export declare class NoopTelemetrySink implements TelemetrySink {
    emit(): void;
}
