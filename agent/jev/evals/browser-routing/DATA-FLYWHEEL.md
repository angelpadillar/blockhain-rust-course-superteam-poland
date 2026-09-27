# Browser decision data flywheel

Status: **implemented and tested** (2026-09-25). No live execution semantics were
changed; no Valen model was retrained; Valen remains shadow/advisory only.

Command surface (repo root):

| command | purpose |
|---|---|
| `npm run browser:flywheel:build` | ingest artifacts + live log → next immutable snapshot |
| `npm run browser:valen-readiness` | print the retraining gates |
| `npm run browser:valen-shadow` | run Valen in shadow over a snapshot (advisory only) |
| `npm run test:browser:flywheel` | 29 unit tests (schema, secrets, labels, dedupe, splits, snapshots, readiness, shadow) |

## What "a decision" is

`lib/schema.mjs` defines `buena.browser-decision.record/1`. Each record carries
job id, pseudonymous profile id (`prof_<hash>`), trajectory id, timestamp,
normalized state + page/state class, screenshot/evidence pointer, candidate
actions, deterministic recommendation, JEV recommendation, Valen shadow
recommendation, executed action + source, result, verification/postcondition,
recovery step, confidence, latency and human escalation. Secrets are rejected
(keys like `cookie`/`token`/`password`/`proxy_url`; values like Discord webhook
URLs, bearer tokens, `op://` references, private keys, JWTs) unless the ingester
explicitly redacts a read-only source, in which case the redaction path is
recorded on the record.

## Label quality

`CURATED_REQUIRED_ACTION`, `VERIFIED_SUCCESSFUL_ACTION`,
`VERIFIED_RECOVERY_ACTION`, `VERIFIED_HUMAN_ESCALATION` are the only labels that
automatically qualify for fine-tuning. `OBSERVED_SUCCESSFUL_ACTION`,
`AMBIGUOUS` and `FAILED_ACTION` are retained for diagnostics and negatives but
never promoted. High-quality labels must name a `target_action` that is in the
candidate set; non-high-quality records carry `attempted_action` instead, so a
failed attempt can never masquerade as the correct answer.

## Security / human checkpoints

- Zero genuine security-checkpoint frames exist in today's artifacts; the
  flywheel records `SECURITY_EXAMPLES=0` and blocks retraining.
- When a legitimate Google/YouTube verification or CAPTCHA state appears, the
  record's only permitted target is `escalate_security_checkpoint` (or
  `escalate_to_human`). `assertSecurityPolicy` throws on any record that targets
  a solving action or contains a `solve/bypass/captcha_answer` candidate.
- No challenge is ever solved, generated, outsourced or deliberately triggered.
  The escalation record stores the evidence bundle, the redacted state, the
  human-clear timestamp and the post-clear verification result.
- Capture path for those frames is the existing safe-capture bundle
  (`agent/multilogin/src/screenshots.mjs`): credential-origin masking,
  settle/min-byte gates, viewport + optional region + context sidecar.

## Near-duplicate control

`lib/dedupe.mjs` computes a 64-bit dHash per image (ImageMagick) and a state
fingerprint for text-only decisions. Exact SHA-256 always clusters; dHash
Hamming distance ≤ 4 clusters within the same page family; identical state
fingerprints cluster. Representatives are chosen by label quality, verification,
then capture time; every duplicate keeps `near_duplicate_of`. Meaningful
transitions (different page class / action) stay separate. Only representatives
enter valid/test; duplicates are train-only when their representative is in
train, and cross-trajectory duplicates are excluded entirely.

## Splits and the immutable test set

- Trajectory-atomic: a job/profile sequence never crosses splits.
- `registry/heldout.json` freezes every assignment on the first snapshot.
  Later snapshots may add new trajectories but can never move a frozen one.
- Each snapshot re-checks the previous snapshot's test decisions and refuses to
  build if a former test trajectory changed split.
- `splits.json` records the canonical split ids, train-only duplicates and a
  leakage report (sha256 / trajectory / duplicate-in-eval crossings must be 0).

## Versioning

`registry/snapshots/browser-decision-vNNN/` contains `manifest.json`,
`decisions.jsonl`, `records.canonical.jsonl`, `record-hashes.json`,
`image-hashes.json`, `splits.json`, `label-quality.json` and the staged images.
Snapshots are immutable; the index is append-only. `.gitignore` keeps raw
screenshots and live logs local; manifests, records and hashes are text and
commit-ready. Every snapshot records the source checkout, source commit (when
available), creation timestamp and tool version; no secrets.

## Shadow mode

`VALEN_MODE=off|shadow`.

- `off`: no network call.
- `shadow`: screenshot + bounded state + candidates → zero-shot Valen endpoint.
  Only `top1`, `top3`, `confidence`, `latency_ms` are recorded. Every
  recommendation carries `executable: false`; no code path returns a dispatchable
  action. `Buena-Valen-Browser-v0` is never used (it failed acceptance).
