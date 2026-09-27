/**
 * Shortlist policy — soft preference, never silent deletion.
 *
 * Measured context: deterministic top-K tool shortlisting reaches ~86.4%
 * required-tool recall at K=3 and ~93.2% at K=5 on our strict corpus. A
 * destructive K=3 filter would therefore drop the required tool ~14% of the
 * time, so HARD mode is experimental, disabled by default, and gated on a
 * configured minimum measured recall.
 *
 *   off      no routing; the full registry is exposed
 *   observe  compute the proposal and record it; expose everything (default)
 *   soft     expose the shortlist prominently, keep an explicit fallback path
 *   hard     actually remove tools (experimental; requires the safety gate)
 */
import type { ToolDescriptor } from '../types.js';
import { ToolRegistry } from '../tools.js';
import { type TokenEstimator } from '../tokens.js';
export type ShortlistMode = 'off' | 'observe' | 'soft' | 'hard';
export interface ShortlistPolicyConfig {
    mode?: ShortlistMode;
    /** Use two-stage family routing (recommended). */
    hierarchy?: boolean;
    maxFamilies?: number;
    maxTools?: number;
    /** HARD only: the lowest measured required-tool recall that still permits deletion. */
    hardMinRequiredToolRecall?: number;
    /** HARD only: the measured recall used by the gate. Null blocks HARD. */
    measuredRequiredToolRecall?: number | null;
}
export interface ShortlistSafety {
    allowed: boolean;
    reason: string;
}
export interface ShortlistPlan {
    mode: ShortlistMode;
    /** Tools actually exposed to the model for this turn. */
    exposed: ToolDescriptor[];
    /** The proposed shortlist (what SOFT/HARD would expose). */
    proposed: ToolDescriptor[];
    /** Tools removed from the model view (non-empty only in HARD). */
    removed: ToolDescriptor[];
    /** In SOFT, omitted tools stay callable through an explicit fallback. */
    fallbackAccess: boolean;
    families: Array<{
        id: string;
        score: number;
        toolCount: number;
        taken: number;
    }>;
    candidateCount: number;
    schemaTokensBefore: number;
    schemaTokensAfter: number;
    safety: ShortlistSafety;
    reason: string;
}
export declare const DEFAULT_SHORTLIST_POLICY: Required<Pick<ShortlistPolicyConfig, 'mode' | 'hierarchy' | 'maxFamilies' | 'maxTools' | 'hardMinRequiredToolRecall'>>;
export declare function planShortlist(registry: ToolRegistry, query: string, config?: ShortlistPolicyConfig, estimator?: TokenEstimator): ShortlistPlan;
