# Controller integration hook

The flywheel does not change browser execution. A controller opts in by
appending one record per decision.

## Option A — import the logger (Node)

```js
import { createDecisionLogger } from '/absolute/path/to/repo/agent/jev/evals/browser-routing/lib/logger.mjs';

const decisions = createDecisionLogger({
  dir: process.env.BROWSER_DECISION_LOG_DIR ?? './.browser-decisions',
  redact: true, // read-only context: never fail the job because a field looked secret
});

// immediately after a decision is made (before execution):
decisions.append({
  job_id: job.id,
  profile_id: job.profileRef,              // hashed to prof_<sha16> on write
  trajectory_id: job.id,                   // job/profile sequence; never crosses splits
  step: decision.step,
  timestamp: new Date().toISOString(),
  state: {
    text: observation.summary,
    page_class: `${platform}.${phase}.${stateClass}`,
    state_class: stateClass,
    url_class: observation.urlClass,       // origin + path; strip query
    normalized: { candidateCount, policy }, // no secrets
  },
  evidence: {
    screenshot: { path: capture.path, sha256: capture.sha256 }, // optional
  },
  candidates: candidates.map((candidate) => ({
    id: candidate.tool,
    description: candidate.description,
    risk: candidate.risk,
  })),
  chosen: decision.chosen?.tool ?? null,
  recommendations: {
    deterministic: { top1, top3, confidence, latency_ms },
    jev: jevCalled ? { top1, top3, confidence, latency_ms } : null,
    valen: null,                           // filled by the shadow runner
  },
  executed: { action, source, result },
  outcome: { status, verified, evidence },
  human_escalation: { kind: 'none', reason: null, raised_at: null, cleared_at: null, post_clear_verification: null },
  label_quality: 'AMBIGUOUS',              // upgraded later from the receipt
  label: undefined,                        // only high-quality records carry target_action
});
```

The logger validates the record, rejects secrets (or redacts in `redact: true`
mode), hashes the profile id and writes one canonical JSON line. It never throws
into the controller's execution path when `redact` is enabled.

## Option B — CLI append

```bash
node agent/jev/evals/browser-routing/cli/record.mjs <<'JSON'
{ ...same fields... }
JSON
```

(see `cli/record.mjs`)

## Promotion to a high-quality label

A controller should record `AMBIGUOUS` at decision time and let the receipt
upgrade it:

| evidence available | label |
|---|---|
| deterministic policy or receipt proves the exact required action | `CURATED_REQUIRED_ACTION` |
| executed action + independent postcondition/verification | `VERIFIED_SUCCESSFUL_ACTION` |
| recovery action + verified post-clear/postcondition | `VERIFIED_RECOVERY_ACTION` |
| security checkpoint raised, human cleared it, post-clear verified | `VERIFIED_HUMAN_ESCALATION` |
| executed with weak success signal | `OBSERVED_SUCCESSFUL_ACTION` |
| executed and failed | `FAILED_ACTION` |
| no defensible action | `AMBIGUOUS` |

Never write `CURATED_REQUIRED_ACTION`/`VERIFIED_*` without naming the evidence
(`label.basis` + `label.evidence_refs`).

## Security checkpoint states

For a genuine verification/CAPTCHA state:

- keep the normal evidence bundle and the redacted state;
- set `human_escalation.kind = 'security_checkpoint'` and
  `label.target_action = escalate_security_checkpoint`;
- record `raised_at`, `cleared_at` (when a human cleared it) and
  `post_clear_verification`;
- never add a solving candidate, answer or bypass path. The schema throws if one
  is present.
