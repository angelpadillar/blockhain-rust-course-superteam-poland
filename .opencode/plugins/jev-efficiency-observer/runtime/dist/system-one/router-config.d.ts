/**
 * System One router configuration.
 *
 * One place that turns a host config (`systemOneRouter.provider`) into a
 * concrete scorer plus AUTO economics, so hosts such as OpenCode never contain
 * CLM-specific routing logic:
 *
 *   systemOneRouter:
 *     provider: off | deterministic | clm | jev | deepseek | valen | auto
 *
 * `off` returns no scorer (the runtime then behaves exactly as before this
 * layer existed).
 */
import { type ClmScoreMode } from './clm-scorer.js';
import { type ValenScorerOptions } from './valen-scorer.js';
import type { SystemOneScorer } from './types.js';
export type SystemOneProvider = 'off' | 'deterministic' | 'clm' | 'jev' | 'deepseek' | 'valen' | 'auto';
export interface SystemOneRouterConfig {
    provider?: SystemOneProvider;
    clm?: {
        baseUrl?: string;
        apiKey?: string;
        model?: string;
        mode?: ClmScoreMode;
        usdPerSecond?: number | null;
    };
    jev?: {
        apiKey?: string;
        baseUrl?: string;
        model?: string;
        usdPerQuestion?: number | null;
    };
    deepseek?: {
        apiKey?: string;
        baseUrl?: string;
        model?: string;
    };
    /** Multimodal Valen decision server (e.g. Modal-hosted). */
    valen?: ValenScorerOptions;
    auto?: {
        /** Preference order for the AUTO provider. Default: clm, then jev, then deepseek. */
        prefer?: Array<'clm' | 'jev' | 'deepseek' | 'valen'>;
        marginUsd?: number;
        maxRouterLatencyMs?: number;
        decisiveGap?: number;
        mainModelOutputTokensPerTurn?: number;
        wrongToolCallPenaltyUsd?: number;
    };
}
export interface ResolvedSystemOneRouter {
    provider: SystemOneProvider;
    kind: 'disabled' | 'deterministic' | 'clm' | 'jev' | 'deepseek' | 'valen' | 'auto';
    scorer: SystemOneScorer | null;
    auto: NonNullable<SystemOneRouterConfig['auto']> & {
        candidates: SystemOneScorer[];
    };
    describe(): string;
}
export declare function resolveSystemOneRouter(config?: SystemOneRouterConfig): ResolvedSystemOneRouter;
/**
 * Pick the cheapest AUTO candidate that is expected to earn its cost. Returns
 * null when the deterministic decision is decisive or no candidate is known.
 */
export declare function pickAutoCandidate(resolved: ResolvedSystemOneRouter, decision: {
    call: boolean;
    routerCostUsd: number | null;
}): SystemOneScorer | null;
