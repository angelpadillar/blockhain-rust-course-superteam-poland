import { mkdir, open, readFile, stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { requireThat } from './core.mjs';

// G2: the frontier cost ledger. Bounded private NDJSON, one line per provider call.
// It never contains prompt contents or screenshot bytes - only metadata, the
// provider's reported usage and the derived estimate.
export const ledgerName = 'frontier-metrics.ndjson';
export const maxLedgerBytes = 4 * 1024 * 1024;

export function createFrontierLedger({ directory, file = ledgerName, maxBytes = maxLedgerBytes,
  fsync = false } = {}) {
  requireThat(typeof directory === 'string' && directory.length > 0, 'ledger_directory_required');
  const path = resolve(directory, file);
  const ready = mkdir(dirname(path), { recursive: true, mode: 0o700 });
  return {
    path,
    async record(metric) {
      requireThat(metric && typeof metric === 'object', 'invalid_metric');
      // Defensive: a ledger entry may never carry page or image content.
      const entry = { ...metric };
      delete entry.prompt; delete entry.text; delete entry.screenshot; delete entry.image;
      delete entry.base64; delete entry.contents;
      await ready;
      const line = `${JSON.stringify(entry)}\n`;
      if (Buffer.byteLength(line) > 8000) return entry;   // a bounded entry or nothing
      // Bounded: past the cap the oldest content is dropped so a long run cannot
      // grow without limit. The newest entry is what an operator needs.
      const size = await stat(path).then(info => info.size).catch(() => 0);
      if (size > maxBytes) await open(path, 'w', 0o600).then(handle => handle.close());
      const handle = await open(path, 'a', 0o600);
      try { await handle.writeFile(line); if (fsync) await handle.sync(); } finally { await handle.close(); }
      return entry;
    },
    async entries() {
      await ready;
      let text;
      try { text = await readFile(path, 'utf8'); }
      catch (error) { if (error.code === 'ENOENT') return []; throw error; }
      const out = [];
      for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        try { out.push(JSON.parse(line)); } catch { continue; }
      }
      return out;
    },
  };
}

function percentile(values, fraction) {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1));
  return sorted[index];
}

// Aggregates the report needs. Counts are exact; ratios are null when undefined
// rather than a misleading zero.
export function summarizeFrontierMetrics(entries = [], { jobs = 1, completedTasks = 1 } = {}) {
  const calls = entries.length;
  const cost = entries.reduce((total, entry) => total + (Number.isFinite(entry.estimatedUsd) ? entry.estimatedUsd : 0), 0);
  const latencies = entries.map(entry => entry.latencyMs).filter(Number.isFinite);
  const withUsage = entries.filter(entry => entry.usageSource === 'provider');
  const inputTokens = withUsage.reduce((total, entry) => total + (entry.uncachedInputTokens || 0), 0);
  const cachedTokens = withUsage.reduce((total, entry) => total + (entry.cachedInputTokens || 0), 0);
  const outputTokens = withUsage.reduce((total, entry) => total + (entry.outputTokens || 0), 0);
  const recoveries = entries.filter(entry => entry.postconditionSuccess === true);
  const attempted = entries.filter(entry => entry.policy === 'accepted' && entry.decision === 'action');
  return {
    calls,
    callsPerJob: jobs ? Math.round((calls / jobs) * 100) / 100 : null,
    estimatedUsdTotal: Math.round(cost * 1e6) / 1e6,
    estimatedUsdPerJob: jobs ? Math.round((cost / jobs) * 1e6) / 1e6 : null,
    estimatedUsdPerRecovery: recoveries.length ? Math.round((cost / recoveries.length) * 1e6) / 1e6 : null,
    estimatedUsdPerCompletedTask: completedTasks ? Math.round((cost / completedTasks) * 1e6) / 1e6 : null,
    recoveryRate: attempted.length ? Math.round((recoveries.length / attempted.length) * 1000) / 1000 : null,
    abstainRate: calls ? Math.round((entries.filter(entry => entry.decision === 'abstain').length / calls) * 1000) / 1000 : null,
    jobsReachingL3: new Set(entries.map(entry => entry.jobId).filter(Boolean)).size,
    jobsReachingL3Percentage: jobs ? Math.round((new Set(entries.map(entry => entry.jobId).filter(Boolean)).size / jobs) * 1000) / 1000 : null,
    latencyMeanMs: latencies.length ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length) : null,
    latencyP50Ms: percentile(latencies, 0.5),
    latencyP95Ms: percentile(latencies, 0.95),
    usageReported: withUsage.length,
    uncachedInputTokens: inputTokens, cachedInputTokens: cachedTokens, outputTokens,
    triggers: entries.reduce((counts, entry) => {
      const key = entry.trigger || 'unspecified';
      counts[key] = (counts[key] || 0) + 1;
      return counts;
    }, {}),
  };
}
