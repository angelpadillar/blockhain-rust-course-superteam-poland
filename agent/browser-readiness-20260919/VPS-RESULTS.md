# VPS readiness improvement — deployed 19 September 2026

## Outcome

Deployed `buena-captions-editor-camoufox:0.1.29-9` and updated `/opt/buena-video-workflow/advance-editor.mjs`. New action requests use bounded readiness observations before selecting a permitted control. Existing action receipts, postcondition checks, account profile, network scope and cost controls are preserved.

The update addresses controls that appear or become enabled after the initial page load. It is not a faster model or a replacement browser. No local laptop browser, mouse, or keyboard was used during this VPS work.

## Server test results

Each successful workflow uploads a synthetic clip, fills a prompt, changes native and custom switches, applies a fixture edit, downloads an MP4, and verifies hash, 9:16 dimensions, duration and full ffmpeg decode. These are local synthetic browser fixtures with networking disabled, not new Captions AI edits.

| Control availability | Old path | Readiness path | Median successful duration, old → new |
| --- | --- | --- | --- |
| Immediate | 3/3 | 3/3 | 5.890 → 5.952 seconds |
| Delayed 800 ms | 0/3 | 3/3 | Old failed; new 6.544 seconds |
| Delayed 1,800 ms | 0/3 | 3/3 | Old failed; new 7.709 seconds |
| **Total** | **3/9** | **9/9** | Three repetitions of each condition |

All six old-path failures stopped before upload with `no_permitted_observed_control`. Every completed new-path run passed all 27 browser/media checks. Ordering alternated between repetitions. This deliberately exercises one timing failure mode; 9/9 does not establish a general production task-success rate.

An initial unmodified-image baseline also passed 3/3 workflows (27 checks each), median 5.522 seconds. A final proof on the exact promoted image passed all 27 checks with an 800 ms control delay. The successful synthetic MP4s and detailed browser receipts remain under `/data/captions-editor-bench/` on the VPS.

## What changed

- Added authenticated, internal-only `POST /select-ready`, accepting only a job ID and bounded observation wait budget.
- Kept one browser owner while observing readiness, checking the exact project and unchanged job definition each time.
- Missing or disabled controls can become ready without failing the workflow immediately. Driver errors, model abstentions, ambiguity errors, and uncertain mutations are not automatically retried.
- A unique exact match still makes zero Jev calls. All successful fixture selections used this path.
- The workflow helper consumes the fresh observation token returned with the selection, saving one client round trip versus separate snapshot and selection requests.
- Saved action requests are still replayed verbatim after uncertain transport. The read-only inspection and subscription checks are unchanged.

The observation-retry budget is five seconds by default, at most ten. An in-flight observation retains the driver's transport deadline; the budget is not a hard wall-clock process deadline.

## Validation and deployment

- 59 local adapter/selection regression tests passed.
- Six workflow-helper tests passed, including exact receipt reuse after a lost response.
- 33 coordinator tests passed.
- Minimal release built from the existing VPS image. Only `automation.mjs` and `observe-server.mjs` changed in the service runtime; its display implementation was retained.
- No action was running at promotion. Service stopped for a consistent 193 MB profile/state backup, then restarted with the same mounts, secrets, private port, and recorded project resume configuration.
- Follow-up verification confirmed `ready_for_observation`, healthy runtime, the exact recorded project URL, 12 observed controls, a Download control, and no sign-in controls.
- New endpoint routing was checked with a deliberately unknown job; it returned `409 unknown_job` without performing an action.

The initial deployment receipt captured the service's existing health response while status was still `starting`. This was not treated as final browser readiness: the separate `vps-deployment-verification.json` records completed startup and the preserved project. The promotion script was tightened to require that state for future deployments.

Rollback is `/opt/captions-editor-bench/20260919-readiness/rollback` with the previous source/helper, compose file, and stopped state backup. The previous active image was `0.1.29-7`; the preexisting compose file referred to an unused `0.1.29-8`, so rollback must use the recorded active image. Other VPS services were not restarted.

## Cost and limits

No paid generation, Captions edit, or Jev inference was required for these server fixtures. They used existing VPS CPU and storage. No claim is made about lower image/video provider prices, Captions render quality, or a new real-account video export. Existing uncertain jobs were left for their established reconciliation process.

## Evidence

- `vps-baseline-results.json`: three unmodified-image runs.
- `vps-readiness-results.json`: all 18 comparison attempts, including failures.
- `vps-release-proof.json`: final exact-release synthetic workflow and media checks.
- `vps-deployment.json` and `vps-deployment-verification.json`: deployment and subsequent saved-project checks.
- `readiness-regression.tap`, `advance-editor-regression.tap`, `coordinator-regression.log`: local checks.

Remote benchmark source and build records are under `/opt/captions-editor-bench/20260919-readiness/`. All production testing and UI activity stayed on the VPS.
