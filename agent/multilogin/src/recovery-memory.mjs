import { randomUUID } from 'node:crypto';
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { requireThat } from './core.mjs';

// Causal recovery memory. It stores COMPACT episodes, never transcripts:
//
//   STATE        Google post-auth redirect landed on an unexpected screen
//   FAILED ACTION  reopening the account menu did not change the state
//   CORRECTION   navigate to the platform home, then reopen the account switcher
//   VERIFICATION login was verified and the session survived a restart
//
// A recall returns only a few episodes relevant to the current state, so a model
// sees a short hint, not a memory dump. Nothing here records page text, control
// labels, credentials, codes, query strings or screenshots.
export const recoveryMemoryVersion = 1;
export const maxRecalledEpisodes = 3;

const normalize = value => String(value || '').toLowerCase().replace(/[^a-z0-9_:/.-]+/g, ' ').trim();
const tokens = value => new Set(normalize(value).split(/\s+/)
  .filter(token => token.length > 2 && token !== 'null' && token !== 'undefined'));

// A page is identified by origin+pathname, never by query string or full url, so
// a recovery hint cannot leak an auth parameter.
export function memoryStateFor({ url = null, classifiedReason = null } = {}) {
  let path = null;
  try { const parsed = new URL(url); path = `${parsed.origin}${parsed.pathname}`; } catch {}
  return { reason: classifiedReason || 'unexpected_state', path };
}

export function createRecoveryMemory({ directory, maxEpisodes = 200, now = Date.now } = {}) {
  requireThat(typeof directory === 'string' && directory.length > 0, 'memory_directory_required');
  const path = resolve(directory, 'recovery-memory.ndjson');
  const inMemory = [];
  const sessionEpisodeIds = [];

  const score = (episode, query) => {
    let value = 0;
    if (query.reason && episode.reason === query.reason) value += 4;
    if (query.path && episode.statePath && episode.statePath === query.path) value += 3;
    if (query.failedAction && episode.failedAction === query.failedAction) value += 2;
    const queryTokens = tokens([query.reason, query.path, query.failedAction].filter(Boolean).join(' '));
    const episodeTokens = tokens([episode.reason, episode.statePath, episode.failedAction, episode.correction]
      .filter(Boolean).join(' '));
    for (const token of episodeTokens) if (queryTokens.has(token)) value += 1;
    if (episode.verification === 'login_verified') value += 2;
    else if (episode.verification === 'page_changed') value += 1;
    return value;
  };

  return {
    version: recoveryMemoryVersion,
    path,
    // Only whitelisted fields are ever written. An unknown field is dropped, not
    // redacted, so a future caller cannot accidentally persist page content.
    async record(episode = {}) {
      const entry = { id: randomUUID(), at: new Date(now()).toISOString(),
        reason: String(episode.reason || 'unexpected_state').slice(0, 120),
        statePath: episode.statePath ? String(episode.statePath).slice(0, 300) : null,
        failedAction: episode.failedAction ? String(episode.failedAction).slice(0, 60) : null,
        correction: episode.correction ? String(episode.correction).slice(0, 60) : null,
        verification: ['page_changed', 'flow_advanced', 'login_verified', 'unverified'].includes(episode.verification)
          ? episode.verification : 'unverified',
        platform: episode.platform ? String(episode.platform).slice(0, 32) : null,
        jobId: episode.jobId ? String(episode.jobId).slice(0, 64) : null };
      requireThat(entry.correction || entry.failedAction, 'memory_episode_requires_action');
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await appendFile(path, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
      inMemory.push(entry);
      sessionEpisodeIds.push(entry.id);
      if (inMemory.length > maxEpisodes) inMemory.shift();
      return entry;
    },
    // A few relevant episodes, most relevant first. `limit` is bounded so a
    // caller can never ask for a full dump.
    async recall({ reason = null, url = null, failedAction = null, limit = 2 } = {}) {
      const state = memoryStateFor({ url, classifiedReason: reason });
      const query = { reason: state.reason, path: state.path, failedAction };
      const recent = await this.all();
      return recent
        .map(episode => ({ episode, value: score(episode, query) }))
        .filter(entry => entry.value > 0)
        .sort((left, right) => right.value - left.value || String(right.episode.at).localeCompare(String(left.episode.at)))
        .slice(0, Math.max(1, Math.min(limit, maxRecalledEpisodes)))
        .map(entry => ({ reason: entry.episode.reason, statePath: entry.episode.statePath,
          failedAction: entry.episode.failedAction, correction: entry.episode.correction,
          verification: entry.episode.verification }));
    },
    // The compact model-facing shape: a short hint list, never episode ids.
    async hints(options = {}) {
      return (await this.recall(options)).map(episode =>
        `${episode.reason}${episode.statePath ? ` at ${episode.statePath}` : ''}: `
        + `${episode.failedAction ? `${episode.failedAction} did not change it; ` : ''}`
        + `${episode.correction}${episode.verification === 'login_verified' ? ' (verified)' : ''}`);
    },
    async all() {
      let text = null;
      try { text = await readFile(path, 'utf8'); } catch { /* a fresh store has no file yet */ }
      if (text === null) return [...inMemory];
      const parsed = [];
      for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        try { parsed.push(JSON.parse(line)); } catch { /* a torn last line is skipped */ }
      }
      return parsed.slice(-maxEpisodes);
    },
    // The run verified the identity: the episodes that unstuck this session are
    // upgraded, so a later recall prefers corrections that actually held.
    async markVerified() {
      if (!sessionEpisodeIds.length) return 0;
      const all = await this.all();
      const ids = new Set(sessionEpisodeIds);
      let count = 0;
      for (const episode of all) {
        if (!ids.has(episode.id) || episode.verification === 'login_verified') continue;
        await appendFile(path, `${JSON.stringify({ ...episode, verification: 'login_verified',
          verifiedAt: new Date(now()).toISOString() })}\n`, { mode: 0o600 });
        count++;
      }
      return count;
    },
  };
}
