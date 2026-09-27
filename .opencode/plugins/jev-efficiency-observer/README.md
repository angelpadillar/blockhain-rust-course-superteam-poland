# jev-efficiency-observer

Observe-and-apply OpenCode V2 adapter over the Agent Efficiency Runtime v1.
Thin adapter: all logic lives in `runtime/` (built to `runtime/dist`).

**Version:** plugin `1.0.0` · runtime `1.0.0` · build `jev-aer-v1-20260925` ·
policy `safe` (see `reports/runtime/AGENT-EFFICIENCY-V1.md`).

## Presets and control

```bash
node .opencode/plugins/jev-efficiency-observer/control.mjs status
node .opencode/plugins/jev-efficiency-observer/control.mjs preset safe                  # production
node .opencode/plugins/jev-efficiency-observer/control.mjs preset observe               # telemetry only
node .opencode/plugins/jev-efficiency-observer/control.mjs preset off                   # zero changes
node .opencode/plugins/jev-efficiency-observer/control.mjs preset experimental-gateway  # keep `shell` in lane
node .opencode/plugins/jev-efficiency-observer/control.mjs preset list
```

Config file: `<project>/.opencode/jev-efficiency.json` (project-local only; global
OpenCode settings are never touched). Precedence: plugin options → `JEV_OBSERVER_*`
env → project config → observe defaults.

## What the `safe` preset does

| setting | value | effect |
|---|---|---|
| `resultAdmissionMode` | `deterministic` | reduces large/duplicate tool results in the **model-bound** messages only; canonical history untouched; fail-open |
| `shortlistMode` | `soft` | reorders preferred tools first and adds one hint; nothing removed |
| `toolExposureMode` | `off` | all tool schemas are sent |
| `routerMode` | `observe` | AUTO/CLM/JEV proposals are recorded, never applied |

## Fail-open guarantees

Classifier, reducer, evidence-store, projection-validation and message-shape
errors all preserve the original result, record a `projection_fallback` /
`classifier_fallback` telemetry record, and never break the session.

## Evidence retention

Content-addressed dedupe is built in. The store is session-scoped; retention is
bounded with `evidenceMaxEntries` (default 2000), `evidenceMaxAgeMs` (optional)
and `evidencePruneDryRun` (test-only), and never removes evidence still
referenced by a recent model projection (`evidence_pruned` telemetry records
what happened). No on-disk benchmark evidence is touched.

## Telemetry

`<location>/.jev-efficiency/telemetry.jsonl` plus a compact `summary.json`.
Every record carries `runtimeVersion`, `pluginVersion`, `policyPreset` and
`gitCommit` so future passive telemetry stays comparable. Passive summary:

```bash
npm run efficiency:report -- --last 50 --since 2026-09-20 [--provider-usage] [--json]
```

## Invariants

- Canonical persisted conversation history is never modified.
- HARD tool filtering does not exist in v1.
- AUTO/CLM/JEV never select a real action.
- The lazy gateway is experimental and only allowed with `shell` in the lane.
