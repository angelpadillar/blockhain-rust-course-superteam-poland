# Browser runtime v5 — stepwise general runtime

Measured on 2026-09-20. The stepwise runtime completed **8/8 fixture tasks under the real Jev model** and **8/8 under the deterministic offline oracle**. An earlier cohort with a different question shape completed **0/8 under the same model**; that batch is retained below because the failure mode is the main finding: **how the decision is asked matters more than the model**.

## What v5 is

One loop handles every step: atomic in-page snapshot → deterministic spec handlers → deterministic `done_when` check → **one Jev request** → execute → bounded operation-specific postcondition. Where v4 was a fixed two-operation `search_and_open` executor, v5's operation set is `click, fill, select, press, scroll_down, scroll_up, go_back, wait, done, blocked`, driven by a validated task spec (`goal`, `doneWhen`, `values`, `notes`, `policy`, `handlers`).

The snapshot returns real node references and enriches each control with its enclosing semantic component — a card/row/dialog label plus a short text excerpt — which is what distinguishes sixteen identical "Add to bag" links (the sightmap result this layer ports). Execution revalidates the target against a fresh scan immediately before dispatch; an uncertain dispatch is never retried. Completion requires the deterministic `done_when` clauses evaluated in code — a model's `done` is advisory only, and three premature `done` answers stop the run as `done_unverified`. Jev never receives secrets (supplied values are named keys; only values explicitly marked `reveal: true` appear in question text), never emits selectors/URLs/code, and every call is ledgered with usage.

## The question-shape finding (0/8 → 8/8)

The first Jev cohort asked **two coordinated questions per step**: an operation Choice plus a conditional per-operation target Choice. `jev-latest` produced incoherent pairs — `fill` at p=0.50 with target `none` at p=0.84 — abstained to `target_unresolved`, declared `blocked` on a solvable page at p=0.43, and scroll-spammed a non-scrollable form six consecutive steps. [Failed batch](results/jev-2026-09-20T12-31-03-775Z/batch.json): 0/8 verified, 101 calls, $0.006886 retained.

The replacement asks **one Choice over concrete action atoms** — `click@s1:e4` described as `click a "Add to bag", in card "KALLAX white 2x2" [KALLAX white 2x2 29 PLN Add to bag]` — plus the supplied-value Choice and `goal_met`/`destructive` Nouls in the same request. No cross-question coherence is required, every listed option is directly executable, and descriptions carry the field's current value and Enter-submit affordance. Same model, same fixtures, same executor: **0/8 → 8/8 verified**. Two supporting fixes rode along: scroll is offered only when the snapshot reports the page actually scrolls (`canScrollDown`/`canScrollUp`), and `go_back` only when `history.length > 1`.

A second lesson: **global ranking is a deterministic tool, not a model pick.** Unassisted, the model picked the cheapest item correctly but missed the *second* cheapest of 16 cards at p=0.36 (both retained `two-cheapest` attempts failed verification). The fixture now ships a `cheapest_adds` handler that ranks the observed card excerpts by price in code — the sightkick "named tool" pattern — and that case uses **zero model calls**. The unassisted failure is kept as evidence of where `jev-latest` needs a tool rather than a better prompt.

Third: independent verification proved its worth mid-development. `doneWhen: heading=Review order` passed on the confirm page while the submission itself had `shipping: ''` — the runtime declared success, the server-side verifier correctly failed it. `done_when` is necessary, never sufficient.

## Results

| Arm | Verified | Task time, median [range] | Jev calls | Pick time/call, median | Protocol calls, median | Batch cost |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Offline oracle ([batch](results/executor-2026-09-20T12-42-28-233Z/batch.json)) | 8/8 | 0.286 s [0.202–0.355] | 26 oracle, 0 model | — | 64 | $0 |
| Real Jev ([batch](results/jev-2026-09-20T12-42-43-845Z/batch.json)) | 8/8 | 1.839 s [0.359–3.954] | 26 | 0.378 s | 64 | $0.001308 |
| Real Jev, conditioned-op question ([batch](results/jev-2026-09-20T12-31-03-775Z/batch.json)) | 0/8 | no verified tasks | 101 | 0.318 s | 82 | $0.006886 |

Per-case (Jev arm, verified): `merchant-item` 6 calls ≈2.4–4.0 s (two search-and-open hops); `variant-bag` 2 calls ≈1.2 s (exact variant among identical controls via component context); `two-cheapest` 0 calls ≈0.36 s (deterministic tool); `delivery-form` 5 calls ≈3.0–3.3 s (three fills + select + submit).

