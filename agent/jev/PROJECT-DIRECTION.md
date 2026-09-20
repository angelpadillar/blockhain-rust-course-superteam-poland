# Prompt or task → executed and independently verified

Saved 16 September 2026 from the account holder's project instructions.

The hackathon goal is an agentic payments system on the existing Hetzner VPS, starting with Glovo and expanding merchant by merchant. Jev should control the browser through an adapter with Playwright. Optimize instruction following, completion rate, elapsed time and total cost per completed task. Preserve unsuccessful attempts as well as successes.

## Current authorized task

Start at the Glovo Kraków homepage, find Foczka Alkohole and open the exact Bacardi Blanco 0,7l product identified in `cases/foczka-navigation.json`. Finish only when the store, both product identifiers and visible product title agree. No basket changes, scheduled orders or purchases during this navigation evaluation. File uploads remain blocked. The account holder has explicitly authorized repeating the exact existing 18+/alcohol-terms declaration for this case only; that authorization is not a model decision.

The saved case retains a human-readable instruction and a validated task contract. The executable fields define the supported task. Arbitrary prose is not yet compiled into arbitrary browser actions; an `instruction` field is provenance, not permission to override the contract. Custom cases can be passed with `--task=path/to/case.json`, within the same Glovo navigation schema. No universal merchant support or production payment execution is claimed.

## Execution design

1. Convert the request into an explicit task: merchant, exact product, destination, quantity/budget where relevant, and an allowed stopping point. For now this is a supplied task file. A general prompt interpreter remains future work.
2. Code determines whether the browser is finding the merchant or finding the product. Jev makes one narrow choice among observed, allowed controls. Other stores and substitute products are excluded from this navigation task.
3. Known informational dialogs are handled by fixed, scoped UI operations. Age/terms acceptance requires the account holder's existing authorization. Unknown dialogs, authentication and challenges stop for attention.
4. Save the task, source fingerprint, model request/response, confidence, probabilities and pending action before execution; save the action outcome and independent verification afterward. Journals live in the private data volume. A failed journal write prevents the next action. Interrupted work is marked for inspection, never replayed automatically.
5. Verify the result independently of the model. A valid response shape or high confidence is not proof that the requested task was completed. Navigation never executes payment.

For open-ended requests, the proposed next layer is a general-purpose planner that compiles intent into this contract, with Jev handling frequent browser decisions and the adapter checking results. A larger-model fallback has not been implemented or measured. Broader merchant adapters should reuse the same contract, verifier and journal, while supplying their own page readers and controls.

## Research implications

