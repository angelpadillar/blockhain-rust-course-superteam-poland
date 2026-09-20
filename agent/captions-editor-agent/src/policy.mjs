import { realpath, stat, readFile } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { createHash } from 'node:crypto';
export class Stop extends Error { constructor(code, detail = null) { super(code); this.code = code; this.detail = detail; } }
export function assert(ok, code) { if (!ok) throw new Stop(code); }
export const VERSION = 'captions-authorized-account-v2';
export const FORBIDDEN = /\b(?:buy|purchase|checkout|billing|subscribe|subscription|upgrade|pricing|payment|publish|share|invite|delete|remove account|connect account|manage account|start trial|free trial)\b/i;
export const PHASES = ['project', 'upload', 'trim', 'captions', 'copy', 'export'];
export const ACTION_LABELS = Object.freeze({
  project: /^(?:New project|Create project|Create new|AI Edit|Upload video)$/i,
  trim_open: /^(?:Trim|Edit clip|Trim clip)$/i,
  trim_apply: /^(?:Apply|Done|Save trim)$/i,
  captions: /^(?:AI captions|Add captions|Generate captions|AI Edit|Edit with AI)$/i,
  copy: /^(?:Save a copy|Save copy|Duplicate project|Duplicate)$/i,
  export: /^(?:Export|Export video|Download|Download video|Download MP4)$/i,
});
export function allowedUrl(value, domains, { navigation = false } = {}) {
  try {
    const u = new URL(value);
    if (!navigation && ['data:', 'blob:'].includes(u.protocol)) return true;
    return u.protocol === 'https:' && !u.username && !u.password && !u.port
      && domains.includes(u.hostname) && !FORBIDDEN.test(decodeURIComponent(u.pathname + ' ' + u.search + ' ' + u.hash).replace(/[_+]/g, ' '));
  } catch { return false; }
}
export function allowedMutation({ url, method, contentType = '', body = '' }, routes, phase) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(method)) return true;
  if (!['POST', 'PUT', 'PATCH'].includes(method)) return false;
  let u; try { u = new URL(url); } catch { return false; }
  const type = contentType.split(';')[0].trim().toLowerCase();
  const rule = (routes || []).find(r => r.host === u.hostname && r.path === u.pathname
    && r.methods.includes(method) && [phase, 'read'].includes(r.phase) && r.contentTypes.includes(type));
  if (!rule) return false;
  // Reviewed read endpoints (for example feature-flag initialization) can carry
  // subscription-related field names without performing a purchase.
  if (rule.phase === 'read') return body.length <= 65536;
  if (type === 'multipart/form-data') return phase === 'upload' && rule.phase === 'upload';
  if (body.length > 65536) return false;
  let data;
  try {
    if (type === 'application/json') data = JSON.parse(body || '{}');
    else if (type === 'application/x-www-form-urlencoded') data = Object.fromEntries(new URLSearchParams(body));
    else return false;
  } catch { return false; }
  // Reject money/account/publish/delete intents even on an explicitly reviewed endpoint.
  const inspect = value => {
    if (typeof value === 'string') return !FORBIDDEN.test(value.replace(/[_+]/g, ' '));
    if (Array.isArray(value)) return value.every(inspect);
    if (value && typeof value === 'object') return Object.entries(value).every(([key, val]) => !FORBIDDEN.test(key.replace(/[_+]/g, ' ')) && inspect(val));
    return true;
  };
  return inspect(data);
}
export function allowedInteractiveAuth(request, config, desktop) {
  if (!desktop || !['GET','HEAD','OPTIONS','POST'].includes(request.method)) return false;
  let url; try { url = new URL(request.url); } catch { return false; }
  const hosts = config.interactiveAuthDomains || [];
  return hosts.includes(url.hostname) && allowedUrl(request.url, hosts, {navigation:true});
}
export function freeEditEvidence(text) {
  const nonzero = /(?:^|[^0-9])(?:[1-9][0-9]*(?:\.[0-9]+)?|0\.[0-9]*[1-9][0-9]*)\s*credits?\b/i.test(text)
    || /(?:[$€£]\s*[0-9]|[0-9]\s*(?:USD|EUR|GBP))/i.test(text);
  return { nonzero, included: !nonzero && /(?:included in your plan|no credits required|(?<![0-9.])0(?:\.0+)?\s+credits?\b|free edit)/i.test(text) };
}
export function permittedControl(control, phase) {
  return !!control.visible && !control.disabled && !FORBIDDEN.test(`${control.label} ${control.context || ''}`)
    && !!ACTION_LABELS[phase]?.test(control.label.trim());
}
export function validateJob(body, config) {
  assert(body && typeof body === 'object' && !Array.isArray(body), 'invalid_job');
  const permitted = new Set(['assetId', 'trimStart', 'trimEnd', 'style', 'expectedCaption', 'requireSubtitleTrack']);
  assert(Object.keys(body).every(k => permitted.has(k)), 'unknown_job_field');
  assert(typeof body.assetId === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(body.assetId), 'invalid_asset_id');
  assert(Object.hasOwn(config.assets, body.assetId), 'asset_not_authorized');
  assert(Number.isFinite(body.trimStart) && body.trimStart >= 0, 'invalid_trim_start');
  assert(Number.isFinite(body.trimEnd) && body.trimEnd > body.trimStart && body.trimEnd <= 60, 'invalid_trim_end');
  assert(typeof body.expectedCaption === 'string' && body.expectedCaption.trim().length >= 4 && body.expectedCaption.length <= 240, 'expected_caption_required');
  assert(typeof body.style === 'string' && config.styles.includes(body.style), 'style_not_authorized');
  assert(body.requireSubtitleTrack === undefined || typeof body.requireSubtitleTrack === 'boolean', 'invalid_subtitle_requirement');
  return { assetId: body.assetId, trimStart: body.trimStart, trimEnd: body.trimEnd, style: body.style,
    expectedCaption: body.expectedCaption.trim(), requireSubtitleTrack: body.requireSubtitleTrack === true };
}
export async function resolveAsset(config, assetId) {
  assert(Object.hasOwn(config.assets, assetId), 'asset_not_authorized');
  const entry = config.assets[assetId], root = await realpath(config.assetsRoot), path = await realpath(resolve(root, entry.file));
  assert(path.startsWith(root + sep), 'asset_outside_root');
  const info = await stat(path); assert(info.isFile() && info.size > 0 && info.size <= 50 * 1024 ** 2, 'asset_size_invalid');
  assert(/\.mp4$/i.test(path), 'asset_format_invalid');
  const digest = createHash('sha256').update(await readFile(path)).digest('hex');
  assert(typeof entry.sha256 === 'string' && digest === entry.sha256, 'asset_hash_mismatch');
  return { path, sha256: digest, bytes: info.size };
}
export function validateConfig(config) {
  assert(config.profileId === 'captions-test', 'profile_must_be_isolated_test');
  assert(config.testAccountOnly === true || config.accountScope === 'owner-authorized', 'authorized_account_required');
  assert(Array.isArray(config.navigationDomains) && config.navigationDomains.every(x => ['captions.ai', 'www.captions.ai', 'desktop.captions.ai', 'app.captions.ai'].includes(x)), 'navigation_allowlist_invalid');
  assert(!config.onboardingDomains || (Array.isArray(config.onboardingDomains) && config.onboardingDomains.every(x => typeof x === 'string' && /^[a-z][a-z0-9.-]+\.[a-z]{2,}$/.test(x))), 'onboarding_allowlist_invalid');
  assert(!config.interactiveAuthDomains || (Array.isArray(config.interactiveAuthDomains) && config.interactiveAuthDomains.every(x => (config.onboardingDomains || []).includes(x))), 'interactive_auth_allowlist_invalid');
  assert(Array.isArray(config.resourceDomains) && config.resourceDomains.every(x => typeof x === 'string' && /^[a-z0-9.-]+$/.test(x)), 'resource_allowlist_invalid');
  assert(allowedUrl(config.editorUrl, config.navigationDomains, { navigation: true }), 'editor_url_not_allowed');
  assert(!config.mutationRoutes || (Array.isArray(config.mutationRoutes) && config.mutationRoutes.every(r => typeof r.host === 'string' && typeof r.path === 'string' && r.path.startsWith('/') && !r.path.includes('*') && Array.isArray(r.methods) && r.methods.every(m => ['POST','PUT','PATCH'].includes(m)) && ['read','onboarding','project','upload','trim','captions','copy','export'].includes(r.phase) && Array.isArray(r.contentTypes))), 'mutation_route_allowlist_invalid');
  assert(config.maxActions > 0 && config.maxActions <= 30 && config.maxRunMs > 0 && config.maxRunMs <= 20 * 60_000, 'job_budget_invalid');
  assert(config.maxModelCalls >= 0 && config.maxModelCalls <= 10, 'model_budget_invalid');
  assert(config.assets && typeof config.assets === 'object' && Array.isArray(config.styles), 'asset_or_style_config_invalid');
  return config;
}
