import type { AgentState, ScoringInput, ScoringResult, SystemOneScorer } from './types.js';
export interface ValenScorerOptions {
    /** Base URL of the Valen decision server (no trailing slash needed). */
    baseUrl?: string;
    /** Bearer token when the endpoint is protected. */
    apiKey?: string;
    /** Expected served model name; used for audit only. */
    model?: string;
    fetch?: typeof fetch;
    timeoutMs?: number;
    /** Optional GPU $/s to attribute cost from measured latency (null = unknown). */
    usdPerSecond?: number | null;
    /** Overrides the decision instruction (defaults to context.instructions or state.goal). */
    instructions?: string;
    /** Softmax temperature; 1.0 is the checkpoint default. */
    temperature?: number;
    /** Optional served checkpoint name (e.g. a fine-tuned head directory). */
    checkpoint?: string;
    /** Send structured state as compact JSON text (default true). */
    includeStructured?: boolean;
    /** Cap on serialized media bytes per request (default 8 MiB). */
    maxMediaBytes?: number;
}
/** Text state + compact structured JSON; ids/labels never enter the prompt. */
export declare function renderValenState(state: AgentState, includeStructured?: boolean): string;
export declare class ValenSystemOneScorer implements SystemOneScorer {
    private readonly options;
    readonly name = "valen";
    readonly kind: "valen";
    private readonly baseUrl;
    private readonly apiKey;
    private readonly model;
    private readonly fetcher;
    private readonly timeoutMs;
    private readonly instructions?;
    private readonly temperature;
    private readonly includeStructured;
    private readonly maxMediaBytes;
    constructor(options?: ValenScorerOptions);
    /** GET /health — used by shadow-mode gating before any paid call. */
    health(): Promise<Record<string, unknown>>;
    score(input: ScoringInput): Promise<ScoringResult>;
}
