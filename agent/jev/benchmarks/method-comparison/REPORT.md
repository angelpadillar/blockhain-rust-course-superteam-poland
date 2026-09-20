Browser-agent method comparison — 17 September 2026
===================================================

**Latest result: 3/3 live Glovo navigation attempts completed**, taking 13.245–13.897 seconds (median 13.589 seconds), at an estimated Jev API cost of $0.00031479 per attempt. Each independently verified the exact product page; no basket or purchase actions executed. The key fix was allowing Glovo's narrowly validated product-display request, which the old address-mutation guard had incorrectly blocked. This is a small, task-specific pilot, not an overall fastest-agent or LLM comparison.

The objective is the lowest time and total cost per independently verified completed browser task, with success rate reported alongside speed. The current Glovo task remains navigation-only: open the exact requested product from the city homepage, without changing the basket, scheduling or purchasing.

Sources are pinned; their checkouts are unmodified:

| Project | Revision | Actual role |
|---|---|---|
| [typesafe-mod](https://github.com/BeLazy167/typesafe-mod/tree/a39e04dc28ebd560050c9c18daed3b080b67b018) | `a39e04d` | Claude Code hooks for skill suggestions and advice on existing multiple-choice questions |
| [typesafe-computer-use](https://github.com/awlevin/typesafe-computer-use/tree/ccde756a3145cd177e6a7396ddbab48286afaf75) | `ccde756` | macOS accessibility + OCR → Jev action selection → native interaction; writer for free text |
| [jev-ultrafast](https://github.com/browser-use/jev-ultrafast/tree/452c1ad2dd628008f1d5608f28158d76e49e6cc0) | `452c1ad` | Browser DOM → batched Jev operation/target selection → Browser Harness/CDP; writer for free text |
| Current Glovo adapter | Source fingerprint retained in each journal | Task contract → restricted observed controls/known search values → Jev selection → Playwright → independent verifier |

What the new repositories add
-----------------------------

`typesafe-mod` leaves the general agent in charge. Its optional skill router chooses a skill and whether a procedure is needed; its decision router evaluates the question/options Claude has already produced. It has no browser observation, navigation, click or text-generation implementation. Its default behavior advises the user, and its current auto-answer path has a response-key mismatch: requests use `q0`, while the reader checks `answers.pick`. The pure helper reproduction in `mod-response-check.mjs` confirms that a valid batch-shaped response produces advice but no auto-answer. No hooks were installed or enabled.

The useful idea is delegating bounded decisions to Jev, batching independent questions and allowing uncertain decisions to return to the main agent. Its author-reported 166–420 ms and $0.000016 decision example concern routing overhead, not completed browser tasks or total Claude cost. See the pinned [README](https://github.com/BeLazy167/typesafe-mod/blob/a39e04dc28ebd560050c9c18daed3b080b67b018/README.md) and [hook implementation](https://github.com/BeLazy167/typesafe-mod/blob/a39e04dc28ebd560050c9c18daed3b080b67b018/hooks/register.ts).

`typesafe-computer-use` is a genuine interaction loop. The current source merges OCR text with native accessibility controls, retains element handles, uses direct accessibility presses/field writes, can select offscreen controls, and reuses OCR outside changed image regions. Deterministic date annotations reduce what Jev must infer. Its batched action/target questions are closely related to Ultrafast's design. General text entry still calls an Anthropic writer; field verification then makes another Jev call. URLs outside its catalog also use the writer. See [perception](https://github.com/awlevin/typesafe-computer-use/blob/ccde756a3145cd177e6a7396ddbab48286afaf75/typesafe_computer_use/perception.py), [actions](https://github.com/awlevin/typesafe-computer-use/blob/ccde756a3145cd177e6a7396ddbab48286afaf75/typesafe_computer_use/actions.py), and [decisions](https://github.com/awlevin/typesafe-computer-use/blob/ccde756a3145cd177e6a7396ddbab48286afaf75/typesafe_computer_use/decide.py).

That macOS implementation cannot run unchanged on the Hetzner Linux VPS. It imports macOS accessibility/Quartz and Vision OCR, declares macOS-only dependencies and uses AX role names. A browser-native implementation can use DOM and Chromium accessibility evidence through the existing browser connection instead of porting the desktop stack.

Limits relevant to speed claims
-------------------------------

The computer-use README reports approximately 1.5 seconds per step and $0.0002 per Jev decision, using a one-screenshot/one-goal comparison. Those are the author's observations, not our Glovo measurements. Current code defaults to **two seconds of sleep between continuing steps**; that sleep sits outside its per-step `total` timer, although overall run wall time includes it. Text-writer and verification calls also need separate accounting. Its output does not independently prove task completion.

We ran **120 upstream offline tests**, lint and formatting checks successfully. No desktop screenshots, user interactions or paid API requests were made for this review. Two extra pure checks identify why a direct adoption needs care:

- A synthetic black-to-white 32 × 32 pixel patch in a 256 × 256 tile is not detected by its mean-difference threshold. A cache can therefore retain stale text for small changes. This is a concrete reproduction, not a claim about overall OCR accuracy.
- A `none` stopping decision leaves `RunState.outcome` at its default `completed`. A speed comparison must use an independent verifier rather than this label.

The executable checks and exact results are saved in `review_checks.py` and `results/computer-use-source-checks.json`. The two-second default and timer placement are visible in [config.py](https://github.com/awlevin/typesafe-computer-use/blob/ccde756a3145cd177e6a7396ddbab48286afaf75/typesafe_computer_use/config.py) and [runner.py](https://github.com/awlevin/typesafe-computer-use/blob/ccde756a3145cd177e6a7396ddbab48286afaf75/typesafe_computer_use/runner.py).

Our immediate bottleneck
------------------------

The saved Glovo reference run took 41.432 seconds and did not complete. Its journal shows:

| Component | Duration |
|---|---:|
| Jev calls | 5.047 s |
| Journal writes | 1.367 s |
| Browser/runtime residual | 35.017 s |
| Post-action observation/readiness, reconstructed from events | 32.199 s |
| Action execution/revalidation, reconstructed from events | 1.334 s |

The reconstructed rows are components of the residual, not additional time. `analyze_reference.py` reproduces the calculations and writes only public timing/outcome evidence.

All six product clicks immediately produced both expected product IDs, then the page returned to the category without a verified product title. The right control was offered and the transition started. This is a render/rollback problem in the existing adapter's run. The earlier Ultrafast fixture coverage issue is a separate problem.

Twenty-four mutation requests were blocked, but the old record only has an aggregate count. It cannot show whether a blocked request caused any rollback. The guard must stay intact while method/endpoint-class/action correlation is added. Existing 700 ms stability waits also impose at least 14.7 seconds across 21 readiness calls, included in the times above.

Architecture to test next
-------------------------

Use the persistent Playwright/CDP browser as the main path, with compact DOM and accessibility evidence. Jev selects an allowed action and target in one request. Code executes and verifies the expected state transition. Copy merchant/product search text already present in the validated task contract; invoke a writer only when new text is actually required. Use screenshot/OCR as a fallback for controls the structured reader cannot represent. This is a design recommendation based on the source and our trace, not a measured winning configuration.

Priorities are:

1. Diagnose the product URL reversal with sanitized, correlated events, then remove the actual cause without relaxing transaction restrictions.
2. Bound retries by semantic target and observed outcome so unrelated page changes do not restart a failed action loop.
3. Return immediately once independent completion is verified; then replace other blanket waits with task-specific readiness conditions under regression tests.
4. Keep observed-element freshness, task constraints, durable pre-action evidence and independent completion checks through any speed optimization.
5. Compare fixed versions on repeated tasks. Report completion rate, total wall-time p50/p95, model/browser/observation time, all API usage, fallback rate and cost per verified success. Report cost per success as unavailable when there are no successes.

No source here establishes the fastest browser agent overall. These repositories provide useful components. The Glovo completion defect was the first measurable problem identified; its diagnosis, correction and successful live reruns are recorded below.

Changes implemented after the review
-----------------------------------

The navigation adapter now records explicit action outcomes, including product URL rollbacks. It remembers matching product IDs observed during post-click polling as well as immediately after execution. A scoped main-frame navigation listener also captures brief transitions during execution, journal writes and between polls; it retains only a boolean and is removed in `finally`. A second observed rollback for the same product-opening action stops the attempt even if unrelated page content or element indexes change. Outcome history is supplied to Jev on subsequent decisions.

Independent completion still requires the correct store, both product IDs and the visible exact product title. Once those conditions are observed, the reader returns immediately. Intermediate page stability waits and the delayed-title protection remain in place; removing them broadly would be an untested change.

The evaluation runner also records each blocked mutation's method, coarse endpoint class and current action sequence/type. It saves no request URL, body, headers or account data in those diagnostic events. All evaluation journal writes share a queue; a write failure cancels further actions, and intercepted requests still abort. These events show correlation with actions, not causation.

Validation passed: 11 navigation/journal unit tests, five diagnostic tests and 12 local Playwright navigation fixtures. The fixtures include delayed title rendering, delayed and very brief URL rollbacks, changing element indexes, successful recovery on the allowed retry, and listener cleanup after a failed journal write. Browser fixtures use a temporary profile with intercepted fixture responses; they make no live Glovo or model calls.

Live diagnostic after deployment
-------------------------------

One bounded run on the existing Hetzner profile used returned model `jev-1.13.0` and stopped with `product_open_rollback_limit`. Independent completion failed. Source fingerprint: `952f60d24abcf76de828b5425fd56623b257862749db72e7d34e76596b80ee35`.

| Measurement | Updated diagnostic run | Earlier reference run |
|---|---:|---:|
| Homepage through stop | 19.634 s | 41.432 s |
| Jev calls | 8 | 19 |
| Jev time | 2.454 s | 5.047 s |
| Estimated model cost | $0.000385896 | $0.001110732 |
| Product rollbacks | 2 | 6 |
| Independently completed | No | No |

The updated run used 9,188 input and 1,431 output tokens, with complete recorded usage. Browser launch took a separate 0.169 seconds. Estimates use the configured $0.042 per million input tokens and free output; infrastructure, setup and operator time are excluded. These are two failed attempts, so the lower time/cost demonstrates a bounded failure path, not a successful-task speedup. Cost per verified success remains unavailable.

The new diagnostics captured all eight blocked requests: **POST requests on address-class routes, four during each product rollback**. No blocked request was attributed to the earlier navigation actions. This was useful correlation, but the coarse class could not distinguish an address mutation from a nested product-data route. The transaction guard stayed unchanged for that diagnostic. The public evidence is in `results/navigation-diagnostic-20260917.json`; the complete journal remains private.

A second diagnostic added a redacted route template while retaining the same guard. It stopped after 19.903 seconds, eight Jev calls and $0.000385896 estimated model cost. All eight blocked requests had the template `/v4/stores/:segment/addresses/:segment/products/:segment/view`. Its full public summary is `results/route-diagnostic-20260917.json`; this failed attempt is retained separately.

Public frontend inspection identifies that POST endpoint as product-detail loading: the address parameter is a **store address**, the result supplies the displayed product title, and basket additions use a separate handler. The ordinary caller sends `editingMode: false` and `origin: OTHER`, with optional translation. On non-404 loading errors the modal closes, and the store close handler removes both product IDs. The shared client retries network failures three times. Together with the captured route, this explains how the overbroad guard could produce the observed four failures and URL rollback. Sources: [product modal](https://glovoapp.com/_next/static/chunks/59259-24b0fae4a6c7e8aa.js), [store page](https://glovoapp.com/_next/static/chunks/app/%5Blanguage%5D/%5Bcountry%5D/%5Bcity%5D/stores/%5BstoreSlug%5D/page-15072e5a4b21b141.js), [API client](https://glovoapp.com/_next/static/chunks/10544-68f20214f2870a70.js). Public source hashes are retained in `results/glovo-public-source-index.json`; no authenticated API calls or source execution were used in that inspection.

The correction permits only that exact API origin, POST route/version, numeric path shape, current task's product IDs and ordinary-view JSON schema. Unknown fields, duplicate keys, editing mode, additional query parameters and adjacent mutation routes do not qualify. Bodies are checked locally and never added to journals or model state. The singular `/address` mutation spelling is now blocked too. Both the headless and desktop evaluation runners use the same predicate.

Final validation after this correction: **41 unit tests and 13 local navigation browser fixtures passed**, with independent source review. The new integration fixture loads the requested product through the checked POST while simultaneous address and cart writes abort; a body marker is absent from the resulting journal, model inputs and result. These fixture successes remain separate from live results.

Three successful live attempts
-----------------------------

The fixed version then completed three consecutive attempts from the city homepage on the existing VPS account/profile. Each launched a fresh Chromium context using that persistent profile; setup/login was excluded, and the explicitly authorized age confirmation was included. All runs returned model `jev-1.13.0` and shared source fingerprint `bc6cb6125007d2b18af7e8297668f5e60c09cb704b2523e5f1c4118d960f1e7a`.

| Run | Independently verified | Navigation time | Jev time | Calls | Estimated model cost |
|---|---|---:|---:|---:|---:|
| 1 | Yes | 13.897 s | 2.215 s | 7 | $0.00031479 |
| 2 | Yes | 13.589 s | 1.916 s | 7 | $0.00031479 |
| 3 | Yes | 13.245 s | 1.791 s | 7 | $0.00031479 |

Each run used 7,495 input and 1,195 output tokens. Combined model cost was $0.00094437; cost per verified success in this fixed-version cohort was $0.00031479. Separate browser launch times were 0.209, 0.082 and 0.078 seconds. There were no product rollbacks, blocked mutations, basket actions or purchase actions in these successful runs. The endpoint exception enabled the product display request; transaction-action restrictions and independent verification remained active.

The public per-run summaries and aggregate are saved under `results/success-*-20260917.json` and `results/successful-batch-20260917.json`. Prior failures are retained separately, including the two diagnostic attempts costing $0.000771792 in total; they are development costs, not silently discarded successes. Infrastructure, setup, operator work, any general planner/writer, and the earlier Ultrafast experiments are outside this three-run API estimate.

Three repeats on one product, account, delivery area and website are limited positive evidence. They do not establish broad website coverage, checkout/payment reliability, a stable p95, or superiority to Astra/Fable/Codex. No like-for-like larger-model API bill was measured. Browser/runtime time now dominates this route, so the next performance target is unnecessary page settling and action count; changes should retain the successful route as a regression case and be compared on repeated verified tasks.

Reproducing the offline source checks
------------------------------------

Use unmodified checkouts at the revisions above. The computer-use checks require its pinned macOS dependencies (`uv sync --frozen` in that checkout); they do not interact with the desktop. Run its `.venv/bin/python` with `review_checks.py --repo /path/to/typesafe-computer-use`. Run `node mod-response-check.mjs /path/to/typesafe-mod` with Node supporting TypeScript type stripping. Both scripts verify the checkout revision before importing helpers and save their results next to this report.

`analyze_reference.py --help` documents the saved-journal timing analysis. Supply the private journal path explicitly when running from the hackathon repository; private browser journals are intentionally not copied into it.

For newer diagnostic journals, run `python3 summarize_navigation.py /private/path/run.json --output results/chosen-name.json`. This produces an allowlisted public summary with blocked-request/action correlation, while preserving unknown or missing evidence.

Reproduce the successful cohort with `python3 aggregate_navigation.py results/success-1-20260917.json results/success-2-20260917.json results/success-3-20260917.json --output /tmp/successful-batch-check.json`. The aggregator reports source consistency and divides all included attempt costs by verified successes; missing cost or usage prevents that estimate.
