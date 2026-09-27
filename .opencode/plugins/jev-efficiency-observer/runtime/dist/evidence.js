/**
 * EvidencePointer / EvidenceStore — exact, recoverable preservation of the
 * original tool result behind any reduction.
 *
 * The invariant: an evidence pointer's `evidenceId` is the sha256 of the exact
 * original UTF-8 bytes, and `recover(id)` returns those bytes verbatim. A
 * reducer may therefore be aggressive without losing information the agent can
 * still retrieve on demand.
 */
import { createHash } from 'node:crypto';
export const hashText = (text) => createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex');
export class InMemoryEvidenceStore {
    records = new Map();
    put(input) {
        const evidenceId = hashText(input.text);
        const record = {
            evidenceId,
            toolName: input.toolName,
            resultClass: input.resultClass,
            byteLength: Buffer.byteLength(input.text, 'utf8'),
            tokenEstimate: input.tokenEstimate,
            locator: {
                kind: 'full-result',
                strategy: input.strategy,
                ...(input.preservedLines ? { preservedLines: [...input.preservedLines] } : {}),
            },
            text: input.text,
            createdAt: Date.now(),
        };
        if (!this.records.has(evidenceId))
            this.records.set(evidenceId, record);
        return toPointer(record);
    }
    get(evidenceId) {
        return this.records.get(evidenceId);
    }
    recover(evidenceId) {
        return this.records.get(evidenceId)?.text;
    }
    has(evidenceId) {
        return this.records.has(evidenceId);
    }
    size() {
        return this.records.size;
    }
    verify(evidenceId) {
        const record = this.records.get(evidenceId);
        if (!record)
            return false;
        return hashText(record.text) === evidenceId && Buffer.byteLength(record.text, 'utf8') === record.byteLength;
    }
    stats() {
        let totalBytes = 0;
        let oldest = null;
        let newest = null;
        for (const record of this.records.values()) {
            totalBytes += record.byteLength;
            if (oldest === null || record.createdAt < oldest)
                oldest = record.createdAt;
            if (newest === null || record.createdAt > newest)
                newest = record.createdAt;
        }
        return { entries: this.records.size, totalBytes, oldestCreatedAt: oldest, newestCreatedAt: newest };
    }
    prune(options = {}) {
        const now = options.now?.() ?? Date.now();
        const protectedIds = new Set(options.protectedIds ?? []);
        const removals = [];
        let protectedSkipped = 0;
        // Age-based removals (never touch protected).
        if (Number.isFinite(options.maxAgeMs)) {
            for (const [id, record] of this.records) {
                if (protectedIds.has(id)) {
                    protectedSkipped += 1;
                    continue;
                }
                if (now - record.createdAt > options.maxAgeMs)
                    removals.push(id);
            }
        }
        // Entry-count cap: keep the newest `maxEntries` among survivors.
        if (Number.isFinite(options.maxEntries)) {
            const survivors = [...this.records.entries()]
                .filter(([id]) => !removals.includes(id))
                .sort((a, b) => b[1].createdAt - a[1].createdAt);
            for (const [id] of survivors.slice(options.maxEntries)) {
                if (protectedIds.has(id)) {
                    protectedSkipped += 1;
                    continue;
                }
                removals.push(id);
            }
        }
        let removedBytes = 0;
        if (!options.dryRun) {
            for (const id of removals) {
                const record = this.records.get(id);
                if (!record)
                    continue;
                removedBytes += record.byteLength;
                this.records.delete(id);
            }
        }
        else {
            for (const id of removals)
                removedBytes += this.records.get(id)?.byteLength ?? 0;
        }
        let remainingBytes = 0;
        for (const record of this.records.values())
            remainingBytes += record.byteLength;
        return {
            dryRun: Boolean(options.dryRun),
            removed: removals,
            removedBytes,
            kept: this.records.size,
            protectedSkipped,
            remainingBytes,
        };
    }
}
export function toPointer(record) {
    return {
        evidenceId: record.evidenceId,
        toolName: record.toolName,
        resultClass: record.resultClass,
        byteLength: record.byteLength,
        tokenEstimate: record.tokenEstimate,
        locator: record.locator,
    };
}
