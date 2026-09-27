/**
 * DeterministicReducer — fixed, model-free strategies that shrink a tool result
 * while keeping the admitted text auditable.
 *
 * Hard rule (inherited from the frozen governor): admitted text is either an
 * exact source line or a fixed accounting marker. No reducer paraphrases or
 * invents content. `ReducerOutput.exact` is true when that line-level rule
 * holds; JSON shape summaries are derived and therefore `exact: false`, which
 * forces the admission policy to persist an exact-evidence pointer.
 */
import type { ResultClass, ToolResult } from './types.js';
export interface ReducerOutput {
    text: string;
    strategy: string;
    exact: boolean;
    /** 0-based line numbers preserved verbatim, when meaningful. */
    preservedLines: number[];
}
export interface DeterministicReducer {
    readonly resultClass: ResultClass;
    reduce(result: ToolResult): ReducerOutput | null;
}
export declare class LongFileReadReducer implements DeterministicReducer {
    private readonly maxKeptLines;
    readonly resultClass: "long-file-read";
    constructor(maxKeptLines?: number);
    reduce(result: ToolResult): ReducerOutput | null;
}
export declare class ShellBuildLogReducer implements DeterministicReducer {
    private readonly maxKeptLines;
    readonly resultClass: "shell-build-log";
    constructor(maxKeptLines?: number);
    reduce(result: ToolResult): ReducerOutput | null;
}
export declare class TestFailureReducer implements DeterministicReducer {
    private readonly maxKeptLines;
    readonly resultClass: "test-failure";
    constructor(maxKeptLines?: number);
    reduce(result: ToolResult): ReducerOutput | null;
}
export declare class SearchResultsReducer implements DeterministicReducer {
    private readonly maxUniqueLines;
    readonly resultClass: "search-results";
    constructor(maxUniqueLines?: number);
    reduce(result: ToolResult): ReducerOutput | null;
}
export declare class LargeJsonReducer implements DeterministicReducer {
    readonly resultClass: "large-json";
    reduce(result: ToolResult): ReducerOutput | null;
}
export declare class ReducerRegistry {
    private readonly map;
    constructor(reducers?: readonly DeterministicReducer[]);
    register(reducer: DeterministicReducer): this;
    get(resultClass: ResultClass): DeterministicReducer | undefined;
    has(resultClass: ResultClass): boolean;
    classes(): ResultClass[];
}
export declare function defaultReducerRegistry(): ReducerRegistry;
