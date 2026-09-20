# Browser automation readiness — 19 September 2026

**Later VPS update:** SSH access was restored, the isolated server benchmark completed, and readiness release `0.1.29-9` was deployed. See [VPS results](VPS-RESULTS.md) for the new evidence. The sections below retain the earlier research and local-desktop findings; their SSH blocker is resolved.

## Decision

Keep the deployed Camoufox/gomoufox editor adapter for the hackathon. Keep code in charge of exact controls, permitted assets, and outcome verification. Use Jev for ambiguous semantic choices. Do not replace it with an untested desktop stack hours before the demonstration.

The most useful announced addition is Cua Driver's snapshot/capture-bound execution contract. It addresses stale targets and changed windows, which are closer to our observed failures than model selection speed. Evaluate it next in an isolated Linux X11 session, with the same upload/switch/export fixtures, before changing the working Captions profile.

## Tests actually run today

| Test | Result | Scope |
| --- | --- | --- |
| Existing editor adapter and selection-contract regression | 54/54 pass; 460 ms | Local source tests; mocked browser transport |
| Upstream jev-ultrafast commit `1231850` | 31/31 pass; 610 ms | Upstream offline tests; no live Chrome run |
| Existing labeled Jev selection dataset, three repetitions | 45/45 expected raw selections; median 276 ms, p95 445 ms | Live TypeSafe API; static observations, not browser execution |
| Comet local control fixtures, OCR versus accessibility-first | 14/16 completed; approximately 3.40 s median | Real desktop clicks; four small fixtures, two repetitions per path |
| Follow-up with readiness wait, fresh target resolution, and bounded readback | 9/16 completed | Real desktop; six pre-action stops and one unverified click; do not deploy as an improvement |

The 45 model calls used 53,415 input and 3,315 output tokens. Dollar billing was not verified. These token figures exclude desktop-test calls. No Captions render or subscription purchase was made during these tests.

Selection accuracy is not task success. The small repeated dataset does not establish production accuracy or superiority over another model. Raw selection includes correct abstention; at the existing confidence threshold the report counts 33 accepted choices, 12 explicit `none` results, and three low-confidence results (categories overlap). The real desktop results include every failed attempt.

## Findings from live execution

- Accessibility-first needed OCR fallback in all eight initial trials. Its completion count and median latency were essentially the same as the OCR-first path. No demonstrated reason to enable it as the default for this Comet environment.
- Initial batch: one target was absent from perception; one reported click failed the independent URL-fragment check. The latter's root cause was not established.
- Guarded follow-up: four context changes during readiness waits, one focus/page change before clicking, one missing or ambiguous freshly observed control, and one unverified click. These are failures or safe stops, not successes.
- The follow-up incurred an additional capture/perception cost. It was run later, rather than as a randomized controlled experiment, and did not improve the observed completion rate. It does not prove the guards caused the regressions.
- Desktop focus can change between observations. An isolated display/session with one owner is preferable to shared foreground desktop automation for the demo. This is an engineering recommendation, not a measured improvement from today's run.

Fixture postconditions were exact local URL fragments produced by the clicked controls. The fixture controls included different orderings, similarly named previews, and a text-drawn canvas. They do not cover native file pickers, actual editor timelines, uploads, authentication, or video export. Only fixture labels were sent to Jev; unrelated browser tabs and account data were filtered out.

## What the announcements add

### Cua `jev-use`: useful integration pattern, merged example

[PR #3916](https://github.com/trycua/cua/pull/3916) merged a bounded Python/TypeScript example. Application-owned candidates, fresh references, persistent MCP transport, and independent result checks fit our current architecture. It is an example/documentation change, not a new certified runtime release. [Example documentation](https://github.com/trycua/cua/tree/main/libs/cua-driver/examples/jev-use).

### Cua Perception: promising optional fallback, not ready to replace our stack

[PR #3943](https://github.com/trycua/cua/pull/3943) remains draft. It adds opt-in visual parsing and capture-bound visual actions; exact-candidate CI and platform/live validation are still listed as outstanding. Parsing has runtime/memory overhead, so it should run when semantic controls are insufficient. The announcement's 2048 speed/cost ratio must not be treated as a Captions benchmark.

### jev-ultrafast: borrow execution ideas; not an editor replacement

[Repository](https://github.com/browser-use/jev-ultrafast). Useful ideas include compact atomic DOM reads, fewer browser round trips, fresh target geometry, occlusion checks, and bounded waits. Its current MVP excludes uploads, frames, shadow roots, canvas, popup tabs, nested scrolling, and arbitrary keyboard widgets. Owned tabs share the existing Chrome profile. Our workflow needs capabilities outside that MVP. We installed an isolated checkout and ran its offline tests, without attaching it to a real browser profile.

### CUA-S1: postpone

The current [repository README](https://github.com/trycua/cua/tree/main/libs/cua-s1) describes early form-specific research, source-only distribution, and no checkpoint performance established by that release. Its default portable Driver contract also lacks the `set_value` operation needed by its fill path. A separately encountered Hugging Face model card makes different release/performance claims; its artifact compatibility and license were not established here. It is not a verified drop-in editor controller.

## Before the hackathon

1. Use the existing VPS Camoufox profile and known test project. Keep one task in control of the browser session.
2. Preserve the exact-match fast path: an unambiguous permitted control does not need an AI call.
3. Re-observe after transitions; resolve fresh refs and verify actual state. Never blindly retry a mutation after a timeout.
4. Demonstrate the existing upload → settings → render flow. Label export/download status honestly; today's tests did not verify a new Captions export.
5. When SSH access is restored, repeat the existing VPS fixture suite and one approved editor workflow, then report whole-task completion separately from model accuracy.

## Blockers and reproducibility

- Fresh VPS tests could not run: the SSH agent failed to sign the configured key; the server returned `Permission denied (publickey)`. No VPS deployment was changed today.
- Initial upstream pytest collection tried creating a browser-harness directory outside the writable sandbox. Retried successfully with the library's supported `BH_HOME=/tmp/buena-jev-ultrafast-harness` setting. This did not change the user's browser profile.
- A fresh TypeSafe documentation fetch failed; integration validation used the previously retrieved SDK documentation and installed SDK types. Public GitHub release research was fetched live.
- No Cua Driver binary was installed or tested live; optional perception model weights were not downloaded.

Artifacts in this folder: `adapter-regression.tap`, `live-results.json`, `live-summary.json`, `guarded-results.json`, `guarded-summary.json`, and `summary.json`. The rerunnable local probe is `live_perception.py`; `--guarded` enables the experimental follow-up behavior. It requires the already installed controller, existing configured TypeSafe key, and macOS permissions. It opens only its local fixture pages. Re-running overwrites that mode's results, so archive them first.

The repeated semantic benchmark is in `../../captions-editor-eval/reports/2026-09-19T03-02-54.566Z-877fd0dc/report.json`. Its request journal retains all attempts. `run_semantic.py` runs the bounded 45-request evaluation without printing the configured credential.
