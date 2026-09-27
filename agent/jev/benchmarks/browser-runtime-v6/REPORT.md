# Browser runtime v6 — recursive frame and Shadow DOM observation, scoped file upload, one-call form protocol

Measured on 2026-09-21 against the frozen v5 baseline, identical suite, identical scripted driver, five repeats per task. **Scripted-driver rows measure kernel discovery/execution compatibility, not autonomous Jev task success.** A `TYPESAFE_API_KEY` became available after the frames round; one real-Jev smoke task ran (see *Real-Jev evidence*) — the full Jev cohort is a separate measurement.

- Baseline run: `agent/jev/bench/results/2026-09-21T09-52-40-023Z-59b0d837/` (`baseline` mode, frozen-v5 source digests verified clean at run time)
- v6 frames run: `agent/jev/bench/results/2026-09-21T10-24-46-943Z-fb2db751/` (`frames` mode)
- v6 frames+upload run: `agent/jev/bench/results/2026-09-21T11-00-35-106Z-3682eb7c/` (`frames` mode; local suite gained `file-upload`, so 385 planned runs vs 380)
- Comparisons: `agent/jev/bench/results/comparison-2026-09-21T10-24-46-943Z-fb2db751/comparison.json`, `agent/jev/bench/results/comparison-2026-09-21T11-00-35-106Z-3682eb7c/comparison.json`
- Artifact check: frames run `valid:true` (380 rows, 315 journals); frames+upload run `valid:true` (385 rows, 320 journals); no violations

## What changed

v5 scanned only the top document (`querySelectorAll`), so every control inside an iframe or open shadow root was invisible to the observer, the model, and the executor. v6 adds:

- **Recursive frame observation.** Every permitted Playwright frame contributes controls to one composite snapshot. Candidates carry frame-path context; targets retain frame lineage and per-frame generations, so a child-frame navigation invalidates only that frame's references. Cross-origin frames require an explicit `allowedFrameUrl` grant; same-origin frames are in scope by default.
- **Recursive open-shadow-root traversal.** `parentOf`/`queryDeep`/`closestDeep` cross shadow boundaries; `aria-labelledby` resolves inside the owning root; `checkVisibility` rejects hidden hosts; mutation observers attach to newly discovered roots.
- **Atomic composite-snapshot consumption.** The whole snapshot is consumed before dispatch, so an uncertain or stale action cannot be replayed from it. Pre-dispatch revalidation returns the fresh selected index, which fixes a DOM-index-shift mispatch found during testing.
- **Per-frame postcondition baselines.** A no-op in a child frame is no longer misreported as top-document navigation; `beforeUrl`/`beforeTitle` come from the selected frame's own observation.

v5 is untouched under `agent/jev/bench/frozen-v5/` and remains the `baseline` mode.

### Second change: scoped file upload

The frames run's largest measured gap was `FILE_UPLOAD_UNSUPPORTED` — 8/42 dev-stress tasks blocked on a required file input (−26.7 pts). v6 now supports an `upload` operation under the same trust boundary as secrets:

- **Task spec authorizes files.** `spec.files` maps key → absolute local path, validated by `v6/policy.mjs` (keys must resolve inside the declared file directory). The model sees only the key; paths and contents never enter a Jev request.
- **Snapshot surfaces file inputs** as `kind:'file'`, `supports:['upload']`, with `accept`/`required` preserved. Unlabeled file inputs fall back to `name`/`id` as the accessible label (a standard fallback, needed because several stress pages ship bare `<input type=file>`).
- **Separate value choice.** Jev picks `upload@<ref>`, then a `file_value` choice over declared keys. Trusted code resolves the key to a path.
- **Dispatch** is `ElementHandle.setInputFiles` plus explicit `input`/`change` events — Playwright's `localPaths` path resolves via CDP `DOM.setFileInputFiles` without waiting for the page's `change` listener, so verification could race the handler.
- **Verification polls.** `.success-message` fixtures animate `opacity: 0→1` over 300 ms; a single-sample oracle rejected them mid-transition. `verify(waitMs)` now polls rendered visible text / console / dialog evidence to a bounded deadline (400 ms per step, 2 s final). Hidden/source-only text still never counts.
- Upload authorization grants nothing else — checkout, payment, account changes remain gated exactly as before.

