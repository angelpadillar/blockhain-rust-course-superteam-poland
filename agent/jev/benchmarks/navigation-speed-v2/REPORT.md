# Navigation speed candidate — 17 September 2026

Implemented and benchmarked two separate candidates while preserving the working baseline. **No completed-task speedup is established.** The richer v1 prompt caused a decision regression; v2 restored the baseline prompt and passed that decision, but Glovo returned an unavailable page before completion. Keep the baseline as the default and v2 as the next experimental candidate.

Across all eight new benchmark attempts, the unchanged baseline completed three times. Its successful-run median was **14.022 seconds**, range **13.356–14.874 seconds**, seven Jev calls and **$0.00031479 estimated API cost per success**. It also encountered two homepage errors; those attempts remain in the five-attempt baseline denominator. The earlier three-run baseline from the preceding experiment remains separate (3/3, median 13.589 seconds).

| Implementation | Verified / attempted | Completed navigation median | All-attempt API cost | API cost / verified success |
|---|---:|---:|---:|---:|
| Baseline | 3/5 | 14.022 s | $0.000944370 | $0.000314790 |
| Candidate v1: richer prompt + browser changes | 0/2 | Unavailable | $0.000259728 | Unavailable |
| Candidate v2: baseline prompt + browser changes | 0/1 | Unavailable | $0.000066444 | Unavailable |

All eight attempts used 30,251 input and 4,459 output tokens, with complete recorded usage and returned model `jev-1.13.0`. Total estimated model cost was **$0.001270542** (about 0.127 US cents), including every failed candidate call. Pooling all experimental costs across the three verified completions gives $0.000423514 per completion; this is experiment accounting, not the production cost of v2. Rates are the configured $0.042 per million input tokens and free output. Infrastructure, setup, operator time and future planner/writer costs are excluded.

## What changed

The candidate captures real DOM nodes with each observation and binds references to that snapshot. Before dispatch, it verifies the same element still exists and matches an allowed task action. Index shifts preserve identity; replacement nodes do not inherit stale decisions. At most two pre-dispatch stale refresh/reselections share the normal step, time and model budgets. Errors after dispatch are never automatically replayed.

Readiness polling is 75 ms. Newly observed relevant targets can proceed after 250 ms of stable evidence; uncertain transitions retain the 700 ms fallback. The product page still needs the exact store, both product identifiers and visible title before success. The browser records readiness, observation and execution timings; observation is included in readiness and must not be added twice. No model judgment replaces deterministic task restrictions or the independent verifier.

V1 put `what`, `where`, `supports`, role and snapshot refs into structured Choice criteria, changed the instruction and shortened history. Twice it filled search correctly, then chose `unavailable` despite an offered submit action. The different prompt components were not tested separately. V2 uses the exact baseline request builder and history projection; snapshot descriptors remain local to execution and journals. Its live trace chose and executed the correct submit action before the site error.

## Every live cohort is retained

Each cohort prescribed six runs in B/C, C/B, B/C order, with the same persistent profile and a fresh Chromium context per run. Ordinary navigation failures continue; site/setup/provider/journal failures stop the batch. Unrun slots are neither failures nor successes.

1. **V1 cohort, five observed attempts.** Baseline completed in 14.874 s and 13.356 s. Candidate v1 stopped twice at `model_unavailable`. The fifth attempt was a baseline homepage error, which stopped the batch. [Complete v1 report](../navigation-speed-v1/REPORT.md)
2. **First v2 cohort, one observed attempt.** Baseline stopped at the homepage with `merchant_site_unavailable`, before any model call: 0.209 s navigation, 0.460 s full attempt, $0. [Retained result](results/availability-stopped-batch.json)
3. **Separate read-only availability diagnostic.** One ordinary homepage navigation returned HTTP 200, then stayed on a normal homepage during eight seconds of observation. It made no input or model calls, changed no cache settings, and is not counted as a task attempt. This showed availability had changed and justified a new cohort; it does not prove why earlier or later requests failed. [Diagnostic](results/site-readiness.json)
4. **V2 retry cohort, two observed attempts.** Baseline completed in 14.022 s (14.315 s including launch/close/diagnostic flush). V2 filled and submitted search, then detected Glovo's unavailable page and stopped at 2.812 s (3.003 s full attempt), with two model calls and $0.000066444 spent. Later slots were unobserved. The adapter made no attempt to bypass the site error. [Per-attempt results](results/comparison.json)

There are no adjacent pairs with two completed tasks, so paired speedups and candidate cost per success remain unavailable. These results do not show that 2.812-second failure is faster task execution. No fast-readiness transition or stale recovery ran before v2 stopped; their live performance benefit remains unmeasured. The cause of Glovo's intermittent error is not established.

## Validation, saved code and reproduction

The 60 unit tests pass, including exact v2/baseline request parity and unchanged-source checks. Twenty-seven candidate browser fixture cases cover duplicate labels, node replacements/index shifts, stale budgets, delayed search/title rendering, rollback limits, journal failures, native dispatch errors, age scope and fill→Enter→merchant→product. Nine offline analyzer tests pass; an independent review also checked private events against public token, cost, completion and timing results. Fixtures are controlled local pages, not live merchant reliability evidence.

The baseline source fingerprint is `bc6cb6125007d2b18af7e8297668f5e60c09cb704b2523e5f1c4118d960f1e7a`. V2 candidate/full-harness fingerprint is `6dc773912b5e5281fd2e7c871405c7ef6c8a5d5373b370719096cb0d8644eeef`. [Frozen protocol](protocol.json), [method](PROTOCOL.md), and the `source/` directories retain both versions. Differences in full baseline fingerprints between cohorts come from the versioned comparison harness; the baseline runtime fingerprint is unchanged. Raw journals remain private. [All-attempt accounting](results/all-attempts.json) is reproduced by `python3 summarize_all_attempts.py`.

From the configured `agent/jev` service, `node scripts/navigation-compare-v2.mjs --key-stdin --repeat-confirmed-age` runs another explicitly scoped comparison and saves new private batch and per-run journals. Supply the key through hidden stdin and use the existing authorization for this exact case. `node --test tests/navigation-candidate*.e2e.mjs` runs candidate fixtures; use `JEV_BROWSER_CHANNEL=chrome` for installed Chrome. Existing service/default navigation commands continue to use the preserved baseline.

All live task actions stayed within navigation: **zero basket or purchase actions**. The test containers exited and the account profile lock was released. No general browser-speed record, stable p95, cross-site reliability, payment completion or like-for-like Astra/Fable/Codex comparison follows from this small, outage-interrupted experiment. The next useful live measurement is the unchanged v2 paired comparison when this route remains available; promotion requires verified completion first.
