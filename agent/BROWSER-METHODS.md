# Browser-control methods — inventory and evidence comparison

Last updated 20 September 2026. Purpose: record every browser-control
method we have built or evaluated, what was actually measured, and which
pattern to generalize for the "any use case" browser goal.

All numbers below are copied from the linked reports; none are new
measurements. Small samples and fixture results are labelled as such.

## The shared winning pattern

Every deployed system uses the same loop:

1. **Observe** — Playwright/gomoufox extracts actionable DOM controls
   (role, label, type, position). Never screenshots for control.
2. **Constrain** — a task contract or job policy reduces the observed
   controls to a permitted candidate set before any model is involved.
3. **Decide** — deterministic rules first (known screens, single exact
   match); a Jev typed `choice` call only for genuine ambiguity, with a
   probability floor and a call budget.
4. **Execute + verify** — code dispatches the chosen control's own
   attributes, re-observes, and an independent check confirms the effect.
   Evidence (DOM snapshots, PNG receipts, JSONL ledgers) is saved
   privately.

Screenshots are audit evidence, not model input. No deployed system
feeds images to a model for control.

## Deployed methods

### A. `agent/multilogin` — Multilogin account pilot (VPS, live)

One isolated cloud browser profile per account; Playwright over CDP;
platform login adapters (Instagram, YouTube/Google); local TOTP;
bounded proxy rotation; stop/reopen identity verification.

| Evidence | Result |
| --- | --- |
| Instagram batch (5 profiles, concurrent) | 4 completed, 1 checkpoint |
| YouTube run (2 accounts) | 1 completed + restart-verified, 1 `signin_rejected` |
| Jev calls in final runs | **0** — fully deterministic on known screens |

Success driver: deterministic handling of every observed Google/IG
screen; Jev reserved for genuinely unknown controls. Failure mode is
account-level rejection, not adapter error.
[Details](multilogin/VALIDATION.md)

### B. `agent/jev` — Glovo prepare-only adapter (VPS, profile saved)

Task contract → restricted observed controls → Jev choice → Playwright
→ independent verifier. One onboarded persistent profile on the VPS
(`jev-hackathon` compose project, currently stopped).

| Evidence | Result |
| --- | --- |
| Live shopping eval (final adapter, 3 reps) | 3/3 passed, **10.6 s avg**, ~$0.00135/run — vs supervised Codex reference 59.2 s (~5.6×) |
| Live navigation eval | 3/3, median **13.589 s**, $0.00031/attempt |
| Controlled-shop smoke | ready_for_review in 5.79 s, 4/4 Jev calls |
| Browser fixture suite | 21–27 tests pass per release |

Known limits: merchant-specific markup; earlier dev runs failed twice
(premature `done` at p=0.72, then `unavailable`); fixed by teaching the
adapter that "Przejdź do kasy" opens the summary without paying.
[Evaluation](evaluation/REPORT.md) ·
[Method comparison](jev/benchmarks/method-comparison/REPORT.md)

### C. `buena-delio-worker` — Delio.com.pl adapter (VPS-only, NOT in this repo)

Lives at `/opt/buena-delio-worker` on `buena-prod-01`; state in
`/data/buena-delio`. Camoufox/Firefox persistent profile, same
observe→Jev-choice→verify loop, plus registration automation and
coupon/quote probing. VNC desktop on `100.121.5.10:6094`.

Evidence: `state/jev/jev-cart-choices.jsonl` — **78 real Jev choices**
(e.g. correct "Dodaj do koszyka" among neighboring products,
p=0.80–0.97, ~630 ms). Cart, quote-checkout and coupon-applied evidence
snapshots exist. `current-status.json` reports **blocked**:
merchant session, delivery confirmation and cart calibration all
unverified — an authenticated owner session was never proven.

**Action:** this source is not committed anywhere; it should be
imported before further work.

### D. Captions-editor bridge — Captions AI editor (VPS, live)

Source lives outside this repo (`captions-editor-camoufox` project);
image `buena-captions-editor-camoufox:0.1.29-9` runs the Delio worker
too. Loopback-only HTTP bridge on the persistent Camoufox profile:
`GET /snapshot` → `POST /select` (exact unique match = **0 model
calls**; ambiguous → one Jev call at ≥0.8 confidence) → `POST /actions`
(idempotency key + postcondition + receipt). Bounded job policy —
upload, fill_prompt, click, uncheck, export — nothing else is
expressible. Export is `exported_unverified` until media validation.

