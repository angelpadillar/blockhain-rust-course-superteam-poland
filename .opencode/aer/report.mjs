#!/usr/bin/env node
/**
 * aer-report — passive AER telemetry report for one OpenCode project.
 *
 * Reads <project>/.jev-efficiency/telemetry.jsonl (append-only, written by the
 * frozen AER v1 plugin). No synthetic runs, no provider calls unless
 * --provider-usage asks `opencode session export` for token totals.
 *
 *   node .opencode/aer/report.mjs [project] [--last 50] [--since 2026-09-20]
 *                                 [--provider-usage] [--json]
 *
 * Unknown values stay null; nothing is reported as a fake zero.
 */

import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';

const argv = process.argv.slice(2);
const arg = (name, fallback = null) => {
  const i = argv.indexOf(name);
  return i === -1 ? fallback : argv[i + 1];
};
const flag = (name) => argv.includes(name);

const positional = argv.filter((value, index) => !value.startsWith('--') && !(index > 0 && argv[index - 1]?.startsWith('--')));
const PROJECT = resolve(positional[0] ?? process.cwd());
const LAST = Number(arg('--last', '10'));
const SINCE = arg('--since');
const WITH_USAGE = flag('--provider-usage');
const JSON_OUT = flag('--json');

const FILE = join(PROJECT, '.jev-efficiency', 'telemetry.jsonl');
if (!existsSync(FILE)) {
  console.error(`no telemetry file at ${FILE}`);
  console.error('AER telemetry appears after the plugin has observed real sessions in this project');
  process.exit(1);
}

const num = (value) => (Number.isFinite(value) ? value : null);
const sum = (values) => {
  const v = values.filter(Number.isFinite);
  return v.length ? v.reduce((a, b) => a + b, 0) : null;
};

const records = readFileSync(FILE, 'utf8')
  .split('\n')
  .filter(Boolean)
  .map((line) => {
    try { return JSON.parse(line); } catch { return null; }
  })
  .filter(Boolean);

const sessions = new Map();
for (const record of records) {
  const id = typeof record.sessionID === 'string' && record.sessionID ? record.sessionID : 'unscoped';
  if (!sessions.has(id)) sessions.set(id, []);
  sessions.get(id).push(record);
}

// Frozen price table used by the AER runtime (deepseek-v4p1 class); kept here so
// provider usage can be compared against the same baseline.
const FROZEN_PRICES = { uncachedInputPerM: 0.22, cachedInputPerM: 0.007, outputPerM: 0.66 };

function providerUsage(sessionId) {
  if (!WITH_USAGE || sessionId === 'unscoped') return null;
  const out = spawnSync('opencode', ['session', 'export', sessionId], { cwd: PROJECT, encoding: 'utf8', timeout: 60_000, maxBuffer: 128 * 1024 * 1024 });
  if (out.status !== 0 || !out.stdout) return null;
  try {
    const doc = JSON.parse(out.stdout);
    const tokens = doc?.info?.tokens;
    if (!tokens || !Number.isFinite(tokens.input) || !Number.isFinite(tokens.output)) return null;
    const cached = num(tokens.cache?.read) ?? 0;
    return {
      sessionID: sessionId,
      inputTokens: tokens.input,
      cachedInputTokens: cached,
      outputTokens: tokens.output,
      reasoningTokens: num(tokens.reasoning),
      costUsd: num(doc?.info?.cost),
      derivedFrozenCostUsd: (tokens.input * FROZEN_PRICES.uncachedInputPerM + cached * FROZEN_PRICES.cachedInputPerM + tokens.output * FROZEN_PRICES.outputPerM) / 1e6,
    };
  } catch {
    return null;
  }
}

function summarize(id, rs) {
  const turns = rs.filter((r) => r.kind === 'turn');
  const toolCalls = rs.filter((r) => r.kind === 'tool_call');
  const toolResults = rs.filter((r) => r.kind === 'tool_result');
  const projected = turns.filter((t) => t.resultProjectionApplied === true);
  const loaded = rs.find((r) => r.kind === 'loaded');
  const firstAt = rs[0]?.at ?? null;
  const lastAt = rs.at(-1)?.at ?? null;
  return {
    sessionID: id,
    firstAt,
    lastAt,
    turns: turns.length,
    toolCalls: toolCalls.length,
    toolResults: toolResults.length,
    resultsReducible: toolResults.filter((r) => r.wouldReduce === true).length,
    projectedResults: projected.reduce((acc, t) => acc + (Array.isArray(t.resultProjectionRecords) ? t.resultProjectionRecords.length : 0), 0),
    resultTokensAvoided: sum(turns.map((t) => t.resultTokensAvoided)),
    routerObservations: turns.filter((t) => Array.isArray(t.proposedRankedTools)).length,
    fallbacks: rs.filter((r) => r.kind === 'classifier_fallback' || r.kind === 'projection_fallback').length,
    errors: rs.filter((r) => r.kind === 'error').length,
    preset: loaded?.policyPreset ?? null,
    build: loaded?.runtimeBuildId ?? null,
    resultAdmissionMode: loaded?.resultAdmissionMode ?? null,
    toolExposureMode: loaded?.toolExposureMode ?? null,
    routerMode: loaded?.routerMode ?? null,
    usage: providerUsage(id),
  };
}

const list = [...sessions.entries()]
  .map(([id, rs]) => summarize(id, rs))
  .filter((session) => session.turns > 0)
  .filter((session) => (SINCE ? session.firstAt && new Date(session.firstAt).getTime() >= new Date(SINCE).getTime() : true))
  .sort((a, b) => new Date(b.firstAt ?? 0).getTime() - new Date(a.firstAt ?? 0).getTime())
  .slice(0, Number.isFinite(LAST) && LAST > 0 ? LAST : undefined);

if (JSON_OUT) {
  console.log(JSON.stringify({ project: PROJECT, file: FILE, last: LAST, sessions: list }, null, 2));
} else {
  console.log(`project: ${PROJECT}`);
  console.log(`telemetry: ${FILE}`);
  console.log(`window: last=${LAST}${SINCE ? ` since=${SINCE}` : ''}${WITH_USAGE ? ' provider-usage=on' : ''}`);
  console.log('');
  const header = ['session', 'first (utc)', 'turns', 'tools', 'results', 'projected', 'tokensAvoided', 'routerObs', 'fallbacks', 'errors', 'preset'];
  console.log(header.join('\t'));
  for (const session of list) {
    console.log([
      session.sessionID.slice(0, 18),
      session.firstAt ?? '-',
      session.turns,
      session.toolCalls,
      session.toolResults,
      session.projectedResults,
      session.resultTokensAvoided ?? '-',
      session.routerObservations,
      session.fallbacks,
      session.errors,
      session.preset ?? '-',
    ].join('\t'));
  }
  if (WITH_USAGE) {
    console.log('');
    console.log(['session', 'input', 'cached', 'output', 'costUsd', 'frozenPriceCost'].join('\t'));
    for (const session of list) {
      if (!session.usage) continue;
      console.log([
        session.sessionID.slice(0, 18),
        session.usage.inputTokens,
        session.usage.cachedInputTokens,
        session.usage.outputTokens,
        session.usage.costUsd ?? '-',
        Number(session.usage.derivedFrozenCostUsd.toFixed(6)),
      ].join('\t'));
    }
  }
}
