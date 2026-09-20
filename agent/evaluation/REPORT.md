# Glovo shopping evaluation: Codex and Typesafe Jev

Tested 16 September 2026 against the same Glovo merchant used in the Solana demo: **Duży Ben, Kraków**. No purchase or payment was made. The test basket was removed afterwards.

The final Jev adapter completed three consecutive runs in **9.6–11.7 seconds**, averaging **10.6 seconds** and **$0.00135 in estimated Jev API charges per run**. The matched supervised Codex reference took **59.2 seconds**. These are workflow measurements in this desktop environment, not a controlled comparison of standalone model API latency.

## Task and actual results

Both systems started on the same storefront with an empty cart and the configured office already selected. The task was to find and add one each of the two configured Hortex Tropical Duo 1 L drinks and the Tymbark apple–mint 1 L drink, open the final order summary, and stop before purchase. The saved account displayed all three products under “order again,” so these timed runs required finding visible products, not typing a search query.

The verified basket subtotal was **14.27 PLN**, delivery **3.99 PLN**, fees **6.98 PLN**, and final total **25.24 PLN**, below the configured 26 PLN limit. Quantities and names were checked against the last visible cart; the final checkout showed three products, the total, and the untouched “Zamów i zapłać” button. An independent evidence checker confirms the final results from saved page observations.

| Attempt | Result | Browser actions | Decisions | Elapsed time | Estimated Jev API cost |
| --- | --- | ---: | ---: | ---: | ---: |
| Codex, initial adapter | Passed | 4 | 5 | 80.4 s | Not measured |
| Jev, initial adapter | Failed: declared completion at cart | 3 | 4 | 18.2 s | $0.001266 |
| Jev, checkout completion gate | Failed: reported unavailable at cart | 3 | 4 | 8.0 s | $0.001262 |
| Jev, final adapter, run 1 | Passed | 4 | 5 | 10.6 s | $0.001343 |
| Codex, final adapter | Passed | 4 | 5 | 59.2 s | Not measured |
| Jev, final adapter, run 2 | Passed | 4 | 5 | 9.6 s | $0.001344 |
| Jev, final adapter, run 3 | Passed | 4 | 5 | 11.7 s | $0.001350 |

The first Jev failure had confidence **0.72** in its premature completion decision. Removing premature `done` was insufficient: Jev then chose `unavailable`. The successful revision explicitly explained that “Przejdź do kasy” opens the summary without placing or paying for an order. This interpretation was established by the prior Codex browser run. These are material adapter changes; the failures remain part of the evaluation.

Across **all five Jev attempts**, three passed and two failed during development. Across the final adapter's three repetitions, all three passed. Neither ratio establishes a production success rate. The API returned `jev-1.13.0`.

## Speed breakdown

For the final three Jev runs, the average 10.6-second task comprised:

| Component | Average per task |
| --- | ---: |
| Read the browser and wait for checkout rendering | 0.57 s |
| Five decision requests, including local request queue | 2.57 s |
| Four browser actions and rendered-page settling | 7.49 s |

The **15 Jev API round trips** averaged **404 ms**, median **304 ms**, observed range **233–850 ms**, sample p95 **850 ms**. Browser execution includes an 800 ms minimum stability check per action and any additional rendering delay. This time is not model inference.

The final Codex reference used the same action enumeration, completion gate, and checkout description. Its 59.2 seconds included 47.3 seconds between presenting observations and receiving assistant choices, 11.2 seconds of browser execution/settling, and 0.7 seconds of observation. The assistant interval includes desktop/tool orchestration and this conversation's context; it is **not** a measured OpenAI API response time. One browser action took about 6 seconds in that run, illustrating website variability.

The observed workflow ratio was approximately **5.6×** (59.2 / 10.6). It does not establish that Jev's underlying model is 5.6× faster than an equivalently configured standalone LLM agent. The first Jev attempt also included a pause between two tool batches; its active time was 8.6 seconds versus 18.2 seconds wall time. The successful Jev runs each ran in one uninterrupted batch.

## Cost and scale

The final Jev runs used **31,982–32,138 input tokens per task**. Applying Typesafe's published **$0.042 per million input tokens, with free output**, gives approximately **$0.00135 per successful repeated task**. All 23 Jev calls, including the two failed attempts, cost an estimated **$0.006565**. Account billing was not inspected. [Typesafe pricing](https://typesafe.ai/blog/introducing-system-one-models-and-jev)

At unchanged usage, the final Jev path would consume approximately **$1.35 per 1,000 runs**, or **$135 per 100,000 runs**, in Jev model charges alone. This extrapolates token consumption, not reliability, concurrent throughput, browser infrastructure, authentication, retries, or operational cost. Codex supervision and development are excluded. Dividing all development-run Jev charges by the three observed completions gives $0.00219 per completion; this is historical development accounting, not a forecast.

There is no isolated Codex token/billing record for these browser actions. For a transparent **hypothetical LLM API budget**, assume 32,000 uncached input tokens and 250 output tokens across five compact choice responses:

| API pricing scenario — not a measured run | Estimated cost per task | Per 1,000 tasks |
| --- | ---: | ---: |
| GPT-5.6 Luna | $0.0067 | $6.70 |
| GPT-5.6 Sol | $0.1330 | $133.00 |
| GPT-6 Astra | $0.3325 | $332.50 |

These use current standard short-context input/output rates. They are **not the Codex bill** and assume no reasoning-token overhead or repeated full conversation. Tokenizers differ; caching and smaller prompts can lower costs, while reasoning, retries, screenshots and larger contexts can raise them. No speed or success result was collected for these standalone API scenarios. [OpenAI API pricing](https://developers.openai.com/api/docs/pricing)

## Scope and safeguards

The adapter offers finite observed controls and configured query strings; Jev chooses action IDs. It does not generate browser code. All browser operations use the supported Codex Browser connection. The API worker only submits Typesafe requests and never controls the browser. It was stopped after 23 calls.

Payment/order controls are excluded. Checkout is a read-only terminal surface, and `done` is offered only after the final summary and payment boundary are visibly present. The executor rechecks current control identity and domain. It does not load the Solana agent's payment environment, card secrets, wallets, OTPs, or transaction code. Uploads remain disabled.

The previous code combines deterministic Playwright adapters with Codex supervision; it has no standalone LLM provider setting to replace. The new adapter isolates observation, model choice, execution and measurement in an additive evaluation module. The legacy payment path is unchanged.

Limitations: one merchant, one repeated basket, one signed-in account, a prepared destination, and products promoted by previous purchases. Setup, cart reset and development time are excluded from scored task duration. Earlier navigation development is preserved separately and excluded from the matched storefront comparison. Authentication, arbitrary search, unavailable products, substitutions, CAPTCHA, new addresses and concurrent load remain unmeasured.

## Artifacts

- `shopping-summary.json`: measurements, retained failures, cost assumptions and independent evidence checks; no delivery/contact details.
- `src/shopping-benchmark.mjs`: interchangeable Jev/Codex action-selection adapter and timing.
- `src/shopping-evidence.mjs`: independent cart/checkout verifier.
- `scripts/shopping-report.mjs`: regenerate the aggregate from local traces.
- `shopping-private/2026-09-16-glovo/`: gitignored request/response and observation traces. Do not publish these account-derived traces.
- The hackathon project's `agent/evaluation/` contains an additive copy of the reusable evaluation modules and usage instructions.

The result supports Jev as a cheap decision component in this constrained shopping flow. It does not support replacing the whole browser agent without explicit task-state checks and broader evaluation.
