import { ToolResultClassifier } from './classifier.js';
import { NoopTelemetrySink } from './telemetry.js';
export const DEFAULT_ADMISSION_CONFIG = {
    thresholdTokens: 1000,
    eligibleClasses: ['long-file-read', 'shell-build-log', 'test-failure', 'search-results', 'large-json'],
    requireExactEvidence: true,
    requireNetSaving: true,
};
export class ResultAdmissionPolicy {
    config;
    classifier;
    reducers;
    estimator;
    evidence;
    economics;
    telemetry;
    constructor(config = DEFAULT_ADMISSION_CONFIG, deps) {
        this.config = config;
        this.classifier = deps.classifier ?? new ToolResultClassifier();
        this.reducers = deps.reducers;
        this.estimator = deps.estimator;
        this.evidence = deps.evidence;
        this.economics = deps.economics;
        this.telemetry = deps.telemetry ?? new NoopTelemetrySink();
    }
    keep(result, resultClass, originalTokens, reason) {
        const decision = {
            action: 'keep',
            toolName: result.toolName,
            resultClass,
            text: result.text,
            originalTokenEstimate: originalTokens,
            admittedTokenEstimate: originalTokens,
            tokensAvoided: 0,
            strategy: null,
            evidence: null,
            reason,
        };
        this.telemetry.emit({
            type: 'admission_decision',
            toolName: result.toolName,
            resultClass,
            action: 'keep',
            reason,
            originalTokens,
            admittedTokens: originalTokens,
            at: Date.now(),
        });
        return decision;
    }
    evaluate(result) {
        const originalTokens = this.estimator.estimate(result.text);
        const classification = this.classifier.classify(result);
        const resultClass = classification.resultClass;
        if (resultClass === null) {
            return this.keep(result, null, originalTokens, 'class not eligible for reduction');
        }
        if (!this.config.eligibleClasses.includes(resultClass)) {
            return this.keep(result, resultClass, originalTokens, `class ${resultClass} not in the eligible set`);
        }
        if (originalTokens < this.config.thresholdTokens) {
            return this.keep(result, resultClass, originalTokens, `below threshold (${this.config.thresholdTokens})`);
        }
        const reducer = this.reducers.get(resultClass);
        if (!reducer) {
            return this.keep(result, resultClass, originalTokens, `no reducer registered for ${resultClass}`);
        }
        const output = reducer.reduce(result);
        if (!output) {
            return this.keep(result, resultClass, originalTokens, 'reduction not smaller than the original');
        }
        const admittedTokens = this.estimator.estimate(output.text);
        const tokensAvoided = originalTokens - admittedTokens;
        if (this.config.requireNetSaving && tokensAvoided <= 0) {
            return this.keep(result, resultClass, originalTokens, 'net saving not positive');
        }
        const evidence = this.config.requireExactEvidence
            ? this.evidence.put({
                toolName: result.toolName,
                resultClass,
                text: result.text,
                tokenEstimate: originalTokens,
                strategy: output.strategy,
                preservedLines: output.preservedLines,
            })
            : null;
        if (evidence) {
            this.telemetry.emit({
                type: 'evidence_stored',
                toolName: result.toolName,
                resultClass,
                evidenceId: evidence.evidenceId,
                byteLength: evidence.byteLength,
                at: Date.now(),
            });
        }
        const decision = {
            action: 'reduce',
            toolName: result.toolName,
            resultClass,
            text: output.text,
            originalTokenEstimate: originalTokens,
            admittedTokenEstimate: admittedTokens,
            tokensAvoided,
            strategy: output.strategy,
            evidence,
            reason: `reduced ${resultClass}`,
        };
        this.telemetry.emit({
            type: 'reduction_applied',
            toolName: result.toolName,
            resultClass,
            strategy: output.strategy,
            tokensAvoided,
            exact: output.exact,
            at: Date.now(),
        });
        if (this.economics && tokensAvoided > 0) {
            this.telemetry.emit({
                type: 'economics_evaluated',
                tokensAvoided,
                usdAvoided: this.economics.savingsFromAvoidedInput(tokensAvoided),
                at: Date.now(),
            });
        }
        return decision;
    }
}
