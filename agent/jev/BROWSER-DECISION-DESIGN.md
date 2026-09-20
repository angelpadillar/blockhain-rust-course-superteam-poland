# Browser decisions from fresh element evidence

Saved 17 September 2026 from the user's five shared examples, checked against current TypeSafe documentation and the existing Glovo adapter. The original notes below describe the design before implementation. The separate candidates and their measured outcomes are recorded at the end; the baseline remains unchanged.

The intended architecture is a code-owned observation/execution/recovery loop with Jev supplying semantic decisions. A larger reasoning model can help plan unfamiliar tasks or diagnose unfamiliar failures, but ordinary retries, refreshed observations and bounded recovery do not require one. Our current loop already tracks outcomes and bounds repeated actions and product-opening rollbacks.

## What to retain from the examples

Describe a candidate with its role and label (`what`), concise semantic ancestor context (`where`), and operations actually supported by the adapter (`supports`). This helps distinguish repeated labels in different regions. Use references scoped to a particular snapshot, retain the corresponding element mapping in code, and reject old or missing references before executing. Re-observe and ask again when identity is stale; never reuse an index just because its number still exists.

Example of proposed observation data, using invented references and public page content:

```json
{
  "snapshot_id": "s42",
  "intent": "Open the requested product details",
  "elements": {
    "s42:e17": {
      "what": { "role": "product title", "label": "Bacardi Blanco 0,7l" },
      "where": ["main", "store catalogue", "Rum i gin"],
      "supports": ["click"]
    }
  }
}
```

This is a proposed internal observation record, not a complete API request. Ancestor context must be short and relevant; do not copy account/address text into model input. `supports` comes from adapter evidence and policy, not from Jev inventing a capability. A supported operation still needs live actionability checks and subsequent outcome verification.

Jev currently consumes text/JSON. A snapshot for Jev means a textual DOM/accessibility representation; a raw screenshot needs a separate OCR or vision-to-text stage. [State documentation](https://docs.typesafe.ai/concepts/state)

## Corrections that matter for speed and correctness

- **Recovery can be ordinary code.** A Jev-plus-code loop can detect stale state, refresh, reselect and retry known failures. A larger model is useful for open-ended recovery, not a prerequisite for all recovery. Retrying an uncertain side effect requires reconciling its outcome first; navigation retry rules must not become payment retry rules.
- **Known facts belong in code.** Connectedness, enabled/editable state, adapter-supported commands and the task's prohibited operations can be checked locally. Jev is useful for interpreting which observed element fulfills the user's intent. A capability prediction does not prove that an event handler will succeed.
- **Noul returns `P(yes)` in `[0,1]`.** Code chooses how to use that probability; it is not a guaranteed true/false result and has no separate confidence field. Thresholds need evaluation for the specific judgment. [Noul documentation](https://docs.typesafe.ai/primitives/noul)
- **Parallel questions are independent.** A batched command question cannot read the answer to the target question. Both must be answerable from the supplied state. Check that the selected command and target are compatible before acting, or use a joint allowed-action Choice. [State](https://docs.typesafe.ai/concepts/state), [fan-out](https://docs.typesafe.ai/patterns/fan-out)
- **Model judgments do not grant authority.** A low destructive-action probability cannot authorize purchasing, changing the address or accepting new terms. Existing task constraints remain enforced by code.

## Preserved baseline adapter

The current `next_action` Choice already selects an allowed target/operation/known-text combination in one request. Code re-reads the controls before execution, rejects a changed control, checks Playwright visibility/enabled state and independently verifies completion. It retains action history and bounded retries. Stale-control rejection stops the baseline run. The new separate candidates implement bounded refresh/reselection as described below. Jev does not generate the known merchant/product search strings.

Baseline action IDs are per-observation choices, not retained DOM-node handles. The executor compares the control tuple including its index, then uses a live indexed locator; a change between that check and input remains possible. Snapshot-scoped references should bind actual element identity and be checked at execution, with a bounded fresh selection when invalidated. An element replaced with an identical label must not silently inherit an old reference.

The next candidate should enrich the existing joint action descriptions with concise role/ancestor/capability evidence and snapshot-scoped references. Keep joint choices as the measured baseline; splitting target and command into separate questions is an alternative to compare, not an assumed speed improvement. Separate questions are most useful where several operations genuinely fit an observed element. Include a no-match option. Choice permits at most 255 options, including no-match; larger candidate sets need an explicit decomposition rather than silently dropping arbitrary controls. [Choice documentation](https://docs.typesafe.ai/primitives/choice)

Use Noul only for semantic checks that contribute information beyond the chosen action and known DOM facts. For example, a goal-level question about whether any observed control matches an intent can be independent of target selection. A per-target capability question must identify that target in the input, or code must ignore it until the corresponding target is selected. Questions about the already selected target generally require another request unless evaluated speculatively per candidate. Additional questions use tokens even when batched; evaluate actual latency and cost.

## Comparison to run before replacing the working policy

Preserve the successful source fingerprint and its three-run baseline: median 13.589 seconds, seven Jev calls, $0.00031479 estimated model cost per navigation attempt. No new live runs were performed for these notes.

Compare the current joint Choice with richer structured candidates on duplicate labels, multiple applicable commands, absent targets, stale references, loading transitions and page text containing misleading instructions. Test a bounded refresh/reselection path separately. Measure independent completion first, then whole-task time, all model usage, extra calls, stale-action rejection/recovery and fallback rate. Our measured browser/runtime time dominates Jev time, so adding model questions to replace cheap local checks has no established speed benefit.

The current navigation-only scope remains unchanged: open the exact Glovo product page; no basket changes or purchases. Full cross-site planning and payment execution remain separate work.

## Implemented candidates and measured outcome

Candidate v1 now captures actual DOM elements with each observation, supplies concise structured descriptors, and bounds pre-dispatch stale refresh/reselection at two within the normal budgets. Local fixtures validate node identity, delayed renders, recovery and irreversible-dispatch uncertainty. In live testing, its richer prompt selected unavailable after filling search in both attempts despite an offered submit action. It must not replace the baseline.

Candidate v2 retains that local element binding and transition-aware waits, but delegates the model request to the exact baseline builder and history projection. The revised live attempt correctly filled and submitted search, then encountered Glovo’s unavailable page. The 250 ms readiness branch and stale recovery have not yet been reached in a completed live task, so neither has a measured task-level speed benefit. All failed attempts and site outages are retained in the [speed report](benchmarks/navigation-speed-v2/REPORT.md). The baseline stays the default; v2 stays experimental.
