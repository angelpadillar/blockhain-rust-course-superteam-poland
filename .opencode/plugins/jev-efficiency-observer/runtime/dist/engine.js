import { StructuralTokenEstimator } from './tokens.js';
import { ToolResultClassifier } from './classifier.js';
import { defaultReducerRegistry } from './reducers.js';
import { InMemoryEvidenceStore } from './evidence.js';
import { EconomicsPolicy } from './economics.js';
import { ResultAdmissionPolicy, DEFAULT_ADMISSION_CONFIG } from './admission.js';
import { createToolRegistry, shortlistTools } from './tools.js';
import { InMemoryTelemetrySink } from './telemetry.js';
export class AgentEfficiencyRuntime {
    estimator;
    classifier;
    reducers;
    evidence;
    economics;
    telemetry;
    policy;
    tools;
    constructor(options = {}) {
        this.estimator = options.estimator ?? new StructuralTokenEstimator();
        this.classifier = options.classifier ?? new ToolResultClassifier(options.classifierRules);
        this.reducers = options.reducers ?? defaultReducerRegistry();
        for (const reducer of options.additionalReducers ?? [])
            this.reducers.register(reducer);
        this.evidence = options.evidence ?? new InMemoryEvidenceStore();
        this.economics = new EconomicsPolicy(options.pricing);
        this.telemetry = options.telemetry ?? new InMemoryTelemetrySink(options.runId);
        this.tools = createToolRegistry(options.tools ?? []);
        this.policy = new ResultAdmissionPolicy({ ...DEFAULT_ADMISSION_CONFIG, ...(options.admissionConfig ?? {}) }, {
            classifier: this.classifier,
            reducers: this.reducers,
            estimator: this.estimator,
            evidence: this.evidence,
            economics: this.economics,
            telemetry: this.telemetry,
        });
    }
    registerTool(tool) {
        this.tools.register(tool);
        return this;
    }
    registerTools(tools) {
        this.tools.registerMany(tools);
        return this;
    }
    /** Classify + admit/reduce a single tool result. */
    processToolResult(result) {
        return this.policy.evaluate(result);
    }
    shortlist(query, options = {}) {
        const result = shortlistTools(this.tools, query, options);
        this.telemetry.emit({
            type: 'shortlist_computed',
            query,
            selected: result.tools.map((t) => t.name),
            reason: result.reason,
            at: Date.now(),
        });
        return result;
    }
    /** Recover the exact original text behind a reduction, verbatim. */
    recoverEvidence(evidenceId) {
        return this.evidence.recover(evidenceId);
    }
}
