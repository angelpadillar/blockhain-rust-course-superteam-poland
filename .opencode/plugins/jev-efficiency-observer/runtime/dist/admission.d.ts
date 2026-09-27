/**
 * ResultAdmissionPolicy — decides whether a tool result may be reduced, and if
 * so produces the admitted text plus an exact-evidence pointer.
 *
 * The policy is deterministic and composes the classifier, reducer registry,
 * token estimator, evidence store and economics policy. It is the single place
 * where the "admit vs keep" economics live.
 */
import type { AdmissionDecision, ResultClass, ToolResult } from './types.js';
import { ToolResultClassifier } from './classifier.js';
import { ReducerRegistry } from './reducers.js';
import type { EvidenceStore } from './evidence.js';
import type { TokenEstimator } from './tokens.js';
import type { EconomicsPolicy } from './economics.js';
import type { TelemetrySink } from './telemetry.js';
export interface AdmissionPolicyConfig {
    /** Results at or above this structural token estimate are candidates. */
    thresholdTokens: number;
    eligibleClasses: ResultClass[];
    /** Persist an exact-evidence pointer for every admitted reduction. */
    requireExactEvidence: boolean;
    /** Only admit when the admitted estimate is strictly smaller. */
    requireNetSaving: boolean;
}
export declare const DEFAULT_ADMISSION_CONFIG: AdmissionPolicyConfig;
export interface AdmissionDependencies {
    classifier?: ToolResultClassifier;
    reducers: ReducerRegistry;
    estimator: TokenEstimator;
    evidence: EvidenceStore;
    economics?: EconomicsPolicy;
    telemetry?: TelemetrySink;
}
export declare class ResultAdmissionPolicy {
    private readonly config;
    private readonly classifier;
    private readonly reducers;
    private readonly estimator;
    private readonly evidence;
    private readonly economics;
    private readonly telemetry;
    constructor(config: AdmissionPolicyConfig | undefined, deps: AdmissionDependencies);
    private keep;
    evaluate(result: ToolResult): AdmissionDecision;
}
