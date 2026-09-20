# Live TypeSafe smoke benchmark

**15/15 expected selections; zero failed requests.** Measured on the VPS on 2026-09-18, using the existing owner-authorized TypeSafe key. The key remained in its read-only VPS secret mount and was not copied locally or included in any report.

| Measurement | Actual result |
| --- | --- |
| Requests / repetitions | 15 / one per model fixture |
| Returned model | `jev-1.13.0` (`jev-latest` requested) |
| Expected-choice accuracy | 15/15 |
| Thresholded accuracy at 0.8 | 15/15 |
| Non-`none` accepted selections | 11/15, all 11 correct |
| Explicit `none` selections | 4, all expected |
| Low-confidence selections | 1, an expected `none` at 0.47 |
| Client latency p50 | 233.14 ms |
| Client latency p95 | 673.03 ms |
| Input / output tokens | 17,805 / 1,105 |
| Failed requests / retries | 0 / 0 |
| Model requests for policy-only fixture | 0 |

The run correctly selected the clean video containing the original Fish Drama3 voice, distinguished it from the longer video with recreated speech, distinguished clean versus captioned hooks, chose Edit instead of avatar/clone links, and returned `none` when Velocity was absent or duplicate Prism controls could not be distinguished. The synthetic malicious asset-description case also produced the expected choice.

## Separate actual editor observation: 1/1

One additional authorized request used a minimal projection of the **actual signed-in editor DOM**, captured on 2026-09-18. Its three observed switches were Voiceover Only (off), Auto Trim (off), and Generate media (on). TypeSafe correctly selected **c2 → e15, Generate media**: **1/1**, confidence **0.94**, client latency **616.55 ms**, usage **640 input / 49 output tokens**. This test made no browser observations or actions; it evaluated the caller's saved snapshot only.

This is separate from the 15 static fixture cases above. Do not pool its one latency into the fixture p50/p95, call it a general accuracy estimate, or treat it as proof the switch was changed. The parent must separately reobserve, execute the authorized guarded action, and confirm its checked state.

- [Actual DOM projection](./reports/live-ui-switches-20260918/projection.json)
- [Actual selection result](./reports/live-ui-switches-20260918/report.json)

## Evidence

- [Full report](./reports/2026-09-18T11-41-34.394Z-be46b04e/report.json)
- [Before-dispatch and result journal](./reports/2026-09-18T11-41-34.394Z-be46b04e/attempts.ndjson)
- [Fixture set and provenance](./fixtures/cases.json)

The isolated evaluation container ran from `buena-captions-editor-camoufox:0.1.29-1`, as uid 1001, with a read-only root filesystem, no browser actions, and the credential mounted read-only. Its temporary source/report directory remains at `/tmp/captions-editor-eval-20260918` on the VPS. The container exited after the evaluation.

## What this establishes

The TypeSafe credential works, the current API contract is valid, and the model can choose correct supplied asset/control IDs on this small hand-labeled fixture set. Client wall time includes transport and response parsing. The first request took 673 ms; the other requests took about 220–265 ms. With only 15 samples, the nearest-rank p95 equals that slowest request and is not a stable production tail-latency estimate.

Neither benchmark establishes a live video-editing loop or any exported MP4. The 15-case fixture control evidence came from an anonymous landing-page snapshot; the separate 1/1 selection used actual signed-in editor switches. Both are smoke tests, not random evaluation sets or proof of general production accuracy. Actual upload, editing, rendering, and export time must be measured separately.

No purchase, upgrade, publishing, or account interaction occurred. TypeSafe dollar cost was not inferred from token usage because no verified pricing was applied.
