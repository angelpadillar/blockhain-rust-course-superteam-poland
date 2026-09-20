# Captions editor selection evaluation

A bounded evaluation of TypeSafe choosing an asset or a control from supplied evidence. It does not run a browser, upload media, edit a project, or export a video.

## Current evidence

- **11/11 offline contract tests passed.** These use mocked responses, not live TypeSafe measurements.
- **Authorized live smoke benchmark: 15/15 expected choices**, zero failed requests, p50 **233 ms**, p95 **673 ms**. The API resolved `jev-latest` to `jev-1.13.0`. See [LIVE-BENCHMARK.md](./LIVE-BENCHMARK.md) and its raw report for the measured scope and limits.
- **16 fixtures:** 15 semantic selection cases and one local policy rejection requiring no model.
- Control labels come from the saved anonymous Captions homepage snapshot. They are **not** calibrated authenticated editor controls.
- Asset cases distinguish the 14.333-second video with original Fish Drama3 audio, the 20.064-second video with Seedance-recreated speech, a standalone voice file, and clean/captioned four-second videos.
- Two explicitly labeled synthetic fixtures exercise malicious page text and policy exclusions.

Expected answers and explanations are held outside the model request. The model sees only the requested step, current candidates, and metadata. Permission annotations are applied in code before constructing its closed choice set. Execution must still revalidate the chosen asset/control in the real adapter.

## Run without an API key

Requires Node.js 22 or newer; no packages need installing.

```sh
cd captions-editor-eval
npm test
npm run check
```

The check writes `reports/<timestamp-id>/report.json`. It sends zero requests. Model accuracy, latency, confidence, and usage remain `null`; successful fixture validation is not model performance.

## Run an authorized live benchmark

Set exactly one credential source: `TYPESAFE_API_KEY` or `TYPESAFE_KEY_FILE`. The latter must point to a private, plain-text key file readable only by its owner (0600). No credential locations are searched; keys never enter request state or reports. Avoid putting keys directly in shell history.

```sh
TYPESAFE_KEY_FILE=/private/path/typesafe.key node src/run.mjs --live --max-requests 15 --repeats 1
```

This fixture set makes **15 requests**, serially, without retries. Existing authorization to use the configured TypeSafe account is required. `--max-requests` is a request count limit, not a dollar budget. Usage is reported from actual responses; this tool does not purchase credits or estimate unverified pricing.

Other options:

```sh
# One representative semantic asset decision:
TYPESAFE_KEY_FILE=/private/path/typesafe.key node src/run.mjs --live --case original-fish-video --max-requests 1

# Three measured repetitions of the complete set, when authorized:
TYPESAFE_KEY_FILE=/private/path/typesafe.key node src/run.mjs --live --max-requests 45 --repeats 3 --threshold 0.8
```

The default network timeout is 15 seconds per attempt (`--timeout-ms`, maximum 60,000). A rate-limit/server failure is recorded, never automatically retried. HTTP 401/403 stops the entire run before another request. Each live attempt is journaled before dispatch. A started record without its completion means the result is unknown; restarting creates a new run and can incur another request.

## Report interpretation

- **Raw accuracy:** correct choices / validated model responses.
- **End-to-end accuracy:** correct choices / all live attempts, including failed requests.
- **Coverage:** confident non-`none` selections / all live attempts.
- **Accepted accuracy:** accuracy among those confident selections.
- **Thresholded accuracy:** low-confidence choices become `none` before comparison with the expected answer.
- **Latency p50/p95:** nearest-rank percentiles of measured client wall time, including transport and parsing; failed attempts with measured time are included.
- **Confidence:** returned concentration measure, distinct from the probability assigned to the selected option. Neither is permission to act.
- **Usage:** token counts for validated responses; failures are explicitly marked as unknown usage.

The 0.8 threshold is illustrative and inherited from the existing adapter. It has not been established as appropriate for production. A 15-request hand-labeled sample is a smoke benchmark, not proof of general accuracy or a stable p95 estimate. Run later evaluation on fresh authenticated editor observations before calibrating automation.

## Contract and documentation

The transport uses the official `POST https://api.typesafe.ai/v1/systemone` API and `jev-latest` model. Choice responses are checked for known choices, finite confidence, complete normalized probability maps, and valid usage. Duplicate/reserved candidate IDs, stale observation references, oversized requests, and missing permission annotations fail before transport.

Read [CONTRACT-REVIEW.md](./CONTRACT-REVIEW.md) for differences from the existing adapter. Official documentation snapshots, URLs, and checksums are under `docs/`; retrieved 2026-09-18. Fixture source paths and hashes are embedded in `fixtures/cases.json`.

No successful browser edit or exported video follows from this evaluation. The live adapter must separately verify login, project identity, upload, trim, captions, save-copy, rendering, and the downloaded MP4.
