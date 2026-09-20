Jev Ultrafast evaluation — 17 September 2026
=========================================

**The replacement TypeSafe key works. The revised prompt passed 24/24 synthetic decisions versus 22/24 for the original, but a complete live Glovo run remains unverified.** Stock Ultrafast chose the search field and stopped because its text helper is not configured. The existing adapter also failed to reach independently verified product details. These are development results, not a production success-rate claim.

The original source is pinned to [`452c1ad2dd628008f1d5608f28158d76e49e6cc0`](https://github.com/browser-use/jev-ultrafast/tree/452c1ad2dd628008f1d5608f28158d76e49e6cc0). Its checkout remains unmodified. Our benchmark wrapper and candidate prompts are separate files.

What ran
--------

| Check | Observed result |
|---|---|
| Upstream offline suite | 31 passed |
| Upstream real browser guard checks on the VPS | 21 passed; no paid APIs |
| New cost-accounting tests | 4 passed |
| Upstream lint, JavaScript syntax, package build | Passed |
| Glovo homepage and configured delivery destination | Verified in the persisted server browser |
| Original-policy live navigation run, replacement key | Incomplete: TYPE_TEXT needs a text-helper key; one valid Jev decision |
| Latest synthetic prompt comparison | Original 22/24; candidate-v2 24/24; two repetitions of 12 development cases |
| Basket changes / purchases | None performed; navigation-only enforcement retained |

The working-key stock run (`20260917T085320Z-stock-770528e9`) selected TYPE_TEXT on the homepage search input. Its one Jev request took 687 ms, used 2,641 input and 185 output tokens, and cost an estimated **$0.000110922**. Total time to the missing-helper stop was 1.702 seconds, with zero executed model actions. This is not a completed-task duration or task cost.

The earlier attempt (`20260917T084546Z-stock-9fe60b5f`) stopped on HTTP 402 in 1.422 seconds. It returned no usage, so cost is unknown, not zero. The first-version record retains a zero token subtotal alongside `usageComplete: false` and a null total; the corrected accountant makes the Jev cost null too. The replacement key resolved the billing rejection.

The current Glovo adapter was also checked once with the working key. It found the merchant, searched for the product, repeated the authorized age confirmation once and reached the right category, but did not verify product details. It stopped at its action limit after **41.432 seconds**, 19 Jev calls and **$0.001110732** estimated model spend. Its network guard blocked 24 mutation requests. This adapter used its existing 1440 × 1000 viewport rather than Ultrafast's 1120 × 780 viewport; the two incomplete attempts are not a matched speed comparison. Its full journal remains saved for diagnosing the product-opening loop.

Reader coverage and timing
--------------------------

Four controlled DOM fixtures reproduce the relevant shapes of controls; these are not live Glovo pages. Each reader used the same temporary Chrome page, 1120 × 780 viewport, five warmups and 60 timed samples, with alternating read order. Timing includes Playwright transport, not the upstream Browser Harness transport. All results are saved in `results/reader-comparison.json`.

| Fixture | Ultrafast offers the intended action | Current Glovo adapter offers it | Ultrafast median read | Current median read |
|---|---:|---:|---:|---:|
| Native product button | Yes | No | 0.577 ms | 1.167 ms |
| Glovo product tile heading | No | Yes | 0.562 ms | 1.117 ms |
| Glovo search-result product row | No | Yes | 0.631 ms | 1.482 ms |
| Glovo category heading | No | Yes | 0.548 ms | 1.490 ms |

The stock reader recognizes standard HTML/ARIA controls. The Glovo fixture product names are clickable headings/paragraphs; it misses those and exposes the adjacent increase-quantity button instead. Prompt tuning cannot select an element that the reader never offers. The existing adapter recognizes these Glovo-specific controls but is itself narrow: it does not support the generic product-button fixture. Neither result establishes coverage of most websites.

The sub-millisecond reader difference on tiny fixtures does not establish an end-to-end browser speedup. Site loading, action availability, search, rendering, model calls and verification still need measurement.

Prompt work
-----------

`prompts.py` contains candidate-v2 instructions for operation choice, target choice and text generation; `prompts_v1.py` preserves the first candidate. They preserve the whole user goal, distinguish opening details from quantity/order actions, handle live-filtered results, require visible completion evidence and treat page instructions as untrusted. They contain no site-specific sequence or hardcoded search values.

`prompt_benchmark.py` uses 12 synthetic development cases, two repetitions per variant and alternating variant order. These cases were written alongside the candidate, **not held out**. All successful responses reported `jev-1.13.0`.

| Development batch | Original | Candidate | Median original / candidate request time | Estimated original / candidate API cost, 24 decisions each |
|---|---:|---:|---:|---:|
| v1 | 21/24 | 22/24 | 263 / 258 ms | $0.001310568 / $0.001571892 |
| v2 | 22/24 | 24/24 | 296 / 282 ms | $0.001310568 / $0.001748796 |

Both original and v1 chose BLOCKED instead of WAIT on a visible loading placeholder. Candidate-v2 explicitly treats first-observed loading as an unfinished transition and reserves BLOCKED for repeated stalled waits; it fixed that failure on both repetitions. No model chose DONE for the incomplete loading fixture. V1 also improved the closed-store browsing case in one repetition. These small samples do not establish statistical or live-browser superiority. V2 costs approximately 33% more input tokens than stock in this evaluation; the few-millisecond latency difference is not a reliable speedup claim.

The first pre-replacement-key invocation made 48 requests which all raised provider errors. The initial evaluator did not record their HTTP status and mistakenly classified them as decision failures. Preserve that artifact, but exclude its pass-rate, timing and zero-token subtotal from model comparisons. A later diagnostic captured HTTP 402. The evaluator now stops on the first provider/validation error. The 96 subsequent valid decision calls cost an estimated **$0.005941824** in total, excluding all browser tests and failed requests.

Runtime and evaluation safeguards
--------------------------------

The private controller launches the existing Glovo profile under its exclusive lock. Browser Harness connects to that owned Chromium instance over a private Docker network; CDP is not published on a host/public port. Model credentials are absent from the browser process. Account/address values are checked locally and redacted from model payloads and journals. This is an instrumented stock-policy arm, not an entirely untouched upstream executable.

The wrapper preserves upstream operation/target selection and browser execution. It adds our navigation-only action gate, blocked transaction/address requests, durable before/after evidence, bounded execution and the same independent product verifier. Existing scoped age-confirmation consent is supported and included in timing. No age confirmation was needed in this stopped attempt. A DONE prediction is never accepted as proof.

The live clock includes Agent creation, homepage navigation, checks, model calls, journal writes and independent verification. Browser launch, daemon setup and manual account setup are excluded. Upstream's own loop clock is recorded separately and must not be compared directly with our wider clock. Browser containers were stopped after the checks; profile and result files remain saved.

Cost and next runnable comparison
--------------------------------

Jev's published price remains $0.042 per million input tokens with free output, checked on 17 September in the [TypeSafe launch article](https://typesafe.ai/blog/introducing-system-one-models-and-jev). Estimate from returned usage, then add text-helper cost and hosting separately. The [upstream implementation](https://github.com/browser-use/jev-ultrafast) uses a second OpenAI-compatible model for TYPE_TEXT; the TypeSafe key alone cannot run arbitrary text entry.

The remaining upstream dependency is a text-helper key/model. The user has been offered a choice between supplying that reference or evaluating a separately labeled Jev-only constrained text-selection variant. Once the chosen helper is available, run original and candidate policies on the same task, profile, viewport, limits and verification, with three interleaved attempts each. Preserve all failures. Compare success first, then successful-run wall time, per-action/model latency and combined model spend. The existing adapter is a separate arm because it has narrower task-specific action choices and fixed search values.

Candidate-v2 is the preferred development prompt based on these cases; it has not yet been validated through the full live route. No new Codex, Astra or Fable comparison ran. Earlier shopping results concern a different task, and prior Glovo navigation development attempts were not independently verified successes. There is no evidence here for a speed/cost superiority claim over those models.

Saved locations
---------------

- Benchmark code and public evidence: `benchmarks/jev-ultrafast/` in the experiment workspace.
- Private live JSON/JSONL: `shopping-private/2026-09-17-ultrafast/results/`.
- VPS harness: `/opt/jev-ultrafast-benchmark/`; private results in its `results/` directory.
- Persistent Glovo profile: existing `jev-hackathon_jev-data` Docker volume.
- Existing Glovo adapter remains the default; no production engine replacement or payment capability was enabled.

Subsequent comparison
---------------------

The [17 September method comparison](../method-comparison/REPORT.md) reviews the two additional repositories and records a fix to the separate Glovo adapter. That adapter then completed three live navigation attempts. These results do not complete the upstream Ultrafast text-helper experiment or replace the failed attempts above.
