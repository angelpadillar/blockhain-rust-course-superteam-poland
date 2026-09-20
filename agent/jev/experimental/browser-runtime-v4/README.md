# Continuous Jev browser workflow — experimental v4

Current evidence: **6/6 structured two-stage workflows passed**, at a median 643 ms with real Jev where needed. The first multi-step natural-language planner passed **0/6**. Its prompt has been revised to address the operation/context errors; a live retest remains pending 1Password authorization. All **27 local regression tests pass**. The structured plan API is the tested v4 path; the earlier one-step natural-language v3 path has separate successful measurements.

One inexpensive model call turns a request into up to four typed operations. A local Playwright worker then executes the whole plan, using fresh observed elements and checking each destination. The selected guide (Jev or OpenRouter) is called only when choosing between controls requires meaning or a requested context needs interpretation. An already structured plan needs no planning call.

This candidate implements `search_and_open` and `open_link`. For example, search for a merchant, open it, search its catalogue and open the named item. It is the browsing part of the future shopping/payment system. Cart changes, purchases, authentication, arbitrary forms, visual-only controls, frames, shadow DOM, cross-origin workflows and automatic replanning remain outside this build. It does not yet browse every website.

## Measured status

On 2026-09-17, the paid local fixture cohort completed 6/6 supplied plans at a median 0.643 seconds, while the initial natural-language planner completed 0/6 tasks. All failures and costs are retained. The planner was then corrected for step-specific context and open-versus-search clauses, but both rerun launches stopped at 1Password authorization before model calls. The current planner therefore has no live full-workflow validation. Local schema, browser and lifecycle tests pass 27/27; they do not establish model planning accuracy.

The separate six-task executor run used a declared deterministic semantic oracle. A public Wikipedia smoke stopped on a forbidden POST, with no completed article task. This is a read-only prototype, with no Glovo retest or deployment. See the v4 report for source-specific evidence; the current planner differs from the recorded paid cohort's preserved source snapshot.

## Run a request

From the `agent/jev` directory in the hackathon repository (or `hackathon/jev` in the experiment workspace):

```sh
node experimental/browser-runtime-v4/run.mjs \
  --url=https://example.org/catalogue \
  --goal='Search for Cedar Stationery, then find Maple Notebook and open its details.' \
  --openrouter-item='OpenRouter API Key - buenaapp' \
  --guide=jev --key-stdin \
  --output=/private/tmp/new-browser-result.json
```

Replace the example URL and names with a site exposing supported native search and named result links. The output path must be new. The TypeSafe prompt hides terminal input; the OpenRouter key is read directly from the named 1Password item into the process. Keys do not enter command arguments, environment variables, browser processes or journals.

`--guide=openrouter-dom` uses the same inexpensive model for ambiguous element choices and requires no TypeSafe input. `--guide=openrouter-dom-image` additionally sends a screenshot for those choices. Images are optional: they added latency without improving completion in the small v3 text-sufficient fixture comparison.

The selected model is `google/gemini-2.5-flash-lite`, pinned to `google-ai-studio`. Responses are schema checked. Unknown provider usage remains unknown; it is never counted as zero. Budget checks stop further calls after a known-spend threshold or unknown usage; they are not a guarantee about the charge for a request already sent.

## Supply a plan directly

```js
import { runWorkflow } from './workflow.mjs';

const result = await runWorkflow({
  page,
  plan: { steps: [
    { operation: 'search_and_open', query: 'Cedar Stationery', targetText: 'Cedar Stationery' },
    { operation: 'search_and_open', query: 'Maple Notebook', targetText: 'Maple Notebook' },
  ] },
  choose, // optional bounded chooser over currently observed candidates
  onEvent: saveDurableEvent,
  maxMs: 30000,
  maxActions: 12,
});
```

`open_link` takes `targetText` and optional `context`, but no query or destination URL. Every operation rebinds its text to current nodes. Old coordinates, selectors and references are never replayed. Exact context can be handled in code; a nonliteral context requires a semantic choice or stops. The runtime never treats a sole wrong-context result as sufficient evidence.

The browser worker uses native input and relevant state conditions rather than a fixed pause after every action. Actions and requests are bounded. A stale target detected before dispatch can refresh; an uncertain dispatched action is not automatically repeated. Failed operations halt the workflow and return an escalation record with the failed step and observed permitted context.

Each completed step requires a changed URL and a visible exact heading. `completed` is operation evidence, not independent proof of the entire request. The CLI can check `--expected-url=EXACT_URL` and `--expected-title=DOCUMENT_TITLE` after execution; those answers stay outside the planner and chooser. Production merchant adapters need their own final checks for item identity, variant, quantity and price before any later transaction feature.

## Reproduce tests and measurements

```sh
node --test experimental/browser-runtime-v4/*.test.mjs
node experimental/browser-runtime-v4/benchmark.mjs --offline
node experimental/browser-runtime-v4/benchmark.mjs --structured-only --key-stdin
node experimental/browser-runtime-v4/benchmark.mjs \
  --openrouter-item='OpenRouter API Key - buenaapp' --key-stdin
```

The offline benchmark uses a declared deterministic semantic oracle; it measures execution overhead, not model reasoning. Structured-only uses real Jev with supplied plans. Full model mode compares one OpenRouter plan with supplied structured steps, followed by the same executor and Jev ambiguity guide. This isolates planning overhead, not a competing agent or the earlier Glovo route. Local fixture destination IDs remain inside an independent verifier. All failures and attempted calls are retained.

V3 results and the earlier Glovo baseline remain separate and unchanged. See `../../benchmarks/browser-runtime-v3/REPORT.md` and `../../benchmarks/browser-runtime-v4/REPORT.md` after mirroring into the hackathon repository.

## Ideas incorporated from the reviewed projects

- **vlad-terin/jev-browser:** a bounded plan and continuous worker, with explicit postconditions and escalation. We retain our node identity checks and condition-based waits.
- **MahmoudAdelbghany/jev-browser:** local execution, typed action arguments, compact candidates and a clear return to the planner on failure. We keep independent completion checks instead of model-based DONE.
- **CorieW/JevTest:** per-operation postconditions and separate terminal verification. The current v4 checks URL changes, exact visible headings and permitted origins; it does not implement JevTest's full assertion/replay framework. Its current repository grants no source usage license; our code independently implements architectural ideas.
- **browser-use/jev-ultrafast:** measure and reduce browser round trips and repeated full-state work before optimizing model latency alone.
- **typesafe-mod and typesafe-computer-use:** retain a general planner above narrow decisions, and describe element identity, context and supported actions explicitly. Desktop OCR is not the default Linux browser path.

Candidate overflow selection, verified workflow memory, broader native actions and automatic image escalation are later measured extensions. Explicit DOM-plus-image guidance is already available. Neither repository speed claims nor our small controlled suite establish the world's fastest agent.
