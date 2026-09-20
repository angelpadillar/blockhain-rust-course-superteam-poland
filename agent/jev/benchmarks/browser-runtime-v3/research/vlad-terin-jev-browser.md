# Review: vlad-terin/jev-browser

Reviewed 2026-09-17. This review used a fresh public Git clone and read-only comparison with our v3 sources. No browser, model, or paid API calls were made during the review. No runtime/provider files were changed.

## Pinned evidence and license

- Repository: [vlad-terin/jev-browser](https://github.com/vlad-terin/jev-browser).
- Reviewed revision: [`e8649083fad5c34e8a4178cbae19fde420e010ec`](https://github.com/vlad-terin/jev-browser/tree/e8649083fad5c34e8a4178cbae19fde420e010ec), the freshly fetched `main` HEAD; commit time `2026-09-16T23:36:54-05:00`, subject “Add bounded multi-tab browser workflows”. Package version: `0.2.1`.
- [LICENSE](https://github.com/vlad-terin/jev-browser/blob/e8649083fad5c34e8a4178cbae19fde420e010ec/LICENSE): MIT, copyright 2026 jev-cua-bridge contributors. Preserve the copyright and permission notice if copying substantial source. This review recommends adapting concepts; it copies no implementation.
- Local source checkout: `/private/tmp/jev-browser-review-20260917`. Ran `node --test`: **21 passed, 0 failed**. The API tests use injected mock responses; installer tests write only their own temporary directories. No install into a user's skill directory occurred.

| Reviewed source | SHA-256 |
|---|---|
| LICENSE | `154e444e382417d321c7ff5727b38f44989aaa3c4435a652aa36a0be3f9b4cc3` |
| src/runner.mjs | `123a4fd2ff3e841f7d725c7017551bcce19b2661db4ca9c2d15d837436e70422` |
| src/selector.mjs | `e40afb9777ced72dd056cbbf13e8a896cac4474d5796a257e07d5e42884d34bc` |
| src/adapters/codex-browser.mjs | `1214b66ed78cd4b4a1d382b207669b9a3ff28f4057c830702716e846ed2cfb7e` |
| src/split.mjs | `90c23fdf17cda9150c6dd0af577d753b66c49e90d913147f2857d09b6f7d26d5` |

Our compared v3 `browser.mjs` hash is `25d416445ac2c47b1e8d53bf89da64070ad21bc6fc526eb115ff290c5f576273`; `runtime.mjs` is `4394932b281cb163298917e220725d27f80c82e8dc92f6af84658aad4c07068e`. Both match the frozen [executor cohort](../results/executor-2026-09-17T11-53-26-024Z.json). Provider/planner code was also inspected: hashes `569c48c956aefa0b31759cbbcc623220a1084fd898cebead0357c49cb4bed28a` and `465818d04da5900dfe92351f1bd2a2c0064f017430cde97afe83c8545997ed22`, respectively; those were outside the executor-only benchmark.

## What the code actually does

| Area | Evidence from pinned source | Comparison with v3 |
|---|---|---|
| DOM/candidates | [fromDOM, lines 2–14](https://github.com/vlad-terin/jev-browser/blob/e8649083fad5c34e8a4178cbae19fde420e010ec/src/adapters/codex-browser.mjs#L2-L14) parses accessible snapshot text for links, buttons, textboxes, searchboxes, comboboxes, options, menu items, tabs, checkboxes and radios. Candidate context is six nearby text lines; IDs are snapshot line numbers. | Broader roles than our input/link subset. Our `browser.mjs:48–77` captures actual nodes atomically, sends bounded labels and semantic region context, and avoids full page text. Keep our identity/privacy properties when adding roles. |
| Continuous loop | [runner, lines 4–64](https://github.com/vlad-terin/jev-browser/blob/e8649083fad5c34e8a4178cbae19fde420e010ec/src/runner.mjs#L4-L64) takes a complete bounded step list, selects, acts, then polls a supplied postcondition. It reuses the successful verification snapshot as the next step's observation. | v3 already stays inside one local loop and reuses ready observations; no new host turn is needed per action. Their useful addition is the general step contract, because our `runtime.mjs:138–160` hardcodes one search-and-open sequence. |
| Batching | [selector, lines 41–85](https://github.com/vlad-terin/jev-browser/blob/e8649083fad5c34e8a4178cbae19fde420e010ec/src/selector.mjs#L41-L85) first tries one request, then partitions oversized inputs, shortlists up to two candidates per chunk, and asks a final comparison. Concurrency, request count and reduction depth are bounded. It does not compare probabilities across different questions. | Useful overflow mechanism, not a universal speed improvement. Our provider currently rejects more than 100 candidates (`providers.mjs:99–107`); current exact-title filtering usually keeps sets tiny. Parallel splitting adds billed calls and may lose context. |
| Cache/recovery | There is **no selection or learned-workflow cache** in `src`. [snapshot fingerprint](https://github.com/vlad-terin/jev-browser/blob/e8649083fad5c34e8a4178cbae19fde420e010ec/src/snapshot.mjs#L3-L5) is a freshness checksum. The older [CUA adapter](https://github.com/vlad-terin/jev-browser/blob/e8649083fad5c34e8a4178cbae19fde420e010ec/src/adapters/codex-cua.mjs#L7-L15) reobserves and compares the whole checksum before a click. | Do not describe this as caching. Whole-page hashing can invalidate on unrelated animation. Our action-specific semantic revalidation and two bounded pre-dispatch stale recoveries are more suitable here. |
| Dispatch/verification | [DOM adapter, lines 51–81](https://github.com/vlad-terin/jev-browser/blob/e8649083fad5c34e8a4178cbae19fde420e010ec/src/adapters/codex-browser.mjs#L51-L81) checks snapshot identity and URL, then uses a unique role/name locator. It consumes the observation before side effects. Runner stops after a failed postcondition instead of replaying actions. | Keep non-replay behavior, but retain our bound-node revalidation, request guard, global deadline and independent final verifier. A new same-role/name node at the same URL can satisfy their locator checks; their own integration notes acknowledge incomplete detection of in-place changes. |
| Writer/planner | [Runner contract](https://github.com/vlad-terin/jev-browser/blob/e8649083fad5c34e8a4178cbae19fde420e010ec/skills/jev-browser/references/codex.md#L23-L29): host supplies subgoals, text values and verifier functions once. The package contains no writer model, planner model call, free-text generation, screenshot model or autonomous replanning implementation. | Our `planner.mjs` already has a separate structured planning boundary. Borrow the separation of planning from selection, not a nonexistent writer implementation. Keep generated plans as validated data; do not execute model-generated JavaScript verifier functions. |
| Multiple tabs | [Adapter, lines 17–37 and 59–76](https://github.com/vlad-terin/jev-browser/blob/e8649083fad5c34e8a4178cbae19fde420e010ec/src/adapters/codex-browser.mjs#L17-L76) owns a bounded named-tab map; switching invalidates observations; failed new-tab navigation remains visible in reports. | A useful later capability for research tasks. It does not execute tabs in parallel and is not evidence of lower latency. Our current runtime intentionally stops unexpected popups. |
| Metrics | [Client](https://github.com/vlad-terin/jev-browser/blob/e8649083fad5c34e8a4178cbae19fde420e010ec/src/client.mjs#L9-L35) emits HTTP latency/status/usage; selector emits request counts, token rejections and selection time; runner separates observation/selection/action/total. | Our ledger additionally distinguishes known/unknown cost, reserves model-call budget, and reports runtime protocol counts. Keep those. Their 80-request per-selection default is too large for our low-cost objective, and their runner has no equivalent whole-workflow deadline. |

The repository's published [evaluation methodology](https://github.com/vlad-terin/jev-browser/blob/e8649083fad5c34e8a4178cbae19fde420e010ec/evals/README.md#L1-L25) explicitly labels its timings as predecessor experiments, two trials per mode, fixed familiar plans, warm browsers and navigation/setup excluded. They are not measurements of this pinned package or a comparable opponent to our local fixtures. The release smoke artifact tests one synthetic API selection and no browser action. No speed or quality parity claim follows from those numbers.

## Three concrete improvements

### 1. Make safe form submission an explicit semantic operation — best bounded next experiment

**Evidence:** Their step contract distinguishes `fill` from `press` with a known value (`runner.mjs:9–15, 39–52`). Our v3 infers that `role=searchbox` implies a potentially live control (`browser.mjs:60–67`), then waits up to 900 ms before Enter when the same control also belongs to a safe GET form (`runtime.mjs:146–151`). Our `accessible-cards` fixture has this exact pattern: fast-mode median **1,076.003 ms**, versus **208.231 ms** for the ordinary Enter-form fixture. This is observed timing plus code evidence, not proof that all of the difference is removable.

**Adaptation:** In a new version after the current cohort freezes, compile a `submit-search` operation when the live observation shows an authorized same-origin GET form and its visible search-submit affordance. Fill and press Enter through existing native actions and fresh-node checks; begin the existing results condition wait immediately afterward. Keep `auto` behavior for uncertain controls and true live-only search. The planner may express intent, but page evidence must validate the submission capability before dispatch.

**Bounded scope:** Add the operation and fixtures for GET forms with ARIA searchbox, delayed autocomplete, Enter-only forms, stale/replaced input and forbidden form actions. Preserve action budgets, no replay after uncertain dispatch, freshness of results, and independent completion. Re-run a new matched cohort. The hypothesis is removal of approximately the 900 ms fallback on this class of forms, without an extra model call; this has not been implemented or measured.

### 2. Compile a small read-only workflow once, rather than expanding a hardcoded search routine

**Evidence:** Their runner supports a bounded array of typed actions, subgoals and postconditions; ours accepts only `query`, `targetText`, and `context`, and the planner rejects tasks needing multiple results (`planner.mjs:28–35`). The transferable idea is a general bounded program, not arbitrary generated code.

**Adaptation:** Introduce a separate validated JSON workflow with initially at most four steps: `searchAndOpen` and `openObservedLink`, plus host-defined declarative heading/URL-transition checks. Selection sees only currently allowed candidates and returns a ref or none. Use Jev only when deterministic evidence leaves ambiguity. Reuse a verified observation as the next step's starting point and return a typed `needs_help` on unsupported state instead of adding open-ended retries. Keep the independent task verifier outside the planner and chooser.

**Expected benefit, not measured:** Broader tasks can run without another large planner turn per ordinary action. v3 already avoids those turns for its existing narrow task, so this does not justify claiming a speedup on the current cohort. Start with a two-link local documentation task and duplicate labels requiring section context. Defer mutation controls and general multi-tab scheduling.

### 3. Add bounded candidate overflow, only when the single-call path cannot fit

**Evidence:** Their [partition function](https://github.com/vlad-terin/jev-browser/blob/e8649083fad5c34e8a4178cbae19fde420e010ec/src/split.mjs#L1-L28) preserves candidate coverage across chunks, and the selector uses a final comparison instead of comparing unrelated confidence scores. Our chooser boundary rejects sets above 100.

**Adaptation:** First reduce candidates by supported action and observed semantic region without discarding plausible targets. For remaining overflow, use a small cap such as two parallel shortlist calls plus one reducer, charging every call to the shared ledger and workflow deadline. Keep candidate-local context, original opaque refs and `none`. Revalidate the final target against the same snapshot/node contract. Stop if the predeclared call/cost budget cannot cover the split; do not silently truncate.

**Expected benefit, not measured:** Better coverage of large generic pages with bounded latency, at the cost of extra calls and potentially lossy shortlisting. It should remain disabled on small candidate sets. Test more than 100 candidates, a target in the final chunk, all-none results, invalid references, token rejection, budget exhaustion and DOM replacement before dispatch. Avoid copying their 80-call default or sending the whole raw page by default.

## Decision

Borrow explicit operations, the bounded workflow contract, and optional overflow selection. Keep our event-driven waits, native actions, actual-node identity checks, request policies, cost ledger and independent verifier. Do not introduce a cache based solely on this repository: it contains no cache performance evidence. Implement the safe-form submission experiment first because the frozen fixture trace already exposes a specific avoidable fallback to test; use a new source version and preserve all v3 cohorts.
