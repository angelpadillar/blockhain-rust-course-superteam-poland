/**
 * ValenSystemOneScorer — adapter for a Valen multimodal decision server
 * (https://github.com/Liuziyu77/Valen, Apache-2.0).
 *
 * Valen scores supplied candidates instead of generating an answer: the
 * decision head emits one logit per candidate, softmaxed into a distribution.
 * A small GPU server (official `valen.inference` path, wrapped in a web
 * endpoint) exposes:
 *
 *   GET  /health     -> {ok, model, checkpoint, features}
 *   POST /v1/score   -> {model, choice, probabilities, confidence, usage, latency_ms}
 *
 * The scorer never imports Valen; it speaks the documented HTTP contract so it
 * works against a local server, a Modal deployment, or any compatible host.
 * When the server is unreachable the call fails loudly; no scorer silently
 * falls back to a different decision provider.
 */
import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';
import { distributionConfidence, filterCandidates, hasMedia, rankScores, renderState } from './types.js';
const MIME = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.gif': 'image/gif',
    '.bmp': 'image/bmp',
    '.mp4': 'video/mp4',
    '.webm': 'video/webm',
    '.mov': 'video/quicktime',
};
function mimeFor(url, hint) {
    if (hint)
        return hint;
    const fromData = /^data:([^;,]+)/.exec(url)?.[1];
    if (fromData)
        return fromData;
    return MIME[extname(url).toLowerCase()] ?? 'application/octet-stream';
}
/** Materialize a local path or data URL into the request body's data-URL form. */
async function resolveMedia(url, hint, maxBytes) {
    if (url.startsWith('data:'))
        return { url, bytes: url.length };
    if (url.startsWith('asset:'))
        return { url, bytes: 0 };
    const bytes = await readFile(url);
    if (bytes.byteLength > maxBytes)
        throw new Error(`ValenScorer: ${url} is ${bytes.byteLength} bytes (> ${maxBytes})`);
    return { url: `data:${mimeFor(url, hint)};base64,${bytes.toString('base64')}`, bytes: bytes.byteLength };
}
/** Text state + compact structured JSON; ids/labels never enter the prompt. */
export function renderValenState(state, includeStructured = true) {
    const base = renderState(state, 4000);
    if (!includeStructured || !state.structured)
        return base;
    const structured = JSON.stringify(state.structured);
    const bounded = structured.length > 3000 ? `${structured.slice(0, 3000)}…` : structured;
    return `${base}\nStructured state: ${bounded}`;
}
export class ValenSystemOneScorer {
    options;
    name = 'valen';
    kind = 'valen';
    baseUrl;
    apiKey;
    model;
    fetcher;
    timeoutMs;
    instructions;
    temperature;
    includeStructured;
    maxMediaBytes;
    constructor(options = {}) {
        this.options = options;
        this.baseUrl = (options.baseUrl ?? process.env.VALEN_BASE_URL ?? 'http://127.0.0.1:8710').replace(/\/$/, '');
        this.apiKey = options.apiKey ?? process.env.VALEN_API_KEY ?? '';
        this.model = options.model ?? 'Valen-Preview-0923';
        this.fetcher = options.fetch ?? fetch;
        this.timeoutMs = options.timeoutMs ?? 120_000;
        this.instructions = options.instructions;
        this.temperature = options.temperature ?? 1.0;
        this.includeStructured = options.includeStructured ?? true;
        this.maxMediaBytes = options.maxMediaBytes ?? 8 * 1024 * 1024;
    }
    /** GET /health — used by shadow-mode gating before any paid call. */
    async health() {
        const response = await this.fetcher(`${this.baseUrl}/health`, { method: 'GET' });
        const text = await response.text();
        if (!response.ok)
            throw new Error(`Valen /health failed (${response.status}): ${text.slice(0, 200)}`);
        return JSON.parse(text);
    }
    async score(input) {
        const candidates = filterCandidates(input);
        if (candidates.length === 0)
            throw new Error('ValenScorer: no candidates');
        if (candidates.length === 1) {
            return {
                scorer: this.name,
                provider: 'valen',
                model: this.model,
                ranked: [{ id: candidates[0].id, score: 1, probability: 1, rank: 1 }],
                confidence: null,
                latencyMs: 0,
                usage: { inputTokens: 0, outputTokens: 0, billingUnits: 0 },
                cost: { usd: 0, source: 'single-candidate' },
                audit: { skipped: true, reason: 'one candidate needs no ranking' },
            };
        }
        const instructions = this.instructions ?? input.context?.instructions ?? input.state.goal;
        const criteria = {};
        for (const candidate of candidates)
            criteria[candidate.id] = candidate.description;
        const rendered = renderValenState(input.state, this.includeStructured);
        const content = [{ type: 'text', text: rendered }];
        let mediaBytes = 0;
        for (const image of input.state.images ?? []) {
            const resolved = await resolveMedia(image.url, image.mediaType, this.maxMediaBytes);
            mediaBytes += resolved.bytes;
            content.push({ type: 'image_url', image_url: { url: resolved.url } });
        }
        for (const video of input.state.video ?? []) {
            const resolved = await resolveMedia(video.url, video.mediaType, this.maxMediaBytes);
            mediaBytes += resolved.bytes;
            content.push({ type: 'video_url', video_url: { url: resolved.url } });
        }
        const started = Date.now();
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), this.timeoutMs);
        let response;
        try {
            response = await this.fetcher(`${this.baseUrl}/v1/score`, {
                method: 'POST',
                headers: {
                    'content-type': 'application/json',
                    ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}),
                },
                body: JSON.stringify({
                    state: { messages: [{ role: 'user', content }] },
                    question: { type: 'choice', instructions, criteria },
                    temperature: this.temperature,
                    ...(this.options.checkpoint ? { checkpoint: this.options.checkpoint } : {}),
                }),
                signal: controller.signal,
            });
        }
        finally {
            clearTimeout(timer);
        }
        const text = await response.text();
        const wallMs = Date.now() - started;
        if (!response.ok)
            throw new Error(`ValenScorer: /v1/score failed (${response.status}): ${text.slice(0, 300)}`);
        const parsed = JSON.parse(text);
        if (!parsed.probabilities)
            throw new Error('ValenScorer: response has no candidate probabilities');
        const entries = candidates.map((candidate) => ({
            id: candidate.id,
            score: Number((parsed.probabilities[candidate.id] ?? 0).toFixed(6)),
            probability: parsed.probabilities[candidate.id] ?? null,
        }));
        const ranked = rankScores(entries);
        const serverLatency = typeof parsed.latency_ms === 'number' ? parsed.latency_ms : null;
        const rate = this.options.usdPerSecond;
        return {
            scorer: this.name,
            provider: 'valen',
            model: parsed.model ?? this.model,
            ranked,
            confidence: typeof parsed.confidence === 'number' ? parsed.confidence : distributionConfidence(entries.map((e) => e.probability ?? 0)),
            latencyMs: serverLatency ?? wallMs,
            usage: {
                inputTokens: parsed.usage?.input_tokens ?? null,
                outputTokens: parsed.usage?.compute_tokens ?? null,
                billingUnits: 1,
            },
            cost: typeof rate === 'number' ? { usd: ((serverLatency ?? wallMs) / 1000) * rate, source: 'gpu-latency-share' } : { usd: null, source: 'unavailable' },
            audit: {
                endpoint: `${this.baseUrl}/v1/score`,
                wallMs,
                serverLatencyMs: serverLatency,
                candidates: candidates.length,
                choice: parsed.choice ?? null,
                media: { images: input.state.images?.length ?? 0, video: input.state.video?.length ?? 0, bytes: mediaBytes },
                hasMedia: hasMedia(input.state),
            },
        };
    }
}