### Third change: one-call form protocol (`fill_form`)

The single-action loop asked Jev "which one action" per step — a 12-field form cost 12+ calls and the model stalled on sequencing. The step request is now a batched assignment: one Jev call answers every field at once.

- **Per-field questions ride the action choice.** `buildStepRequest` emits `field_<ref>` (which supplied value key), `sel_<ref>` (which option), `file_<ref>` (which file key), `check_<ref>`/`radio_<group>` (toggle intent), and `submit` (which click candidate after the plan). Values and paths stay server-side; selects present readable keys (`o1_alabama`, not `o1`) mapped back to option indices internally.
- **`fill_form` is a meta-atom.** The model's per-field answers only execute when it (or the soft-verdict override) selects `fill_form`; individual fill/select/upload atoms leave the action choice so there is exactly one assignment channel. Toggle controls leave the click atoms too — a bare click is a blind state flip; `check_`/`radio_` express "should be selected" instead.
- **Radio groups are one question.** A named group is a single `radio_<group>` choice over member labels with a computed group label (`legend`, or the non-member `label` inside the members' common ancestor). Three independent "tick this?" questions were unanswerable; "which option?" is not.
- **Deterministic sequential executor.** The plan runs in document order; each item resolves against the pinned decision snapshot first, then semantically rebinds against a fresh capture after every dispatch. A mid-plan rerender cannot produce stale dispatches; a `StaleBeforeDispatch` item records `stale` and the plan continues (never retried); `uncertain_execution` still aborts the run.
- **Toggle assignments are idempotent.** `check`/`radio` mean "should be selected" — a control already checked at dispatch is a confirmed no-op, not a click that would invert it. `checked` joined the control semantics, so a mid-flight toggle fails pre-dispatch revalidation.
- **Validation feedback is observable.** Client-side rejection renders error text / fires `alert()` without touching any control — indistinguishable from a dead click before. Snapshots now digest leaf-most visible `[role=alert]/error/invalid/warning` text plus captured dialog messages (`page.on('dialog')`, always dismissed — accepting a confirm could authorize), merged across all permitted frames, counted as `change`, and surfaced to the decider as `state.feedback`. `required` now covers `aria-required`, the trailing-`*` label convention, and `label-required`-style classes — JS-only validators (RHF, Ember changesets) carry no attribute.
- **Fixture health is registry metadata, not an exclusion.** `ember-form` (its own `submitForm`/`updateCountry` throw `TypeError` on any click — verified by manual dispatch) and `shadow-dom-form` (`collectFormData` queries `[slot="input"]:checked` but the priority radios sit inside a slotted div without their own slot attrs — `formData.priority` can never exist) carry `fixture_health.status=BROKEN_UPSTREAM` with evidence in the harness layer (`bench/suite.mjs` `FIXTURE_HEALTH`). They still run, still spend model calls, and still count in the **RAW** score exactly as shipped; only the **DIAGNOSTIC** score may exclude them. The runtime never sees task names.

## Results (scripted driver, kernel compatibility)

| Group | Tasks | Attempted | Verified success | pass@1 | ttv p50 | ttv p95 | Jev calls | Escalations | Cost/success | Protocol ops mean |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| baseline dev/local | 16 | 80 | 30/80 (37.5%) | 37.5% | 909 ms | ~1320 ms | 0 | 0 | n/a | 19.6 |
| v6 dev/local (frames) | 16 | 80 | 60/80 (75.0%) | 75.0% | 924 ms | 1335 ms | 0 | 0 | n/a | 30.3 |
| **v6 dev/local (+upload)** | 17 | 85 | **65/85 (76.5%)** | 76.5% | 929 ms | 1334 ms | 0 | 0 | n/a | 30.1 |
| baseline heldout/local | 4 | 20 | 10/20 (50.0%) | 50.0% | 902 ms | n/a | 0 | 0 | n/a | 19.0 |
| **v6 heldout/local (+upload)** | 4 | 20 | **20/20 (100.0%)** | 100.0% | 912 ms | 1016 ms | 0 | 0 | n/a | 39.0 |
| baseline dev/stress | 42 | 150 | 35/150 (23.3%) | 23.3% | 2019 ms | 3640 ms | 0 | 0 | n/a | 51.5 |
| v6 dev/stress (frames) | 42 | 150 | 50/150 (33.3%) | 33.3% | 2284 ms | 3559 ms | 0 | 0 | n/a | 80.7 |
| **v6 dev/stress (+upload)** | 42 | 150 | **85/150 (56.7%)** | 56.7% | 4520 ms | 9136 ms | 0 | 0 | n/a | 88.1 |
| baseline heldout/stress | 14 | 65 | 5/65 (7.7%) | 7.7% | 1179 ms | n/a | 0 | 0 | n/a | 45.4 |
| **v6 heldout/stress (+upload)** | 14 | 65 | **10/65 (15.4%)** | 15.4% | 3324 ms | n/a | 0 | 0 | n/a | 48.2 |

Regression gate (`compare.mjs`): baseline→frames was `NO_OBSERVED_REGRESSION` (380 paired runs, zero lost passes). Baseline→frames+upload pairs on the 380 shared tasks — also **zero lost passes, zero new safety/replay violations**; the gate reports `NOT_COMPARABLE` only because the suite gained `local/file-upload` (385 vs 380 planned). The gate is conservative: any single lost pass would have blocked an improvement claim; it is not a proof of statistical equivalence (repeats are correlated).

Protocol ops is a wrapper-operation counter, not a true CDP wire round-trip count; real wire instrumentation remains open. Cost/success is `n/a` because the scripted driver performs no inference and local browser cost is unpriced — it is not `$0`.

## Which tasks changed

### Frames round (baseline → v6 frames)

Nine dev tasks went 0/5 → 5/5, all explained by the single mechanism (descendant browsing contexts were invisible):

- `local/iframe`, `local/nested-iframe`, `local/dynamic-iframe`, `local/cross-origin-iframe`
- `local/shadow`, `local/nested-shadow`
- `stress/iframe-inception-form`, `stress/iframe-inception-level1`, `stress/iframe-inception-level2`

`iframe-inception-level1` specifically: v5 offered **zero** candidates (its deepest form lives two frames down); v6 exposes the descendant controls and passes 5/5 through the general kernel — no page-specific handling.

Heldout flips are the same shape: `local/heldout-frame-form` and `local/heldout-shadow-form` 0/5 → 5/5; the two non-frame heldout fixtures were already passing and stayed passing.

### Upload round (v6 frames → v6 frames+upload)

Eight dev-stress tasks went 0/5 → 5/5 — exactly the population the capability analysis predicted:

- `stress/file-upload` (the dedicated challenge)
- `stress/hidden-labels-form`, `stress/svelte-form`, `stress/table-form`, `stress/vanilla-form` (were UNSUPPORTED — required file input)
- `stress/formik-form`, `stress/react-hook-form`, `stress/vue-form` (were VERIFIER_FAILED — the file input silently blocked submission)
- New `local/file-upload` fixture: 5/5.

Six more tasks moved UNSUPPORTED → attempted but still fail on *other* widgets (upload now works, remaining controls don't): `angularjs-form` (FORM_VALIDATION), `animated-form`, `ember-form`, `graphql-form`, `non-latin-form`, `progressive-form`, `rich-text-form`.

Heldout: `stress/svelte-form` UNSUPPORTED → 5/5 — a heldout form with a required file input. No heldout trace was inspected for tuning; this is the same general capability.

## Failure taxonomy after both changes (dev, ranked by lost verified success)

1. **UNSUPPORTED — 60 runs, 0 attempted (stress).** 12 tasks whose required operation (drag, tap-hold, calendar, map, multi-select, phone widget, captcha, signature pad) does not exist in the runtime or driver — labeled, never attempted.
2. **VERIFIER_FAILED — 60 runs, −40 pts (stress).** 12 tasks: animated-form, arrow-key-presses, contenteditable-div, ember-form, graphql-form, material-ui-form, non-latin-form, progressive-form, reference-number-form, rich-text-form, shadow-dom-form, slider-drag. Discovery works on several of these; the residual gap is *widget interaction policy* — custom selects, sliders, hover/keyboard widgets, non-Latin validation, rich text.
3. **VERIFIER_FAILED — 20 runs, −25 pts (local).** clickable-div, clickable-span, clickable-li (non-semantic pseudo-buttons still undiscovered — intentionally unchanged), rerender (stale-after-rerender semantics under the fixed policy).
4. **UNCERTAIN_RESULT — 5 runs, −3.3 pts.** jquery-bootstrap-form (Select2): fills dispatched, outcome unverified — correctly not retried.
5. **FORM_VALIDATION — 5 runs.** angularjs-form: upload dispatches; remaining field validation fails.

## Capability matrix (v6 frames+upload, verified/attempted)

| Capability | Local | Stress (pinned rev) |
|---|---|---|
| iframes | 5/5 | inception ×4 (incl. level3): 20/20 |
| nested iframes | 5/5 | 5/5 |
| dynamic iframe | 5/5 | n/a |
| cross-origin iframe (granted) | 5/5 | n/a |
| Shadow DOM | 5/5 | shadow-dom-form 0/5 (discovery works; widget policy gap) |
| nested Shadow DOM | 5/5 | n/a |
| **file upload (declared-key)** | **5/5** | **file-upload 5/5; unblocks 7 framework forms** |
| native form | 5/5 | angular, checkbox, date-time, radio, search, vanilla, table, hidden-labels, i18n: pass |
| framework forms | n/a | formik, react-hook-form, react-final-form, svelte, vue: pass |
| custom controls | 1/4 tasks | Select2/MUI/slider etc.: fail |
| dynamic forms / rerender | late-control, delayed-response pass; rerender 0/5 | dynamic-form, conditional-fields fail |
| rich text / contenteditable | 5/5 | contenteditable-div/-form, rich-text: fail |
| autocomplete | n/a | advanced-autocomplete: UNSUPPORTED |
| popups / tabs | not covered | not covered |

## Real-Jev A/B/C (the primary measurement)

Three arms, identical conditions — `jev-1.13.0`, Chrome 153.0.8010.48, stress `b3600b68`, suite `1f1a2a34`, N=3 per task, max 15 s/25 steps, same oracles/values/files/network policy:

- **A** — frozen v5 + real Jev (`--mode baseline`)
- **B** — v6 kernel + real Jev, legacy one-action-per-call protocol (`--mode frames --no-batch`)
- **C** — v6 kernel + real Jev, batched `fill_form` (`--mode frames`)

`--no-batch` is the only behavior difference between B and C: plan questions are not built, so Jev sees the original atom list plus the shared `fill_value`/`file_value` heads. Dev cohort: 59 tasks (47 oracle-valid — 12 carry `oracle_not_reviewed`: CAPTCHA, calendars, maps, signature pad — never attempted in any arm). Heldout: 18 tasks, run once per arm, no per-failure inspection.

| Arm | Tasks | Runs | Verified (RAW) | Verified (DIAG) | pass@1 | p50 | p95 | calls/task | Jev ms/task | $/task | $/verified | actions/task | ops/task |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| A v5 dev | 47 | 141 | 21.3% (30) | 22.2% (30/135) | 21.3% | 1788 | 4417 | 2.99 | 940 | $0.0002 | $0.0011 | 1.9 | 27.7 |
| B v6-legacy dev | 47 | 141 | 36.9% (52) | 38.5% (52/135) | 36.9% | 1497 | 4334 | 3.18 | 975 | $0.0003 | $0.0008 | 1.7 | 29.4 |
| **C v6-batch dev** | 47 | 141 | **65.2% (92)** | **68.1% (92/135)** | **65.2%** | 1576 | 6793 | 3.90 | 1195 | $0.0003 | **$0.0005** | 8.2 | 95.4 |
| A v5 heldout | 17 | 51 | 17.6% (9) | = RAW | 17.6% | 1467 | 2039 | 4.45 | 1339 | $0.0003 | $0.0017 | 3.0 | 40.8 |
| B v6-legacy heldout | 17 | 51 | 29.4% (15) | = RAW | 29.4% | 1456 | 2359 | 4.96 | 1419 | $0.0003 | $0.0009 | 3.2 | 45.3 |
| **C v6-batch heldout** | 17 | 51 | **41.2% (21)** | = RAW | 41.2% | 1231 | 2617 | 5.27 | 1549 | $0.0004 | $0.0010 | 11.9 | 127.2 |

DIAG = RAW minus the two `BROKEN_UPSTREAM` fixtures (6 runs/arm on dev; none exist in heldout). pass@1 equals verified success — the harness performs no task restarts.

**Multi-field forms specifically** (capability `form-fill`/`form`, dev, 48 runs/arm): A 6/48 pass, B 7/48, **C 36/48 (75%)** — at *fewer* calls/task (3.02 vs 3.63) and lower cost/task ($0.0003 vs $0.0006), because one decision fills every field (10.1 actions/task vs 1.9). The architecture claim is confirmed quantitatively: one Jev decision → many bounded field assignments → deterministic executor → independent verifier.

Failure-status counts (dev): A — 33 STALL, 27 UNCERTAIN, 21 IFRAME_UNREACHABLE, 10 FILE_UPLOAD_UNSUPPORTED, 9 VERIFIER_FAILED, 6 SHADOW_DOM_UNREACHABLE, 3 REPLAY_VIOLATION, 2 NETWORK_TIMEOUT. B — 47 STALL, 28 UNCERTAIN, 8 VERIFIER_FAILED, 3 REPLAY_VIOLATION, 3 FORM_VALIDATION. C — 40 STALL, 3 UNCERTAIN, 3 VERIFIER_FAILED, 3 REPLAY_VIOLATION. Heldout C: 22 STALL, 5 NETWORK_TIMEOUT, 3 FORM_VALIDATION (aggregate only — heldout journals uninspected by policy).

Earlier smoke evidence (pre-A/B, repeat-1): stress dev 18/28 valid, local dev 13/17, median ~2 calls, $0.0087 total — superseded by the N=3 numbers above.

## Regressions

None observed across either round. Both paired comparisons found zero lost verified passes. Protocol-op count rose (19.6→30.1 local mean) as a direct cost of observing more browsing contexts — expected, not a correctness regression.

## Next priority (data-supported)

**Custom-widget interaction cluster** — the largest remaining real-Jev residual: Select2 (`jquery-bootstrap-form`), MUI (`material-ui-form`), slider/drag, rich-text/contenteditable, and the `clickable-*` pseudo-elements. These are discovery/interaction capability gaps, not sequencing. Then the heldout real-Jev cohort (never inspected for tuning).

## Reproduce

```sh
npm run test:browser:kernel            # 19/19 v6 kernel tests
npm run test:browser:bench             # 10/10 harness tests
npm run browser:bench -- --mode frames --driver scripted --suite all --split all --repeat 5 --max-ms 15000 --max-steps 25
npm run browser:bench -- --mode baseline --driver scripted --suite all --split all --repeat 5 --max-ms 15000 --max-steps 25   # frozen v5
npm run browser:bench -- --mode frames --driver scripted --suite stress --split dev --only iframe-inception-level1            # one challenge
node agent/jev/bench/compare.mjs <baseline-run-dir> <frames-run-dir>
node agent/jev/bench/check-artifacts.mjs <run-dir>...
```