[TypeSafe's introduction](https://docs.typesafe.ai/introduction) recommends atomic judgments composed in code. Its Choice/Score/Noul primitives are structured decisions; Jev does not generate arbitrary search strings, browser programs or plans. The adapter supplies permitted actions and strings.

[Confidence documentation](https://docs.typesafe.ai/confidence) defines confidence as a statistic of the probability distribution. It is distinct from the selected option's probability. Both are now retained for evaluation. Neither the example thresholds in the pasted context nor vendor examples have been validated for our browser tasks; no claimed “95% reliable” payment policy follows from them.

[The launch article](https://typesafe.ai/blog/introducing-system-one-models-and-jev) publishes $0.042 per million input tokens and free output. Its headline speed/cost multipliers describe vendor workflows and are explicitly characterized as high-end gains. Their comparison uses a structured probability-output wrapper around the LLMs. Those figures do not establish equivalent gains in Glovo completion or payment execution.

## Evidence required before expansion

Freeze the adapter and task, run repeated attempts from the same starting conditions, and compare independently verified completion, task duration, model latency, known token cost, unknown usage, fallback cost and operator interventions. Include failed attempts when calculating cost per success; report it as unavailable if there are no successes. Record model aliases and returned versions, since `jev-latest` can change.

The earlier three-drink checkout preparation pilot and the newer homepage-to-product evaluation are different tasks and must remain separate. The homepage-to-product evaluation completed three consecutive live attempts after the 17 September product-view guard correction, under one account and delivery area. That is limited task-specific evidence, not general reliability. Neither pilot is a like-for-like Astra/Fable API benchmark. Use Codex as the reference as requested and label its cost as estimated/unavailable where token accounting is missing.

Next merchants should be added only after the Glovo route can complete repeatedly under the actual account and delivery area. Payment settlement, wallet integration and any live purchase require their own implementation and authorization.

## Speed objective and source comparison — 17 September 2026

The user explicitly prioritizes developing the fastest browser agent. Optimize elapsed time and total cost per independently verified completed task, while reporting success rate and failed attempts. A faster refusal, classifier call or unverified DONE is not a completed-task speedup.

Reviewed `browser-use/jev-ultrafast`, `BeLazy167/typesafe-mod` and `awlevin/typesafe-computer-use`. The first is a DOM/CDP browser loop, the second a Claude Code decision/skill hook, and the third a macOS accessibility/OCR interaction loop. Their shared useful pattern is bounded Jev judgments composed with deterministic execution. Both general interaction loops still use a writer for novel field text. Known merchant/product strings in our validated task can already be copied by code.

The earlier Glovo trace identified product rendering rollback and repeated readiness waits: all six product clicks initially produced the correct IDs, then lost them before independent completion. Sanitized route diagnostics and Glovo's public frontend source identified an incorrectly blocked product-display POST nested under a store-address path. The correction permits only the exact API route, requested product identifiers and ordinary-view body. It retains true mutation blocking and now covers singular `/address` too. Retries are bounded by semantic target, including brief asynchronous navigation events, and independent completion returns immediately.

The corrected adapter completed 3/3 live attempts in 13.245–13.897 seconds (median 13.589), with seven Jev calls and $0.00031479 estimated model cost per attempt. These measurements include authorized age confirmation and journaling, exclude browser launch/setup/infrastructure, and establish only this navigation case. No basket or purchase action executed. The full comparison, source revisions, failed attempts and sanitized results are saved in `benchmarks/method-comparison/REPORT.md`.

Browser-native DOM/accessibility state remains the primary implementation on Linux; OCR is a fallback to evaluate for missing controls. The next speed work should reduce unnecessary settling and action count while preserving verified completion and measuring new attempts separately from this fixed-version baseline.

## Fresh element decisions — user-shared examples

The user's target/command/Noul examples are saved with verified interpretation in [BROWSER-DECISION-DESIGN.md](BROWSER-DECISION-DESIGN.md). The useful next candidate adds concise `what`, `where` and adapter-derived `supports` context with snapshot-scoped references. Keep deterministic checks and bounded recovery in code; a larger LLM is optional for unfamiliar planning/recovery. Noul is a yes-probability, not a Boolean guarantee. Batched questions are independent, so the executor must validate target/command compatibility or keep the current joint allowed-action Choice. This direction is now implemented in separate experimental candidates; the baseline runtime remains unchanged. The richer v1 prompt regressed after search entry. V2 restores the exact baseline model prompt while keeping snapshot-bound execution, bounded stale recovery and transition-aware readiness. Its live attempt submitted search correctly but encountered Glovo’s unavailable page. Across all eight new benchmark attempts, the baseline completed 3/5 (successful median 14.022 seconds), v1 0/2 and v2 0/1. All attempts cost $0.001270542 in estimated model API usage, including failures. No candidate completed-task speedup is established. See [the retained benchmark](benchmarks/navigation-speed-v2/REPORT.md); keep the baseline default until a candidate completes the same route reliably.

## Recommended next architecture after the candidate benchmark

The next design prioritizes verified browser operations, relevant-state readiness and reusable parameterized workflows, with Jev resolving ambiguity and a planner handling unfamiliar goals. In the three successful traces, all model latency was only about 2.08 of 14.02 seconds; observation/readiness dominated. A faster model alone has limited upside on this route. Keep the existing adapter as a configured regression case, and isolate expected URLs/IDs from the policy in the next general instruction-following evaluation. The concrete module boundaries, first search-and-open operation and two-stage benchmark are saved in [FAST-BROWSER-PLAN.md](FAST-BROWSER-PLAN.md). This is an implementation design, not a newly deployed or measured runtime.

## Implemented general browsing candidates — later on 17 September 2026

The user authorized an inexpensive OpenRouter planner and supplied the 1Password item reference `OpenRouter API Key - buenaapp`. The isolated v3 candidate now compiles a natural-language search task with Gemini 2.5 Flash-Lite, executes native search/open operations, and calls Jev only for ambiguous observed choices. Its complete controlled paid pipeline measured 8/8 fast runs at median 0.929 seconds versus 8/8 at 2.051 seconds with the same new runtime plus fixed waits. This is not the old Glovo comparison. A separate guide experiment stopped after a Jev timeout with unknown billing. All evidence, failures, model activations and measurement limits are retained in [the v3 report](benchmarks/browser-runtime-v3/REPORT.md).

The user then requested reviewing CorieW/JevTest, vlad-terin/jev-browser and MahmoudAdelbghany/jev-browser and incorporating their best concepts. The new [v4 candidate](experimental/browser-runtime-v4/README.md) adds a bounded continuous plan of up to four search-and-open or already-visible-link operations, preserving fresh references, literal arguments, task context, operation postconditions, durable evidence and explicit escalation. Repository source reviews are retained under `benchmarks/browser-runtime-v3/research/`. Concepts are implemented independently; JevTest's current source is unlicensed.

The existing Glovo service, case and successful baseline remain separate. V4's source, tests and measurements are saved for review; it is a limited read-only browser prototype, not universal site support, a new production deployment or payment execution. Expand supported native controls and merchant workflows using independent completion checks before adding later transaction capabilities. Screenshots remain an optional ambiguity aid; complete model and browser time, failed requests and infrastructure costs matter more than isolated inference headlines.
