# Navigation speed candidate v1 — retained regression

The first live candidate did not complete either attempt. Do not promote it or describe its short failures as a speedup. The unchanged baseline completed two attempts, then Glovo returned its own unavailable page at the start of the fifth run and the prespecified stopping rule ended the batch. The sixth planned attempt was not run.

| Attempt | Arm | Result | Navigation time | Jev calls | Estimated API cost |
|---|---|---|---:|---:|---:|
| 1 | Baseline | Verified | 14.874 s | 7 | $0.000314790 |
| 2 | Candidate v1 | Model chose unavailable | 2.773 s | 2 | $0.000129864 |
| 3 | Candidate v1 | Model chose unavailable | 2.639 s | 2 | $0.000129864 |
| 4 | Baseline | Verified | 13.356 s | 7 | $0.000314790 |
| 5 | Baseline | Glovo unavailable page | 0.109 s | 0 | $0 |

Baseline completion was 2/3 observed attempts; candidate completion was 0/2. Baseline completed-time median was 14.115 seconds. Candidate completed-time and cost per verified success are unavailable because it had no successes. All five attempts cost an estimated $0.000889308 combined; usage is complete. Estimates use the configured $0.042 per million input tokens and free output, excluding infrastructure, account setup and operator time. All returned models were `jev-1.13.0`.

Both candidate attempts correctly filled the city search and then selected `unavailable`, although the next Choice offered “Submit search for Foczka Alkohole.” The target was not missing. The candidate supplied structured element descriptors and different instructions/history; the baseline supplied its proven concise action descriptions and stage-specific instruction. This identifies a decision regression, but does not isolate which prompt difference caused it. No fast-readiness branch or stale recovery ran before the candidate stopped.

Keep this entire cohort and its frozen sources. A separate v2 restores the unchanged baseline model request while retaining candidate element binding, bounded stale recovery and readiness; its results must be reported separately. The baseline runtime remains unchanged. No basket or purchase action occurred in this batch.

Evidence: [public per-attempt and aggregate results](results/comparison.json), [frozen protocol](protocol.json), [method](PROTOCOL.md), candidate/harness sources under `source/`, and the original successful baseline under `baseline/`. Raw batch and durable journals remain private. Five observed attempts, one product/account/region, fixed ordering, persistent profile/cache and an early site outage limit inference. There is no paired completed-task speedup in this cohort.
