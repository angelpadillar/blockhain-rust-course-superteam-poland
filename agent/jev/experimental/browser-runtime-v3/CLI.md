# Run the experimental browser runtime

This CLI compiles a natural-language goal and performs one read-only native search followed by opening a newly observed, exactly matching result link. It uses a fresh headless browser context for every attempt. It does not reuse your Chrome profile or login session.

Run from `hackathon/jev` with Node 22 or newer, the project's installed `playwright-core`, an installed Chrome browser, and the authenticated 1Password `op` CLI:

```sh
node experimental/browser-runtime-v3/run.mjs \
  --url='https://example.org/search' \
  --goal='Find the Aurora notebook from the Studio shelf and open its details.' \
  --openrouter-item='YOUR_OPENROUTER_ITEM_REFERENCE' \
  --output='/private/path/new-search-result.json'
```

Replace the example site with a public site you intend to visit. The OpenRouter item must have a field named `credential`. The item reference is safe to supply as an argument; never supply an API key as an argument. The CLI refuses an existing output file before accessing credentials or launching a browser. Output files use mode `0600`; newly created parent directories use `0700`.

`--guide=openrouter-dom` is the default. `--guide=openrouter-dom-image` also sends an in-memory PNG screenshot when an ambiguous choice requires model assistance. `--guide=jev` uses Jev for ambiguous choices and additionally requires `--key-stdin`. In all three modes, the initial natural-language planner uses OpenRouter's pinned `google/gemini-2.5-flash-lite` through `google-ai-studio`; unambiguous observed choices require no chooser call.

For Jev, enter its key at the hidden terminal prompt, or pipe a secret directly from your secret manager:

```sh
op read 'op://VAULT/TYPESAFE_ITEM/credential' | \
  node experimental/browser-runtime-v3/run.mjs \
    --url='https://example.org/search' \
    --goal='Find the Aurora notebook and open its details.' \
    --openrouter-item='YOUR_OPENROUTER_ITEM_REFERENCE' \
    --guide=jev --key-stdin \
    --output='/private/path/new-jev-result.json'
```

Keys stay in the Node process. They are not written to output, passed to the browser, or placed in its environment. The browser receives only `PATH`, `HOME`, `LANG`, `DISPLAY`, `XDG_RUNTIME_DIR`, and `TMPDIR`. Set `JEV_BROWSER_CHANNEL` to another installed Playwright browser channel if necessary. The CLI prints only status, timing and accounting fields; it suppresses raw error text and stack traces.

## Completion and independent checks

Without a verifier, `opened_unverified` means the runtime clicked its selected result and observed a matching visible heading. This is not a claim that it reached the intended destination. You can supply independent exact checks:

```sh
node experimental/browser-runtime-v3/run.mjs \
  --url='https://example.org/search' \
  --goal='Find the Aurora notebook and open its details.' \
  --openrouter-item='YOUR_OPENROUTER_ITEM_REFERENCE' \
  --expected-url='https://example.org/items/aurora' \
  --expected-title='Aurora notebook' \
  --output='/private/path/new-verified-result.json'
```

Expected values are used only after runtime completion, against a fresh URL and document-title read. They are never supplied to the planner, chooser or runtime. URL comparison is literal, including query and fragment; title comparison is literal document title, not heading text. Supplied checks must all pass for `verified`. Their expected values are not recorded, only check booleans. A mismatch produces `verification_failed`.

Exit code `0` means `verified` or `opened_unverified` with successful cleanup. Any incomplete run, failed check, journal failure or cleanup error returns `1`. Inspect the explicit status and `verifiedSuccess` rather than treating exit code `0` alone as independent success.

## Supported pages and limits

The prototype supports visible native HTML search inputs and ARIA searchboxes, same-origin GET search forms, live search results, and native exact-label result links. It can use observed semantic region labels to distinguish results or ask the selected chooser to resolve ambiguity. Inputs and links are bound to actual captured DOM nodes. It uses native fill, Enter and click actions; no coordinates, arbitrary JavaScript actions, selectors from models or forced clicks.

The start URL fixes the navigation origin. Cross-origin redirects and navigations, downloads, popups, non-read requests, and account, cart, order, payment or destructive paths are blocked. Cross-origin passive assets such as scripts, styles, images and fonts can load; cross-origin fetch/XHR cannot. These restrictions can stop ordinary sites that send background telemetry or require another search origin. The initial page load follows the same policy as the search. Service workers are blocked, and dialogs are dismissed.

This is a limited HTML/ARIA implementation, not a universal browser agent. It requires a newly observed exact-text result link after search. A search that directly redirects to an article, including some Wikipedia search flows, is currently unsupported. Closed shadow roots, iframe search, image-only controls and multilingual labels outside the implemented reader can also be unsupported. The planner receives only your goal, so give a clear target name and any necessary disambiguating context.

Each attempt allows six model calls, an observed account-cost threshold of `$0.01`, eight native actions and 15 seconds inside the runtime. Planning overlaps initial navigation; the combined task deadline is 45 seconds, excluding credential access and browser/context setup. Individual initial navigation and provider requests have 15-second limits. A single completed call can exceed the cost threshold because actual cost is reported after the request; the CLI then stops. Unknown model usage or cost prevents subsequent calls. OpenRouter cost is its reported account charge; Jev cost is estimated from tokens at the provider wrapper's configured rate. Browser infrastructure and other upstream charges are not included.

The private JSON journal contains the goal, compiled task, start/final URLs and titles, runtime events, source hash, timing and model accounting. Treat it as private browsing data. It contains no credentials, raw provider responses, request headers or screenshots. Model-call intent is durably journaled before dispatch, and usage is recorded before interpreting the response. A journal failure aborts further actions. If the process is forcibly terminated, a pending model call means its final usage/cost is unknown.

`totalMs` measures overlapping planning/navigation through verification and excludes browser/context setup, credential access and cleanup. Those setup/cleanup timings are reported separately. Runtime observer/protocol counters count explicitly instrumented operations, not all internal Playwright protocol traffic. `modelMs` adds request latencies and is not an extra serial phase to add to total duration.
