# Browser execution baseline and measurement contract

## Scope

This is an incremental benchmark integration, not a replacement of Delio, its payment state machine, or its persistent sessions. The baseline runtime is frozen before an experimental kernel changes. Scripted compatibility measurements and real Jev measurements are separate cohorts. A missing model credential is BLOCKED, not a simulated agent result.

## Current execution paths

### General v5 / Glovo

`experimental/browser-runtime-v5/runtime.mjs:runLoop({page,spec,decide,onEvent,...})` is the benchmarkable general entry point. It receives a long-lived Playwright Page. `session.mjs` retains actual ElementHandles, epochs top-document navigations, and revalidates semantics before native input. `snapshot.mjs` scans the top document with `querySelectorAll`; it does not traverse frames or open shadow roots. A capture uses evaluateHandle, serialization, and usually disposal: its `protocolCalls` counter is not a count of actual CDP wire messages.

`questions.mjs` currently builds one flat action-atom Choice plus speculative fill-value and Noul questions. It is already one Jev HTTP request per step, not a frontier model per click. Only supplied values can be typed. The model cannot return selectors or executable JavaScript. `src/jev.mjs` calls the TypeSafe HTTP endpoint; `experimental/browser-runtime-v5/jev.mjs` meters calls through the v3 provider ledger. Its input-token price is an estimate, not a provider invoice.

Completion clauses are deterministic but run over the runtime's own snapshot. The older v5 fixture benchmark additionally checks server-owned fixture state. The new harness retains that independent-oracle pattern and distinguishes task completion from an action returning successfully. A stop caused by observation uncertainty can still have a verified outcome; it must be read, not retried blindly.

Glovo supplies trusted candidate scoping, known interstitial handlers, origin/path checks, request filtering, and product identity verification to this same loop. Its production navigation score is not comparable to a form-completion score.

Known source limitations to measure, not silently fix in the baseline:

- Top-document-only discovery; no open-shadow-root traversal.
- Password/file/range/color inputs omitted; no upload, popup, download or tab workflow.
- Labels do not resolve aria-labelledby. Unannotated clickable div/span/li are not discovered by default.
- Action confidence is retained incompletely and fixed floors are not calibrated against outcomes.
- The current TypeSafe documentation returns Noul `noul`; v5's resolver reads `probability`. This is a compatibility/safety-review item, not grounds to claim any particular live failure occurred.
- A stale rebind uses the first semantic match and does not prove uniqueness. This must not be promoted as a general replay guarantee.
- Fixed waits remain for context destruction (150ms), empty snapshots (400ms), and an explicit wait action (400ms). MutationObserver readiness deadlines are not fixed sleeps.
- v5 returns escalation context but has no implemented stronger-model recovery or durable learned semantic macros.

### Delio / payments

The active checkout development workspace is `/Users/buena/Documents/ChatGPT/typesafe-ai-experiment/trust-layer/delio`; the repository also contains a different copy under `agent/trust/delio`. Do not overwrite one with the other.

Delio UI -> authenticated HTTP service -> `core.mjs` per-account serialized operations -> `adapter.mjs` fixed SSH/container transport -> persistent worker -> long-lived MCP client/browser session. The worker pins the MCP runtime version, owns one profile, and reuses its session. The SSH client is started per merchant operation, not per browser action.

The merchant worker independently rereads cart lines, quantities, counts and quote amounts. `core.mjs` records pending attempts durably, rejects stale cart versions, requires reconciliation before another mutation after an uncertain outcome, validates evidence/freshness and binds authorization to a verified quote. The worker stores hashed evidence privately. Model assistance is optional for cart control selection and used for coupon controls; it is not required for every deterministic merchant operation.

`pay.mjs` binds deposits to intent references, maintains one active intent per quote, and checks existing settlement signatures before resending. The Anchor/integrated semantics and external-spend accounting are outside this benchmark patch. Do not treat browser/model cost as merchant spend. No benchmark command purchases, pays, publishes, sends messages, deletes user data or uses a payment card.

## Reference source review

All repositories were cloned for inspection, not installed as replacements. Revisions:

