# Browser-routing eval + data flywheel

Self-contained subsystem under `agent/jev/evals/browser-routing/`:

- `lib/schema.mjs` — record schema, secret guard, label taxonomy, security policy
- `lib/logger.mjs` — append-only decision logger (live seam)
- `lib/artifacts.mjs` — read-only ingesters for existing browser evidence
- `lib/dedupe.mjs` — dHash + state-fingerprint near-duplicate control
- `lib/splits.mjs` — trajectory-atomic splits, immutable held-out registry
- `lib/snapshot.mjs` — immutable versioned snapshots
- `lib/readiness.mjs` — retraining gates
- `lib/shadow.mjs` / `lib/compare.mjs` — Valen shadow mode + comparison
- `cli/` — `build`, `readiness`, `shadow`, `ingest`
- `test/` — 29 unit tests (`node --test`)
- `registry/` — held-out registry, snapshot index, snapshots, shadow results
- `decisions/` — live append-only log (created by the logger)
- `DATA-FLYWHEEL.md` — status and gates (the deliverable report)
- `integration/controller-hook.md` — how a controller writes decisions

## Commands

```bash
npm run browser:flywheel:build      # snapshot the current evidence
npm run browser:valen-readiness     # retraining gates
npm run browser:valen-shadow -- --dry-run --split test
VALEN_MODE=shadow VALEN_BASE_URL=... npm run browser:valen-shadow -- --split test --limit 20
npm run test:browser:flywheel
node agent/jev/evals/browser-routing/cli/ingest.mjs   # per-source counts
```

## Design guarantees

- Secrets fail closed; read-only ingesters redact and record the redaction path.
- High-quality labels only: curated/verified/recovery/human-escalation.
- Failed attempts are negatives, never targets.
- Security checkpoints may only teach escalation.
- Trajectory-atomic splits; the held-out test set is immutable.
- Valen is advisory only; recommendations are never executable.
- Snapshots are immutable and versioned; the index is append-only.
