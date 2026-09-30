import { createHash } from 'node:crypto';
import { requireThat } from './core.mjs';

// Safe Multilogin profile labeling. The only label-like field the API exposes is
// the profile NAME (the metadata response has no note/tag/description field).
// A rename therefore has to carry the profile's own `parameters` object back
// byte-identically, and the result is verified by re-reading the profile:
// fingerprint, flags, storage and proxy must not move after the update.
export const profileNamePattern = /^[\x20-\x7E]{1,120}$/;

export function parametersDigest(parameters) {
  return createHash('sha256').update(JSON.stringify(parameters ?? null)).digest('hex');
}

export function proxyShapeOf(parameters) {
  const proxy = parameters?.proxy || null;
  if (!proxy) return null;
  return { type: proxy.type ?? null, port: proxy.port ?? null,
    masking: parameters?.flags?.proxy_masking ?? null };
}

export async function renameProfilePreservingConfiguration({ api, profileId, name, now = Date.now } = {}) {
  requireThat(api?.profileMeta && api?.updateProfile, 'profile_metadata_unavailable');
  requireThat(typeof profileId === 'string' && profileId.length >= 8, 'invalid_multilogin_id');
  requireThat(profileNamePattern.test(name), 'invalid_profile_name');
  const before = await api.profileMeta(profileId);
  requireThat(before, 'existing_profile_metadata_unavailable');
  requireThat(before.name !== name, 'profile_name_unchanged');
  const beforeDigest = parametersDigest(before.parameters);
  const beforeProxy = proxyShapeOf(before.parameters);
  await api.updateProfile({ profileId, name, autoUpdateCore: before.is_auto_update === true,
    parameters: before.parameters });
  const after = await api.profileMeta(profileId);
  requireThat(after, 'profile_metadata_missing_after_update');
  requireThat(after.name === name, 'profile_rename_not_applied');
  // Proxy shape first: a moved proxy is a distinct, more specific failure than a
  // generic parameters change (the digest also covers it).
  requireThat(JSON.stringify(proxyShapeOf(after.parameters)) === JSON.stringify(beforeProxy), 'profile_proxy_changed');
  requireThat(parametersDigest(after.parameters) === beforeDigest, 'profile_parameters_changed');
  return { profileId, name, previousName: before.name, parametersUnchanged: true, proxyUnchanged: true,
    parametersDigest: beforeDigest, at: new Date(now()).toISOString() };
}

// Apply the health labels from a report. Dry-run is the default for callers that
// pass `apply: false`; a failure on one profile never stops the others and never
// retries destructively.
export async function applyProfileLabels({ report, api, apply = false, now = Date.now } = {}) {
  requireThat(report?.profiles, 'health_report_required');
  const results = [];
  for (const record of report.profiles) {
    const name = record.label;
    const accountRef = record.accountRef || record.profileRef || null;
    if (!record.profileId) { results.push({ accountRef, action: 'skipped', reason: 'no_profile_id', name }); continue; }
    if (!apply) { results.push({ accountRef, profileId: record.profileId, action: 'would_rename', name,
      previousName: null, parametersUnchanged: null }); continue; }
    try {
      const renamed = await renameProfilePreservingConfiguration({ api, profileId: record.profileId, name, now });
      results.push({ accountRef, action: 'renamed', ...renamed });
    } catch (error) {
      results.push({ accountRef, profileId: record.profileId, action: 'failed', name,
        reason: error?.code || 'rename_failed' });
    }
  }
  return { applied: apply, results };
}
