# Browser runtime v3 — frozen fixture results

Measured on 2026-09-17. The fast goal pipeline completed **8/8 tasks at a median 0.929 seconds**, versus **8/8 at 2.051 seconds** for the stepwise mode. Both modes use the same new executor, real goal planner and Jev ambiguity handler; stepwise deliberately adds 700 ms waits after nonterminal steps. This measures the benefit of removing those waits in this workload. It is **not a comparison with the old Glovo implementation**, a Glovo retest, a deployment, or evidence of general instruction following.

The separate model-guidance comparison remains partial: 5/6 attempted tasks succeeded, then a Jev request failed with unknown usage/cost. Three planned attempts were not run. The known batch cost is **$0.000624544**, combining reported OpenRouter charges and estimated Jev costs; complete billing is unknown.

**Paid goal pipeline — all 16 planned attempts completed.** Four local catalogue cases each ran twice in each mode: Enter submission, live search, delayed detail title and semantic context. The natural-language goal was compiled by `google/gemini-2.5-flash-lite` through the pinned `google-ai-studio` provider, without provider fallback. Initial navigation and planning overlapped. Jev handled the ambiguous result choice in the semantic case; deterministic steps did not invoke a chooser. Every completion required the runtime to open the result and the external verifier to confirm origin, exact detail route, visible exact title and collection. The hidden answer route was not supplied to either model.

| Mode | Verified tasks | Total time, median [range] | Runtime only, median | Model requests | All-attempt cost |
| --- | ---: | ---: | ---: | ---: | ---: |
| Fast | 8/8 | 0.929 s [0.765–1.435] | 0.312 s | 8 planner + 2 Jev | $0.000253036 |
| Stepwise | 8/8 | 2.051 s [1.411–4.349] | 1.478 s | 8 planner + 2 Jev | $0.000253036 |

The eight matched case/repeat pairs saved a median 0.850 seconds; their median stepwise/fast ratio was 1.894. These descriptive values include provider variability: one stepwise Jev call took 2.923 seconds, versus 0.277–0.470 seconds for the other three pipeline Jev calls. Each mode used 2,102 input and 340 output tokens. Cost per verified success, including all attempts, was $0.0000316295 in either mode. This small sample does not establish a universal speedup. [Saved batch](results/paid-2026-09-17T11-55-31-045Z/batch.json), [offline summary](results/paid-2026-09-17T11-55-31-045Z/summary.json).

**Semantic guidance — 6 of 9 planned attempts ran.** All guides received the same fixed public task, with no planner call: choose an exact-title item from “the shelf for creative studio work,” where the page offers Studio and Travel shelves. The intended protocol was three rotating repeats of Jev, OpenRouter DOM, and OpenRouter DOM plus image. Each attempted row actually invoked its guide; both image rows sent an image and received a response.

| Guide | Verified / attempted | Successful total time, median [range] | Failed total time | All-attempt cost |
| --- | ---: | ---: | ---: | ---: |
| Jev | 1/2 | 0.532 s [one success] | 15.082 s | Unknown; known portion $0.000020202 |
| OpenRouter DOM | 2/2 | 1.565 s [1.285–1.845] | — | $0.000038800 |
| OpenRouter DOM + image | 2/2 | 3.609 s [3.221–3.996] | — | $0.000059470 |

The second Jev request failed after 15.004 seconds, logged as `provider_network_error` under the 15-second provider deadline. No response usage or cost arrived. The batch stopped before another task, preserving that failed attempt rather than pricing it as zero. Successful-request medians must not hide that failure. This sample cannot establish the fastest, cheapest or most reliable guide.

Pictures are an explicit optional input to the ambiguity chooser. This experiment supplied **DOM plus a PNG screenshot**, not image-only control. Both DOM arms solved both attempted cases; these two image calls show no accuracy advantage on this text-sufficient fixture. They do not test tasks requiring visual interpretation. OpenRouter costs use the returned `usage.cost`; the two image calls returned different charges despite equal aggregate token counts, so fixed list-price multiplication was not substituted for accounting evidence.

**Executor-only experiment — no model calls.** A separate run used nine completion fixtures × two repeats × two modes, plus one empty-result stop per mode. The chooser was a declared deterministic oracle, including the semantic-context mapping; this is not model reasoning evidence.

| Mode | Verified completions | Total time, median [range] | Verified empty-result stops |
| --- | ---: | ---: | ---: |
| Fast | 18/18 | 0.154 s [0.112–1.081] | 1/1 |
| Stepwise | 18/18 | 0.870 s [0.821–2.486] | 1/1 |

The 18 matched pairs saved a median 0.711 seconds. Delayed results/title, duplicate labels, DOM replacement, unrelated animation and accessible cards were included. Recorded stale-refresh counts were zero in both this run and the paid cohort, so these timings do not demonstrate recovery-path speed. There were no paid calls or model costs in this experiment. [Executor evidence and protocol](results/executor-2026-09-17T11-53-26-024Z.json).

**Accounting and measurement boundaries.** Across the paid cohort there were 22 task attempts, 21 verified successes, 26 model request attempts and 25 responses: 16 planner requests, 10 guide requests and two image requests. Known usage was 5,833 input / 775 output tokens, plus unknown usage from the failed request. The known $0.000624544 consists of $0.000523870 in reported OpenRouter charges and $0.000100674 in Jev estimates at $0.042 per million input tokens and zero output charge. The full total and full-cohort cost per success are withheld because billing is incomplete.

A separate successful planner integration probe cost $0.000026300; the earlier credential-access probe made zero model calls. They are not task attempts in either table. Including that successful probe raises the known amount for these recorded checks to **$0.000650844**, still with unknown failed-request billing. This figure excludes later public-site smoke tests, previous Glovo experiments, browser infrastructure and any unrelated account use. [Successful probe](results/openrouter-planner-probe.json), [zero-call probe](results/openrouter-probe.json).

Paid totals include initial navigation, planning, runtime, in-run journal writes and independent verification. They exclude browser/context setup, context close and final evidence writes. Planning overlaps initial navigation; runtime observation and condition waits overlap, so component totals must not be added. Paid browser launch took 0.685 seconds, and context setup had a median 0.125 seconds. Each attempt used a new context within the same browser; this does not guarantee a cold operating-system or network cache. The paid cohort used Node v26.8.1; the executor-only run used Node v24.14.0 on macOS arm64. Both recorded Chrome 153.0.8010.48. Treat them as separate experiments, not matched end-to-end ablations.

The paid source fingerprint was `712809979b43a43d10ac5addaf725f54a33127d6dab046a53a09b580d1d37d35`, including the declared transitive local source files and package lock. Start/end hashes matched; a separate offline recomputation also matched. The executor's four individual source hashes matched before/after and were independently recomputed. Per-attempt evidence agreed with the batch; all success checks, token sums, known cost arithmetic and Jev estimates were checked offline. [Analyzer](analyze_paid.py) has 12 synthetic tests and emits no page bodies, model response text, screenshots or credentials.

The supported workflow remains search followed by an observed exact result link. These controlled cases establish that the implemented path works and avoids unnecessary waiting; they do not establish performance on unseen sites, multi-tab work, arbitrary forms, free-form writing, purchases or account changes. The [JevTest source review](research/JevTest.md) recommends independently implemented verification contracts, validated workflow memory and broader typed primitives for a separate future candidate. Frozen v3 results should remain unchanged when that candidate is evaluated.