This is the most restrictive variant: the caller cannot supply
selectors, text, or navigation — only choose among policy-permitted
steps. It is the closest existing thing to a safe "any use case"
contract.

## Experimental runtimes (in `agent/jev`)

| Method | Result | Note |
| --- | --- | --- |
| **v3 fast goal pipeline** (Gemini Flash Lite planner → steps; Jev for ambiguity) | 8/8 fixtures @ **0.929 s** median | Fixture-only; planner cost ~$0.000016/task |
| **v3 guide comparison** | Jev 1/2 (one 15 s provider timeout), OpenRouter DOM 2/2, DOM+PNG 2/2 | Image input showed **no accuracy gain** on a text-sufficient fixture |
| **v4 continuous workflow** | Structured plans 6/6 @ 0.643 s; **prose plans 0/6** | Planner copied merchant name into product constraint (4×), chose search for a link page (2×). Corrected planner never ran live (1Password blocks) |
| **Navigation speed v1** (richer Jev prompt) | **0/2** — chose `unavailable` despite an offered submit | Prompt regression: richer structured criteria did worse than the concise baseline |
| **Navigation speed v2** (baseline prompt + fresh element binding) | 0/1 live (Glovo outage stopped the cohort) | Unproven; keep as next candidate |
| **shopping-head-to-head-v5** (Jev vs Flash Lite vs Mahmoud policy, Amazon.pl guest) | Preflight only | No comparison results yet |

## External methods reviewed (not ours)

| Source | Approach | Finding |
| --- | --- | --- |
| `awlevin/typesafe-computer-use` | macOS accessibility + Vision OCR → Jev action choice → native input | The "Jev + OCR" design. Author-reported ~1.5 s/step; cannot run on Linux VPS (macOS-only AX/Quartz); our checks found a stale-OCR-cache miss on small changes and an outcome label that defaults to `completed` — needs an independent verifier |
| `browser-use/jev-ultrafast` | DOM → batched Jev operation+target selection → CDP harness | Same family as ours; no live success evidence collected |
| `BeLazy167/typesafe-mod` | Claude Code hooks routing multiple-choice decisions to Jev | Not a browser agent; useful idea: batch independent decisions, return uncertainty to the main agent |

## What the evidence says

1. **Deterministic-first wins on success rate.** Every completed
   production run was decided by rules, not the model: multilogin's
   final YouTube run used 0 Jev calls; the captions bridge uses 0 calls
   for exact unique controls. Jev is the fallback for ambiguity, not the
   driver.
2. **Jev typed-choice is reliable when candidates are clean** —
   0.80–0.97 probabilities on real Delio candidates, ~300–850 ms round
   trips, ~$0.00002–0.00135 per task. Its measured failures were prompt
   regressions (v1) or abstention below the floor, not wrong picks.
3. **The planner is the weakest link.** Prose→plan failed 0/6 in v4;
   richer prompts regressed in nav-v1. Natural-language task
   compilation needs its own evaluation before "any use case" works —
   that is the actual gap, not browser control.
4. **OCR/vision is unproven here.** DOM+image showed no gain on
   text-sufficient tasks; the OCR-based upstream isn't portable to the
   VPS. Keep screenshot/OCR as a fallback for controls the DOM reader
   can't represent — per the method-comparison recommendation — not a
   primary channel.
5. **Independent verification is what makes "completed" real.** Every
   trusted result required a separate check (identity evidence, cart
   contents, heading+route, media probe). Model self-reports of success
   failed (premature `done` at 0.72 confidence).

## Path to "any use case"

The reusable core already exists implicitly in four codebases:
`observe → constrain → choose (rules, then Jev) → execute → verify
→ evidence`. To generalize:

1. Extract that loop into one shared runtime (site adapters supply
   observation + permission + verification; the loop is site-agnostic).
2. Import `buena-delio-worker` and the captions bridge into version
   control alongside `agent/jev` — currently VPS/external only.
3. Fix and re-evaluate the NL→plan compiler (v4's real gap) with
   held-out wordings.
4. Add OCR/screenshot fallback only behind the DOM reader's "cannot
   represent" signal.
5. Standardize the metrics every method already records partially:
   verified-success rate, wall time p50/p95, model calls/cost per
   success, fallback rate, abstention reasons.
