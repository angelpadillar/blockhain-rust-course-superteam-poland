# Browser runtime handoff — 2026-09-25

## CURRENT_BRANCH
`browser/single-command-job` in the worktree
`/Users/buena/Code/blockchain-rust-superteam-poland-browser` (the original
worktree stays on `devin/browser-runtime-v5` with its uncommitted Delio and v6
bench work untouched).

## CURRENT_HEAD
`efc4ef5` (plus this handoff commit). Branch base: `54ae7a2`
(`browser/frontier-human-loop`, 6 commits ahead of `origin/main`).

## FILES_CHANGED (54ae7a2..HEAD)
Added: `job-runner.mjs`, `scripts/job.mjs`, `src/{lifecycle,orchestrator,recovery-memory,action-router,dialog-containment}.mjs`,
`test/{lifecycle,orchestrator,orchestrator.e2e,screenshot-bundle,recovery-memory,action-router,dialog-containment}*.mjs`,
`test/fixtures/fake-backend.mjs`, `PROXY-403-DIAGNOSIS.md`, `REAL-RUN-2026-09-25.md`,
`jobs/{youtube-live-01,youtube-live-05,youtube-live-batch}.example.json`.
Modified: `screenshots.mjs` (bundle + ported gates), `jobs.mjs`, `human-checkpoint.mjs`,
`login.mjs` (recovery memory, dialog guard, phase/step in chooser requests),
`recovery.mjs`, `runner.mjs` (degrated proxy mode), `multilogin.mjs` (`profileMeta`),
`batch-runner.mjs` (package-relative defaults), `Dockerfile`, `README.md`,
root `package.json` (`browser:job`, `browser:batch`, test scripts), `.gitignore`.

## VPS_ONLY_UNCOMMITTED_FILES
`/opt/buena-multilogin-canary/src` (39 files, newer than any git branch):
`checkpoint-controller.mjs`, `checkpoint-visibility.mjs`,
`checkpoint-annotation.mjs`, `checkpoint-annotation-loop.mjs`,
`checkpoint-challenge.mjs`, `checkpoint-command-queue.mjs`,
`checkpoint-job.mjs`, `checkpoint-keyboard.mjs`, `annotation-record.mjs`,
`diagnostics.mjs`, `dialog-containment.mjs`, plus canary test files
(`checkpoint-*.test.mjs`). The canary's Telegram tile-selection controller was
deliberately NOT ported; its visibility/stability gates and the dialog guard were
ported into this branch with attribution.
Also present and untouched: `/opt/buena-multilogin` (older deployment + backups),
`/opt/buena-multilogin-takeover`, `/opt/buena-multilogin-orchestrator` (this
branch, bind-mounted over the running worker image; not a service).
The original macOS worktree still holds the uncommitted v6 kernel/benchmark
iteration (`agent/jev/bench/`, `agent/jev/experimental/browser-runtime-v6/`,
`agent/jev/tests/kernel-v6.test.mjs`, `benchmarks/browser-runtime-v6/REPORT.md`).

## YT_LIVE_01_STATUS / _02 / _03
success (verified login, verified reopen, authenticated Studio, Studio verified
after restart), profiles `ab6f81fa-…f77f`, `6b70961b-…a4df`, `8ecd7ee4-…722c`.
Currently stopped; 01 and 02 carry a `validate_proxy_error` marker from the
2026-09-25 start attempts (no browser was launched).

## YT_LIVE_04_STATUS
`waiting_for_human`, reason `human_checkpoint_timeout`, checkpoint expired
2026-09-23T20:18Z. Login not verified; the challenge was never answered
automatically. Profile `9888f708-…a4c9` preserved, stopped. Needs a human
clearance once proxy validation works again.

## YT_LIVE_05_STATUS
`cancelled` by the operator (not failed, not replaced). Profile `e86dc95e-…8256`
preserved, stopped.

## PROXY_403_ROOT_CAUSE
`PLAN_OR_QUOTA`. The exact response from
`GET /proxynm/connection_url?country=pl&protocol=socks5&session_type=sticky&count=1`
is HTTP 403 with `error_code=PROXY_TRAFFIC_EXHAUSTED`,
`message="proxy traffic balance exhausted"`. Read endpoints
(`/workspace/folders`, `/profile/metas`, launcher version/status) work with the
same token, and the endpoint shape is current (missing `country` returns
`BAD_REQUEST_VALUES`). The launcher's own proxy IP check
(`socks … ->proxy.multilogin.com:443: connection not allowed by ruleset`) fails
for every profile as a consequence, so profile start returns 400
`validate_proxy_error`. No profile was modified and no proxy was rotated. Full
evidence: `PROXY-403-DIAGNOSIS.md`.

