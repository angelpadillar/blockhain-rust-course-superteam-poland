# Upstream decision-policy comparison

Prepared 2026-09-17. The runnable contender is **MahmoudAdelbghany/jev-browser's unchanged decision step**, hosted behind the same observation, action-execution and safety boundaries as the other arm. No model API or browser calls were made while implementing the adapter. Eight mock-only tests passed. This is a normalized decision-policy comparison, **not an end-to-end race between complete repositories**.

## Pinned sources and selection

| Repository | Reviewed revision | Decision |
| --- | --- | --- |
| [MahmoudAdelbghany/jev-browser](https://github.com/MahmoudAdelbghany/jev-browser/tree/20c27dd96df3140cf162c936fbb7aa742c50edc6) | `20c27dd96df3140cf162c936fbb7aa742c50edc6`, package 0.1.0 | Adapt its native goal-driven decision step; it accepts injected browser session and Jev client. |
| [vlad-terin/jev-browser](https://github.com/vlad-terin/jev-browser/tree/e8649083fad5c34e8a4178cbae19fde420e010ec) | `e8649083fad5c34e8a4178cbae19fde420e010ec`, package 0.2.1 | Feasible supplied-plan runner, but requires an action/subgoal sequence and host postconditions that the goal-only arms do not receive. No extra variant built. |
| [browser-use/jev-ultrafast](https://github.com/browser-use/jev-ultrafast/tree/452c1ad2dd628008f1d5608f28158d76e49e6cc0) | `452c1ad2dd628008f1d5608f28158d76e49e6cc0`, package 0.1.0 | Owns a Python browser-harness/CDP tab; using the exact same owned Playwright page would require a new backend boundary. No such port is claimed here. |

Mahmoud's [package.json](https://github.com/MahmoudAdelbghany/jev-browser/blob/20c27dd96df3140cf162c936fbb7aa742c50edc6/package.json) declares ISC, but the pinned revision has no separate LICENSE or explicit copyright notice. The original package metadata is preserved alongside the copied files; the notice records this limitation. Vlad and ultrafast provide MIT license files. No unlicensed JevTest source is copied. These are pinned source comparisons; no claim is made that these local pins remain remote HEAD after the review.

## What is preserved

The [upstream agent](https://github.com/MahmoudAdelbghany/jev-browser/blob/20c27dd96df3140cf162c936fbb7aa742c50edc6/src/agent.mjs) supplies action, element, key, goal-completion and previous-action questions in one Jev request. When several literal text slots exist, its joint field/text question binds both. The adapter imports the unmodified `agent.mjs`, `snapshot.mjs` and `jev.mjs`, including their original instructions, criteria, confidence thresholds, completion policy and one corrective retry for invalid/low-confidence choices. It invokes the original `step()` and intercepts `execute()` before effects; no browser action occurs inside the adapter.

Thus independent Jev heads are still independent: the element/key/text branches do not see the action answer. Upstream code chooses which answers to consume and applies its compatibility/confidence checks. The adapter maps `type` to common `fill`, `press_key` to `press`, and maps click, wait, back and scroll literally. Unsupported common-executor operations stop with their proposed action retained. It does not replace them with a favorable action or add a hand-written shopping sequence. Model `done` remains an unverified proposal.

The upstream full `runGoal()` loop and browser are **not** used. Its built-in repeated-state loop detector, browser candidate ranking, snapshot collection, native execution/settling and transport retries are therefore not being benchmarked. The common runner owns outer step limits, observed state, history, execution, safety and independent completion. Transport has no automatic network retry; the original corrective decision retry remains and can consume two billed calls for one proposal. These boundaries are explicit rather than attributing the shared executor's latency or safeguards to upstream.

## Interface for the shared runner

```js
import { createMahmoudPolicy } from './upstream/mahmoud-policy.mjs';
const choose = createMahmoudPolicy({ apiKey, ledger });
const proposal = await choose({
  observation, // text/title/url/elements plus optional focus/scroll metadata
  task: { goal, texts },
  history, prev, signal,
  supportedActions: ['click', 'fill', 'press', 'wait'],
});
```

The result has `status: action|done|stop`, a mapped `action`, a safe reason, upstream decision evidence, elapsed decision time and `independentlyVerified: false`. `validateProposal` rejects unobserved refs, incompatible fills, text outside the supplied slots and unsupported actions/keys. The shared executor must still reobserve/rebind the ref, enforce action and network policy, and verify task completion. Neither a proposal nor this validator grants permission for real purchases.

Candidate input uses the common observer's visible label, role, tag, value, href, context and optional bounding box. Context is appended to the label to preserve the common observer's semantic evidence in the upstream text format. Missing geometry becomes neutral zero coordinates. Candidate order, coverage and page text come from the shared observer, not upstream's ranking/truncation. The comparison must not claim equal accuracy for the untouched upstream observer. No screenshot input or text-generating helper is added.

`prev`, if provided, uses upstream action names (`type`, `press_key`, etc.), a public outcome description and a truthful `evidence_changed` flag. The runner should omit it when unavailable. Histories are public recent action descriptions; object histories are projected to action/ref/key/text/label/outcome. Never supply verifier answers or private metadata in history strings.

## Inputs and accounting fairness

All arms receive the **same goal and same literal text slots**, derived once by the shared harness. Quoted names and explicitly allowed numeric strings such as `1`, `2`, `3` are available to every arm. Mahmoud does not generate free-form text. A supplied literal pool is therefore part of the declared task interface; it is not evidence that the upstream model can write arbitrary queries or messages. The adapter neither infers a private target route nor receives expected item IDs, exact verifier URLs, scripted action plans, fixture internals, or hidden cart totals. Observed page URLs and hrefs remain ordinary visible browser evidence.

Every request is reserved in the shared v3 ledger and durably journaled through its caller's event hook before fetch. Responses are recorded before interpreting answers, including malformed answers and HTTP errors with usable usage. Tokens and observed model version are recorded; Jev cost is estimated at $0.042 per million input tokens, zero output charge. Failure or missing usage leaves cost unknown and prevents another dispatch through the ledger. Nothing is priced as zero because it failed. No credential, authorization header or raw provider error is logged. Time/call/cost budgets must be identical across compared policies; cost limits are known-spend thresholds, not guaranteed pre-charge caps.

The source [manifest](../../hackathon/jev/experimental/shopping-head-to-head-v5/upstream/manifest.json) records hashes for the exact copied and wrapper files. Shared ledger, Jev transport and configuration files are transitive dependencies and must be included in the runner's frozen source fingerprint. The copied sources require only Node's built-ins in this mode. No installation of upstream's MCP SDK, zod or Playwright package is needed; the parent owns the already installed Playwright page. Upstream's full package declares `playwright ^1.62.0`, MCP SDK and zod, but those server/browser paths are not imported here. Node 22+ supplies fetch, Response cloning and abort signals.

Mock verification covers joint literal binding, the original corrective retry, unverified DONE, unsupported actions, missing usage, network failure, malformed paid responses, pre-abort, unknown refs and verifier-field exclusion. These tests establish adapter behavior and accounting boundaries; they do not measure model quality, external shopping success or speed. No performance winner can be named before the common frozen cohort is measured.