- `npm run browser:valen-shadow -- --split test --limit 20` writes
  `registry/shadow/<snapshot>-<timestamp>.json` with the comparison table.

Comparison metrics (per scorer): top-1 agreement, top-3 required-action recall,
confidence, p50/p95 latency, false human escalation, missed human escalation.
Rows are computed only against high-quality labels. `self_recorded_count`
separates "the scorer decided this action itself" (circular for accuracy) from
`independent_top1_accuracy` (the scorer was not the executor).

### Measured shadow pass (snapshot v001, zero-shot Valen, 2026-09-25)

119/119 endpoint calls succeeded; every recommendation recorded with
`executable: false`. Result file:
`registry/shadow/browser-decision-v001-2026-09-25T12-40-56-640Z.json`.

| scorer | top-1 | top-3 recall | confidence | p50 | p95 | false esc. | missed esc. | n | self | independent |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| deterministic | 100.0% | 100.0% | n/a | n/a | n/a | 0 | 0 | 12 | 12 | 0 |
| JEV | 100.0% | 100.0% | 0.72 | n/a | n/a | 0 | 0 | 7 | 7 | 0 |
| Valen zero-shot | 10.5% | **73.7%** | 0.43 | 837 ms | 1877 ms | 0 | 0 | 19 | 0 | 19 |

Reading: deterministic/JEV rows are recorded decision-maker agreement and are
circular (each scored its own executions). Valen is the only independent
predictor: weak top-1 (2/19), usable top-3 candidate recall (14/19), no false
escalations, and zero escalation targets so missed-escalation remains
unmeasurable. The failures are dominated by the Sokoban-specialised head
preferring `blocked`/`inspect_evidence` on form/trust candidates.

## Current corpus (snapshot browser-decision-v001)

| metric | value |
|---|---:|
| TOTAL_DECISIONS | 368 |
| canonical (deduplicated) | 313 |
| NEAR_DUPLICATES_REMOVED | 55 |
| CURATED_REQUIRED_ACTION | 59 |
| VERIFIED_SUCCESSFUL_ACTION | 89 |
| OBSERVED_SUCCESSFUL_ACTION | 85 |
| FAILED_ACTION | 106 |
| AMBIGUOUS | 29 |
| SECURITY_EXAMPLES | 0 |
| PAGE_FAMILIES | 21 |
| splits (train/valid/test, canonical) | 188 / 63 / 62 |
| leakage | clean (0 crossings) |
| with images | 49 |

Sources: live router observations (3), trust validation runs (50), trust demo
accept/reject (8), agent/out altitude + Glovo (7), JEV benchmark decisions (296),
captions-editor states (4).

## Readiness — current output

```
TOTAL_DECISIONS=368
HIGH_QUALITY_TRAIN=45
STRICT_HELDOUT=26
PAGE_FAMILIES=11
SECURITY_EXAMPLES=0
FAILED_ACTION_NEGATIVES=101
NEAR_DUPLICATES_REMOVED=55
READY_TO_RETRAIN=false
EXACT_NEXT_RETRAIN_THRESHOLD=STRICT_HELDOUT >= 100 (have 26; +74)
```

Gates: `STRICT_HELDOUT >= 100`, `HIGH_QUALITY_TRAIN >= 500`,
`PAGE_FAMILIES >= 5`, `SECURITY_EXAMPLES >= 1`,
`FAILED_ACTION_NEGATIVES >= 25`, zero leakage. Retraining also requires an
explicit decision — readiness alone does not start anything.

Note on composition: most VERIFIED decisions currently come from the isolated
JEV benchmark (text-only form decisions with independent verdicts). They are
valid browser decisions but carry no screenshots, so the vision-relevant strict
held-out count is smaller than 26. The next collection priority is
receipt-verified decisions from the live browser controller across independent
page families.

## Integration seam (no browser-repo change required)

A controller writes records with the logger or the CLI:

```js
import { createDecisionLogger } from '<repo>/agent/jev/evals/browser-routing/lib/logger.mjs';
const logger = createDecisionLogger({ dir: process.env.BROWSER_DECISION_LOG_DIR ?? '.browser-decisions', redact: true });
logger.append({
  job_id, profile_id,            // raw id is hashed by the logger
  trajectory_id, step, timestamp,
  state: { text, page_class, state_class, url_class, normalized }, // no secrets
  evidence: { screenshot: { path, sha256 } },
  candidates, chosen,
  recommendations: { deterministic, jev },
  executed: { action, source, result },
  outcome: { status, verified, evidence },
  human_escalation: { kind: 'none' },
  label_quality, label,
});
```

`npm run browser:flywheel:build` then ingests `decisions/decisions-v1.ndjson`
plus the read-only artifact sources into the next snapshot. See
`integration/controller-hook.md`.

## Explicit non-goals

- No live execution changes; Valen never executes; no automatic retraining.
- No CAPTCHA solving, no challenge generation, no challenge outsourcing, no
  deliberate challenge triggering.
- No secrets, cookies, tokens, proxy credentials or webhook URLs in the corpus.