## PROXY_REUSE_MODE_STATUS
Implemented and live-exercised: `--reuse-existing-proxy` (or
`reuseExistingProxy: true` in config) proves from read-only `/profile/metas` that
the profile carries a proxy (`proxy_masking: custom`), then refuses every
provisioning/rotation path. On the real run for youtube-live-01 (2026-09-25) it
verified the attachment (`verifiedAttached: true`), the launcher refused with
`proxy_connection_failed`, and the run failed closed with `rotations: 0`,
no browser started, no credential submitted. Never falls back to no proxy.
Tests cover: no `premiumProxy`/`changeProxy` calls, fail-closed reason, refusal to
create a profile, and metadata refusals (missing proxy / disabled masking).

## SCREENSHOT_PIPELINE_STATUS
One canonical pipeline: canonical native viewport PNG (bytes untouched) +
`-full.png` + focused `-region.png` + `-context.json` (origin+path URL, title,
redacted visible text, viewport, devicePixelRatio, timestamp, job/profile
identity). Telegram receives a `sendPhoto` preview plus the byte-identical PNG as
a `sendDocument`; the announce path selects the canonical frame only (bundle
sidecars excluded). Ported from the canary: `isRectVisibleInViewport`
(offscreen ≤ -1000 and panels < 100x100 are not panels) and a two-observation
stability gate (moving frames produce no crop), plus the stale-dialog guard
installed on the live login path. The canary's grid annotation/tile-selection
controller remains VPS-only; its `capture-check-original.png` crop is superseded
by `-region.png`. Integrity tests verify PNG signatures, 1280x720 canonical
dimensions, full-page height, offscreen/unstable/tiny rejection and redaction.

## JEV_RECOVERY_STATUS
Working and unchanged: `maxRecoverySteps = 8`, stall after 2 unchanged attempts,
confidence floor 0.8, typed capabilities executed through the single kernel with
receipts; Google/YouTube origins expanded while credentials stay restricted to
the Google auth origin.

## ACTION_ROUTER_OBSERVATION_STATUS
Observation mode is live: every chooser decision is wrapped
(`wrapGuideForObservation`) and written to
`<job>/router-observations.ndjson` with state class, candidate tool names (never
descriptions/page text), deterministic-first top candidate, agreement,
chosen method/confidence, source (deterministic/jev) and outcome
(dispatched/stale/failed). `executionChanged: false` is recorded on every
decision; the executor remains authoritative. No model call is added and the
router does not control any live action yet.

## MEMORY_OBSERVATION_STATUS
Telemetry only: `calls`, `considered`, `recalled`, `bytes`, `retrievalMs`,
`corrections`, `matched` and `lastRecallAt` on the memory store, surfaced in
`result.json`. `observeCorrection()` answers whether the correction that
eventually worked matched a recalled episode; matching episodes carry
`memoryMatched: true`. Injection is unchanged (max 2 compact hints, no
transcripts, no page text).

## TEST_COUNTS
- agent/multilogin unit: **217 pass / 0 fail**
- agent/multilogin browser (real headless Chrome fixtures): **29 pass / 0 fail**
- v6 kernel (original worktree, unchanged): **19 pass / 0 fail**
- fake-mode full lifecycle command (offline): `COMPLETE`, 0 model calls

## SAFE_NEXT_COMMAND
After the Multilogin proxy traffic balance is restored (operator-side):
```sh
npm run browser:job -- jobs/youtube-live-01.example.json --remote --build
```
This reopens the same authenticated profile, verifies auth, opens Studio,
restarts the profile, verifies persistence and completes. Keep
`--reuse-existing-proxy` available as the guarded fallback; never add
proxy-provisioning retries while the balance is exhausted. For youtube-live-04:
same command with a bounded `--human-checkpoint-seconds` and a person clearing
the challenge in the VNC browser.

## KNOWN_EXTERNAL_BLOCKERS
1. `PROXY_TRAFFIC_EXHAUSTED` (403) on premium-proxy provisioning + launcher
   proxy validation failure — blocks every live profile start. Operator action:
   top up the Multilogin proxy traffic balance or approve a replacement proxy
   entitlement. No code workaround exists or should be invented.
2. VPS canary checkpoint controller remains uncommitted and unreconciled; it must
   be diffed and merged deliberately (its gates and dialog guard are already
   ported, its Telegram tile flow is not).
3. Existing profiles 01/02 show a `validate_proxy_error` status marker from the
   safe attempts; it clears on the next successful launch and is not a profile
   defect.