Executor overhead is small: the offline arm shows ~10 ms per atomic snapshot, ~30–90 ms of total settle per task (bounded postcondition waits instead of fixed sleeps), 49–81 protocol calls per task, and one revalidation scan per action. Jev latency — not observation — is the residual wall time, matching the earlier finding that the model is not the bottleneck.

## Timing, cost and scope boundaries

`taskMs` covers navigation start through the last durable write inside the attempt; context setup and cleanup are separate fields. `snapMs` includes the in-page readiness wait; `settleMs` is the postcondition window after each action; `pickMs` is the injected decider's full latency including transport and ledgering. Journal/event time is reported per attempt and not folded into step components. Jev cost is estimated at $0.042 per million input tokens, zero output; every attempted call is retained and missing usage stops the batch rather than pricing at zero.

Limits per attempt: 30 steps, 40 actions, 40 model calls, $0.05 known-spend, 90 s; batch stops on accounting failure. All 16 attempts across the two arms are retained in the result directories; the failed conditioned-question cohort is retained separately.

These are four synthetic cases on a stateful local fixture. They establish the loop's correctness, its deterministic-first economics, and the question-shape effect under `jev-latest` — they do not establish performance on unseen sites, and `two-cheapest` passes *because* a deterministic tool replaces a model judgment the model demonstrably gets wrong. The Glovo live route is the planned next arm before any production claim.

## Live arm: the Glovo Kraków navigation route

The same unmodified runtime was driven against production Glovo via a declarative adapter (`glovo.mjs`): stage-aware candidate filtering replicating the v3 route's offerable set, deterministic handlers for the closed-store notice and the task-scoped age confirmation, a mutation/navigation request guard, and `doneWhen = url=/stores/ ∧ url=productId=… ∧ url=externalProductId=… ∧ text=<product>` — the URL half plus visible text, with the stricter v3 `verifyNavigation` (store slug, both product ids, exact visible dialog title) as independent verification.

**Verified passes** (batches retained on the VPS evidence volume — `glovo-v5-2026-09-20T14-40-25-811Z`, `glovo-v5-2026-09-20T15-02-14-895Z`): **3/4 site-available attempts `reached_target`**, all four verification checks true — 14.06 / 14.50 / 14.26 s task time, 19–20 steps, 14–15 Jev calls, $0.00103–$0.00109 per run, vs the v3 route's 13.6 s median. Path every time: homepage search → merchant click → deterministic closed-store dismiss → `Rum i gin` → age confirm → subcategory → product tile → modal → `done_when`. The one failed attempt in the second batch and several earlier probes ended `merchant_site_unavailable` — Glovo's IP-level bot wall ("Oh, no!" page), an external gate, not a runtime failure.

The live arm surfaced five failure classes the fixtures could not, each fixed without weakening a safety invariant:

1. **Dialog scope hides the page.** Any visible `[role=dialog]` scopes the snapshot — Glovo's closed-store modal re-appears on `?search=` URLs, shrinking the observable page to ~18 modal controls.
2. **False affordances burn steps.** The in-store search accepts typed input but `?search=` renders the unfiltered menu; the model repeatedly chased it. Removing that control from in-store candidates (homepage search unaffected) made the category path the only one offered.
3. **Navigation grammar drift.** Glovo's `section`/`sectionId` scroll params postdate `navigationUrl`'s param whitelist; a same-store link carrying them was denied as `outside_navigation_scope`. The adapter wraps the shared grammar — it does not modify it.
4. **Handlers racing dialogs.** An open dialog that is *not* the age gate made the age handler's `waitFor` time out into `retry` until the handler budget died post-goal — `count()` before `waitFor` distinguishes "absent" from "animating".
5. **Skeleton snapshots.** URL params update before modal content renders; a `no_candidates` snapshot mid-transition was fatal one beat too early. Empty snapshots now get two bounded re-observations, and clicking the spec's named target waits on a `product_opened` goal (dialog bearing the name, or navigated page showing it as a heading) instead of any-change.

Model cost per verified run is ~$0.001 — the route remains deterministic-first where the site is deterministic (dialogs, guards), and Jev spends its calls only on navigation ambiguity (search box vs links vs categories). Across the three passes the step structure is identical; the remaining slack vs v3 is 4–6 exploratory scrolls on the parent-category page (~3–4 s) — a pick-quality item, not an executor one. Glovo's bot wall remains the gating external factor for batch size: runs launched while it is hot fail fast as `merchant_site_unavailable` before any step executes.
