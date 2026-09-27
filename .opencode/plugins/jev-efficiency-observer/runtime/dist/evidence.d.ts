import type { EvidencePointer, EvidenceRecord, ResultClass } from './types.js';
export interface EvidencePutInput {
    toolName: string;
    resultClass: ResultClass | null;
    text: string;
    tokenEstimate: number;
    strategy: string | null;
    preservedLines?: number[];
}
export interface EvidenceStore {
    put(input: EvidencePutInput): EvidencePointer;
    get(evidenceId: string): EvidenceRecord | undefined;
    recover(evidenceId: string): string | undefined;
    has(evidenceId: string): boolean;
    size(): number;
    /** Re-hash the stored text and confirm it matches the pointer id. */
    verify(evidenceId: string): boolean;
    stats(): EvidenceStoreStats;
    /**
     * Lifecycle maintenance. Never removes an entry whose id is protected
     * (e.g. still referenced by retained telemetry). `dryRun` only reports.
     */
    prune(options?: EvidencePruneOptions): EvidencePruneResult;
}
export interface EvidenceStoreStats {
    entries: number;
    totalBytes: number;
    oldestCreatedAt: number | null;
    newestCreatedAt: number | null;
}
export interface EvidencePruneOptions {
    /** Remove entries older than this. */
    maxAgeMs?: number;
    /** Keep at most this many entries, newest first. */
    maxEntries?: number;
    /** Ids that must never be removed (referenced by retained telemetry). */
    protectedIds?: Iterable<string>;
    dryRun?: boolean;
    now?: () => number;
}
export interface EvidencePruneResult {
    dryRun: boolean;
    removed: string[];
    removedBytes: number;
    kept: number;
    protectedSkipped: number;
    remainingBytes: number;
}
export declare const hashText: (text: string) => string;
export declare class InMemoryEvidenceStore implements EvidenceStore {
    private readonly records;
    put(input: EvidencePutInput): EvidencePointer;
    get(evidenceId: string): EvidenceRecord | undefined;
    recover(evidenceId: string): string | undefined;
    has(evidenceId: string): boolean;
    size(): number;
    verify(evidenceId: string): boolean;
    stats(): EvidenceStoreStats;
    prune(options?: EvidencePruneOptions): EvidencePruneResult;
}
export declare function toPointer(record: EvidenceRecord): EvidencePointer;
