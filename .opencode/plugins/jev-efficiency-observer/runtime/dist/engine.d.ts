/**
 * AgentEfficiencyRuntime — the composition root.
 *
 * Wires the classifier, reducer registry, admission policy, evidence store,
 * economics, tool registry and telemetry into one object with three verbs:
 *
 *   processToolResult(result)  -> admit / reduce, with exact-evidence pointer
 *   shortlistTools(query)      -> cheap, deterministic tool routing
 *   recoverEvidence(id)        -> exact original result, byte-for-byte
 *
 * It has no Kanban/Cline/provider dependency. Adapters bridge concrete agent
 * factories to it.
 */
import type { AdmissionDecision, PricingTable, ToolDescriptor, ToolResult } from './types.js';
import { type TokenEstimator } from './tokens.js';
import { ToolResultClassifier, type ClassificationRule } from './classifier.js';
import { type DeterministicReducer, type ReducerRegistry } from './reducers.js';
import { type EvidenceStore } from './evidence.js';
import { EconomicsPolicy } from './economics.js';
import { ResultAdmissionPolicy, type AdmissionPolicyConfig } from './admission.js';
import { ToolRegistry, type ShortlistOptions, type ShortlistResult } from './tools.js';
import { type TelemetrySink } from './telemetry.js';
export interface RuntimeOptions {
    estimator?: TokenEstimator;
    classifier?: ToolResultClassifier;
    classifierRules?: ClassificationRule[];
    reducers?: ReducerRegistry;
    additionalReducers?: DeterministicReducer[];
    admissionConfig?: Partial<AdmissionPolicyConfig>;
    pricing?: PricingTable;
    evidence?: EvidenceStore;
    telemetry?: TelemetrySink;
    tools?: readonly ToolDescriptor[];
    runId?: string;
}
export declare class AgentEfficiencyRuntime {
    readonly estimator: TokenEstimator;
    readonly classifier: ToolResultClassifier;
    readonly reducers: ReducerRegistry;
    readonly evidence: EvidenceStore;
    readonly economics: EconomicsPolicy;
    readonly telemetry: TelemetrySink;
    readonly policy: ResultAdmissionPolicy;
    readonly tools: ToolRegistry;
    constructor(options?: RuntimeOptions);
    registerTool(tool: ToolDescriptor): this;
    registerTools(tools: readonly ToolDescriptor[]): this;
    /** Classify + admit/reduce a single tool result. */
    processToolResult(result: ToolResult): AdmissionDecision;
    shortlist(query: string, options?: ShortlistOptions): ShortlistResult;
    /** Recover the exact original text behind a reduction, verbatim. */
    recoverEvidence(evidenceId: string): string | undefined;
}