| Repository | Revision | Relevant implementation |
|---|---|---|
| browser-use/stress-tests | b3600b683ec97236866d77e31200fa24ec8c8f3f | challenges directory and InteractionTasks_v8.json |
| browser-use/jev-ultrafast | 1231850a0bf1a0c0341fe408ef1668dbbfdfac46 | browser.py: attached CDP session, node registry and freshness/occlusion guards; operation-specific speculative decisions; generated field text handled separately |
| jiawei686/jev-ultrafast-mcp | 48ca14379f30e2bd28a8d1ba4fc3e413b8f21d0a | cdp.py: one socket; server.py: host-driven tools and internal browser_goal loop; macros.py: semantic matching with ambiguity refusal |
| agent-labs-dev/fastbrowse | ce08a6c8f362b26174952c364f5df49a06a7783d | browser/session.py: owned tabs and OOPIF sessions; page.py: per-frame observations/guards; effects.py: semantic progress; safety.py: origin-bound secrets and authorization |
| browser-use/benchmark | 421390ea7fa4708f3d89d7695f9a16debb861daf | frameworks.ExecutionResult / run_and_judge; encrypted task loading; findings_judge.py |

Upstream code is evidence of implementation, not evidence that its accuracy or cost claims reproduce here. In particular, FastBrowse's observed-effect verification and model-assisted requirement/answer verification are not equivalent to an independently recorded merchant purchase. Jev-ultrafast's direct CDP path is not zero-call execution: guards, hit tests and native mouse/keyboard dispatch each have costs.

## New measurement layer

`npm run browser:bench` uses the existing `runLoop` seam. It creates an isolated local Chrome session and resets contexts between tasks. Official stress HTML is served byte-for-byte from the pinned checkout; the checkout must be clean. All challenge HTML files are discovered automatically, including nested iframe child documents. Missing or unreviewed oracles are UNSUPPORTED, never a guessed PASS. The local profile contains fictitious values only.

Local fixture mutation truth is stored in the HTTP server, inaccessible to the decision policy. Exact saved values, duplicate submission and forbidden actions are checked separately. Stress tasks use the application's post-completion rendered message, dialog, or console event; the secret in hidden HTML or script source is not a pass. An already-true oracle invalidates a fixture instead of awarding a free success.

The scripted driver is a fixed, generic form policy over offered action atoms. It does not know URLs, selectors, success secrets, or fixture implementation state. It exposes kernel discovery/execution limitations but is not a measurement of autonomous planning. The Jev driver uses the unchanged integration and requires TYPESAFE_API_KEY.

Run artifacts preserve configuration, git SHA plus dirty state, frozen source digests, harness digests, upstream revision, browser/provider version, model identity, environment, per-attempt journals and final journal hashes. Unknown costs or uninstrumented counters are null. Reports include task counts, attempt counts, status counts, sample sizes and descriptive Wilson intervals. Repeated runs of the same task are correlated; these are not generalization guarantees. The initial comparison gate conservatively blocks any lost paired verified pass or safety/replay violation; it does not claim statistical equivalence.

DEV and HELDOUT use a pinned hash split. Already inspected source pages are explicitly DEV. Heldout fixtures are not debugged or tuned after execution. Architecture improvements must be justified by DEV mechanisms and tested against the unchanged heldout cohort.

## Official BU benchmarks

V1's framework interface is `execute(task_description, ...) -> ExecutionResult(final_result, steps, screenshots_b64, num_steps, duration_seconds, cost)`, with `run_and_judge` owning loading/grading. V1 uses an LLM judge; its score must remain separate from deterministic outcome verification.

V2 contains 200 encrypted tasks with frozen rubrics/weights. The findings judge emits met/violated/not_assessable evidence and code computes weighted scores. This is not a binary task-success oracle and must not be relabeled one. Stealth measures provider/site reachability separately.

No encrypted tasks were decrypted or copied into prompts, reports, training data or this repository. A V1/V2 adapter and official runs remain pending: the current runtime lacks a general answer-producing/research interface, and this environment has neither model/provider credentials nor the judge key. A fake adapter returning DONE would compromise the comparison.

## Remaining work

After the measured first kernel improvement: proper malformed-decision fail-closed validation, real Jev baselines, broader form operations including scoped upload, state-based stall detection, calibrated escalation, semantic macros, multi-tab ownership, provider/session abstraction, privileged skill interfaces, authorized live task definitions, and official-framework adapter integration. Preserve existing Delio/payment contracts while extracting shared capabilities.
