/**
 * ToolResultClassifier — deterministic, model-free classification of a tool
 * result into a structural class. No provider calls, no randomness.
 *
 * Rules are ordered and pluggable. The defaults generalise the classes the
 * frozen Cline governor exercised (`long-file-read`, `shell-build-log`) and add
 * common ones (`test-failure`, `search-results`, `large-json`).
 */
import type { Classification, ResultClass, ToolResult } from './types.js';
export interface ClassificationRule {
    resultClass: ResultClass;
    confidence: number;
    reason: string;
    test(result: ToolResult): boolean;
}
export declare const DEFAULT_RULES: ClassificationRule[];
export declare class ToolResultClassifier {
    private readonly rules;
    constructor(rules?: ClassificationRule[]);
    classify(result: ToolResult): Classification;
}
