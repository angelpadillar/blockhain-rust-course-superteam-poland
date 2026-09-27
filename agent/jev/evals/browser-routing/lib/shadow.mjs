/**
 * Valen SHADOW mode. Valen only ever produces a recorded recommendation; the
 * result carries `executable: false` and no code path returns an action that a
 * controller could dispatch.
 *
 * VALEN_MODE=off     -> no call, no network
 * VALEN_MODE=shadow  -> call the zero-shot endpoint for ambiguous/every record
 */
import { existsSync, readFileSync } from 'node:fs';

export const SHADOW_INSTRUCTIONS =
  'You are the visual router for a browser-control agent. Given the page state and the closed set of candidate actions, choose the single action the deterministic validator should consider first. Never choose a security challenge solution; escalate genuine security checkpoints to a human.';

export function shadowConfig(env = process.env) {
  const mode = (env.VALEN_MODE ?? 'off').toLowerCase();
  if (!['off', 'shadow'].includes(mode)) throw new Error(`unknown VALEN_MODE=${mode}; expected off|shadow`);
  return {
    mode,
    enabled: mode === 'shadow',
    baseUrl: (env.VALEN_BASE_URL ?? '').replace(/\/$/, ''),
    apiKey: env.VALEN_API_KEY ?? '',
    model: env.VALEN_MODEL ?? 'Valen-Preview-0923',
    checkpoint: env.VALEN_CHECKPOINT ?? null,
    timeoutMs: Number(env.VALEN_TIMEOUT_MS ?? 180000),
  };
}

function dataUrl(path) {
  if (!existsSync(path)) return null;
  const bytes = readFileSync(path);
  const mime = path.endsWith('.jpg') || path.endsWith('.jpeg') ? 'image/jpeg' : path.endsWith('.webp') ? 'image/webp' : 'image/png';
  return `data:${mime};base64,${bytes.toString('base64')}`;
}

/**
 * @returns {{status:'ok'|'off'|'blocked'|'error', recommendation:object|null, reason:string|null}}
 */
export async function shadowScore(record, { config, fetchImpl = fetch, imageBase = null } = {}) {
  if (!config || !config.enabled) return { status: 'off', recommendation: null, reason: 'VALEN_MODE is not shadow' };
  if (!config.baseUrl) return { status: 'blocked', recommendation: null, reason: 'VALEN_BASE_URL is not configured' };
  const candidates = record.candidates ?? [];
  if (candidates.length < 2) return { status: 'off', recommendation: null, reason: 'fewer than two candidates; shadow adds no information' };

  const criteria = {};
  for (const candidate of candidates) criteria[candidate.id] = candidate.description;
  const stateText = [record.state?.text ?? '', record.state?.normalized ? `Structured state: ${JSON.stringify(record.state.normalized).slice(0, 2500)}` : '']
    .filter(Boolean)
    .join('\n');
  const content = [{ type: 'text', text: stateText }];
  const screenshot = record.evidence?.screenshot;
  const imagePath = screenshot?.snapshot_path && imageBase ? `${imageBase.replace(/\/$/, '')}/${screenshot.snapshot_path}` : screenshot?.source_path ?? null;
  const image = imagePath ? dataUrl(imagePath) : null;
  if (image) content.push({ type: 'image_url', image_url: { url: image } });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);
  const started = Date.now();
  try {
    const response = await fetchImpl(`${config.baseUrl}/v1/score`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(config.apiKey ? { authorization: `Bearer ${config.apiKey}` } : {}) },
      body: JSON.stringify({
        state: { messages: [{ role: 'user', content }] },
        question: { type: 'choice', instructions: SHADOW_INSTRUCTIONS, criteria },
        temperature: 1.0,
        ...(config.checkpoint ? { checkpoint: config.checkpoint } : {}),
      }),
      signal: controller.signal,
    });
    const text = await response.text();
    const wallMs = Date.now() - started;
    if (!response.ok) return { status: 'error', recommendation: null, reason: `HTTP ${response.status}: ${text.slice(0, 200)}` };
    const parsed = JSON.parse(text);
    const probabilities = parsed.probabilities ?? {};
    const ranked = Object.entries(probabilities)
      .map(([id, probability]) => ({ id, probability }))
      .sort((a, b) => b.probability - a.probability || a.id.localeCompare(b.id));
    return {
      status: 'ok',
      reason: null,
      recommendation: {
        mode: 'shadow',
        model: parsed.model ?? config.model,
        checkpoint: parsed.checkpoint ?? config.checkpoint ?? null,
        top1: ranked[0]?.id ?? null,
        top3: ranked.slice(0, 3).map((entry) => entry.id),
        confidence: typeof parsed.confidence === 'number' ? parsed.confidence : null,
        probabilities,
        latency_ms: typeof parsed.latency_ms === 'number' ? parsed.latency_ms : wallMs,
        wall_ms: wallMs,
        executable: false,
        recorded_at: new Date().toISOString(),
      },
    };
  } catch (error) {
    return { status: 'error', recommendation: null, reason: error?.message ?? String(error) };
  } finally {
    clearTimeout(timer);
  }
}

/** Attach shadow results to records (returns new records; never mutates inputs). */
export async function shadowBatch(records, options) {
  const output = [];
  const summary = { attempted: 0, ok: 0, off: 0, blocked: 0, error: 0 };
  for (const record of records) {
    const result = await shadowScore(record, options);
    summary[result.status] = (summary[result.status] ?? 0) + 1;
    if (result.status !== 'off') summary.attempted += 1;
    const next = structuredClone(record);
    next.recommendations = { ...(next.recommendations ?? {}), valen: result.recommendation ?? { mode: 'shadow', status: result.status, reason: result.reason, executable: false } };
    output.push(next);
  }
  return { records: output, summary };
}
