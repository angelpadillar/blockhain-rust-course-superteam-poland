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
import { ClmScorer } from './clm-scorer.js';
import { JevScorer } from './jev-scorer.js';
import { DeepSeekScorer } from './deepseek-scorer.js';
import { DeterministicScorer } from './deterministic-scorer.js';
import { ValenSystemOneScorer } from './valen-scorer.js';
export function resolveSystemOneRouter(config = {}) {
    const provider = config.provider ?? 'off';
    if (provider === 'off') {
        return { provider, kind: 'disabled', scorer: null, auto: { ...(config.auto ?? {}), candidates: [] }, describe: () => 'systemOneRouter=off' };
    }
    if (provider === 'deterministic') {
        const scorer = new DeterministicScorer();
        return { provider, kind: 'deterministic', scorer, auto: { ...(config.auto ?? {}), candidates: [] }, describe: () => 'systemOneRouter=deterministic (local, free)' };
    }
    if (provider === 'clm') {
        const scorer = new ClmScorer({ baseUrl: config.clm?.baseUrl, apiKey: config.clm?.apiKey, model: config.clm?.model, mode: config.clm?.mode, usdPerSecond: config.clm?.usdPerSecond });
        return { provider, kind: 'clm', scorer, auto: { ...(config.auto ?? {}), candidates: [] }, describe: () => `systemOneRouter=clm (${config.clm?.baseUrl ?? 'default endpoint'})` };
    }
    if (provider === 'jev') {
        const scorer = new JevScorer({ apiKey: config.jev?.apiKey, baseUrl: config.jev?.baseUrl, model: config.jev?.model, usdPerQuestion: config.jev?.usdPerQuestion });
        return { provider, kind: 'jev', scorer, auto: { ...(config.auto ?? {}), candidates: [] }, describe: () => 'systemOneRouter=jev' };
    }
    if (provider === 'deepseek') {
        const scorer = new DeepSeekScorer({ apiKey: config.deepseek?.apiKey, baseUrl: config.deepseek?.baseUrl, model: config.deepseek?.model });
        return { provider, kind: 'deepseek', scorer, auto: { ...(config.auto ?? {}), candidates: [] }, describe: () => 'systemOneRouter=deepseek' };
    }
    if (provider === 'valen') {
        const scorer = new ValenSystemOneScorer({ ...config.valen });
        return {
            provider,
            kind: 'valen',
            scorer,
            auto: { ...(config.auto ?? {}), candidates: [] },
            describe: () => `systemOneRouter=valen (${config.valen?.baseUrl ?? 'default endpoint'})`,
        };
    }
    // auto: build the preference list; only explicitly configured providers
    // participate (an unconfigured scorer must not be constructed and then fail
    // at use time).
    const order = config.auto?.prefer ?? ['clm', 'jev', 'deepseek'];
    const candidates = [];
    for (const name of order) {
        if (name === 'clm' && config.clm?.baseUrl) {
            candidates.push(new ClmScorer({ baseUrl: config.clm.baseUrl, apiKey: config.clm.apiKey, model: config.clm.model, mode: config.clm.mode, usdPerSecond: config.clm.usdPerSecond }));
        }
        else if (name === 'jev' && (config.jev?.apiKey || config.jev?.baseUrl)) {
            candidates.push(new JevScorer({ apiKey: config.jev?.apiKey, baseUrl: config.jev?.baseUrl, model: config.jev?.model, usdPerQuestion: config.jev?.usdPerQuestion }));
        }
        else if (name === 'deepseek' && config.deepseek?.apiKey) {
            candidates.push(new DeepSeekScorer({ apiKey: config.deepseek.apiKey, baseUrl: config.deepseek.baseUrl, model: config.deepseek.model }));
        }
        else if (name === 'valen' && config.valen?.baseUrl) {
            candidates.push(new ValenSystemOneScorer({ ...config.valen }));
        }
    }
    return {
        provider,
        kind: 'auto',
        scorer: candidates[0] ?? null,
        auto: { ...(config.auto ?? {}), candidates },
        describe: () => `systemOneRouter=auto (${candidates.map((c) => c.name).join(' > ') || 'no configured candidate'})`,
    };
}
/**
 * Pick the cheapest AUTO candidate that is expected to earn its cost. Returns
 * null when the deterministic decision is decisive or no candidate is known.
 */
export function pickAutoCandidate(resolved, decision) {
    if (!decision.call || resolved.kind !== 'auto')
        return null;
    return resolved.auto.candidates.find((c) => c.kind !== 'deepseek') ?? resolved.auto.candidates[0] ?? null;
}
