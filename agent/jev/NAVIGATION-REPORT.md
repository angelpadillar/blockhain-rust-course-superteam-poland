# Kraków homepage to the Foczka product page

**The agent reached the exact target URL, but no live run has yet passed every completion check.** The latest substantial attempt took 14.518 seconds and approximately $0.000298 in model usage. It opened the requested product URL after successfully repeating the authorized age confirmation; the visible product title was not verified. A subsequent fix waits for delayed product rendering. Glovo's intermittent problem page prevented live verification of that fix.

The [saved project direction](PROJECT-DIRECTION.md) covers instruction following, persistent records, prompt/task execution and expansion beyond Glovo. The current adapter uses a validated task contract and separate merchant/product stages. Model requests, probabilities, confidence, pending actions, outcomes and completion checks are now saved in private run journals before and after execution.

The account holder explicitly confirmed they are 18+ and authorized repeating their existing Glovo age/terms confirmation **solely for this navigation-only test**. No further authorization is needed for that same scoped action in this task. Adding products, scheduling orders and purchasing remain outside this test.

## Recorded live attempts — 16 September 2026

| UTC start | Outcome | Elapsed | Jev calls | Estimated model cost |
| --- | --- | ---: | ---: | ---: |
| 12:34:49 | Unclickable control after finding merchant | 13.424 s | 5 | $0.000499800 |
| 12:37:39 | Found merchant, searched product, chose Rum i gin; age prompt | 9.108 s | 5 | $0.000257670 |
| 12:47:48 | Age prompt appeared again after manual setup and browser restart | 9.063 s | 5 | $0.000257670 |
| 12:55:59 | Same-tab attempt: homepage did not render the expected address; subsequent inspection found Glovo's problem page | 8.204 s | 0 | $0 |
| 13:04:08 | After Glovo recovered, fresh-browser retry reached the age prompt | 9.167 s | 5 | $0.000257460 |
| 13:09:27 | Store switched to closed until 16:00; model chose unavailable | 6.288 s | 4 | $0.000145488 |
| 13:11:49 | Dismiss-notice action offered; model still chose unavailable | 6.431 s | 4 | $0.000140784 |
| 13:13:38 | Glovo problem page; no model call | 0.148 s | 0 | $0 |
| 13:40:50 | Exact target URL reached; visible product title not verified | 14.518 s | 7 | $0.000297570 |
| 13:46:13 | After product-readiness fix: Glovo problem page; no model call | 0.240 s | 0 | $0 |

All ten attempts are preserved in `navigation-results.json` and the VPS data volume. Combined usage: **35 model calls, 44,201 input tokens, 10,227 output tokens, estimated model cost $0.001856442**. No basket or purchase actions occurred. The ninth attempt blocked three recognized mutation requests; these were not executed.

These are development attempts across changing adapter versions and merchant conditions, not repeated runs of a frozen benchmark. No successful end-to-end duration or cost per completed task can be reported. The three-success measurement remains incomplete. The fixed age-confirmation handler executed successfully once in the ninth live attempt, with the account holder's existing authorization; that work is included in elapsed time.

In the ninth attempt, seven Jev calls took 1.976 seconds combined, averaging approximately 282 ms. Journal writes took 0.560 seconds; the rest of the 14.518-second run was browser/runner work. Returned confidence and selected-option probability are distinct: the final product choice had confidence 0.55 and probability 0.58. Neither value was treated as proof of task completion. Direct reference-page inspections after the run are diagnostics, excluded from the benchmark; one showed the product dialog appearing after the initial page content.

The second attempt reached the merchant in approximately **6.177 seconds** using three decisions: search Foczka Alkohole, submit search, open its result. The model cost of that partial route was **$0.000113694**. Its five calls averaged approximately **290 ms**; browser work accounted for 7.657 seconds of the 9.108-second attempt. Browser launch added 0.171 seconds, reported separately. These partial metrics do not establish reliable completion or a scaling advantage.

## What changed

The reader now excludes collapsed submenu children and recognizes product titles in search-result rows. Independent success checks require the requested store, both product identifiers and a visible matching product dialog. Error handling distinguishes Glovo's problem page from a wrong address.

A desktop test mode preserves the manually prepared browser and tab, navigating home through a rendered Glovo link. Incomplete attempts retain that browser for inspection/retry; three successes close it cleanly. The account holder used this mode, but Glovo's error page interrupted the attempt. Later the homepage and store both loaded normally again on the VPS, so the underlying site error remains unexplained.

A fixed handler can repeat the explicitly authorized age/terms declaration. It is limited to this case and store and requires the exact observed dialog, declaration, checkbox and accept button. It is never offered as a model choice, is disabled by default, and is counted separately in metrics when enabled.

When Foczka switched to closed until 16:00, Jev could not progress through the notice. A narrow dismiss action was added without scheduling an order. Jev still chose unavailable, so the final instructions explicitly clarify that the task is catalogue viewing and a merchant need not be open for orders. The next live attempt encountered Glovo's problem page before this clarification could be evaluated. No successful closure-notice traversal is claimed.

The current revision handles a known closed-store notice with a fixed, scoped close operation, recorded as a policy action. Jev chooses within a merchant or product stage; alternative merchants and substitute products are excluded. Repeating the same action against the same observed state is bounded. Confidence and complete probability distributions are validated and retained, without claiming a calibrated success threshold for this use case.

The product-readiness fix addresses the interval between Glovo changing the URL/showing controls and rendering its product title. An exact URL alone still cannot pass. A delayed-title browser fixture verifies the new wait. This final fix has not yet produced a verified live completion because the next homepage load returned Glovo's problem page.

Navigation journals are written atomically with restrictive permissions and flushed file writes. Both entry points save pending actions before execution. Failed journal writes stop the next browser action; incomplete records after a process interruption are marked for inspection on the next run while holding the profile lock. No pending action is automatically replayed. Task, source fingerprint, requested model alias, returned model version, token usage and pricing assumptions are retained; raw account configuration, browser cookies and API credentials are not journaled.

## Task and measurement

Start: `https://glovoapp.com/pl/pl/krakow`.

Target: Bacardi Blanco 0.7 L at Foczka Alkohole, product ID `4611686018614338744`, external product ID `d14683f8-6c34-409f-816a-c700fb32291a`. The full user-provided URL is in `cases/foczka-navigation.json`.

Jev receives the merchant/product goal, fixed search strings, public headings, history and rendered action candidates. Playwright executes the chosen search, link, category heading or product title. It cannot jump directly to the target URL. The reference target was inspected separately to identify the product name, outside measured runs.

Reaching just the merchant or a category is incomplete. The category `content` parameter is recorded separately because search can open the same product with another category context. Basket, checkout, account/address changes and purchase controls are excluded; recognized basket/order/payment/address writes are blocked.

Elapsed time includes homepage navigation, rendering, model calls, actions and verification. Repeated age confirmation, when authorized and exercised, is included in wall time and reported separately from model actions. Manual preparation, browser launch, developer work and operator assistance are excluded. Search settling uses a 700 ms stability interval. Same-tab runs preserve a warm account/app session and differ from fresh-browser attempts.

Live calls used Jev 1.13.0. Pricing uses returned token usage and $0.042 per million input tokens with free output, from the [Typesafe launch/pricing article](https://typesafe.ai/blog/introducing-system-one-models-and-jev), checked 16 September 2026. Estimates exclude VPS and operator time and are not an invoice. No Codex reference run was completed for this route; the earlier shopping comparison is a different task.

## Deployment and continuation

Browser containers are stopped and the saved profile is unlocked. Private desktop links are offline. The HTTP shopping API remains stopped and the stack is not registered in Coolify's dashboard. The existing payment configuration and prepare-only checkout runner were not changed.

For the explicitly authorized case, the fresh-browser command is:

```sh
npm run evaluate:navigation -- --runs=3 --repeat-confirmed-age
```

Supply the Typesafe key through the existing secret mechanism; the private VPS launch uses hidden stdin, the saved profile, protected configuration and source mounts. The repeat-confirmation option must only be used with the account holder's explicit authorization. That authorization exists for this test. Model navigation remains bounded and the batch stops on the first incomplete attempt.

The optional Linux desktop mode is `npm run evaluate:navigation:desktop`. Its private browser is `http://100.121.5.10:6088/vnc.html?autoconnect=1` and its start page is `http://100.121.5.10:6089/`, available only while that container runs. Use **Start three navigation runs** to keep the live tab; the older Finish setup page closes it. Stop the desktop container after inspection to release the profile. Never use the same profile in two browsers.

The key was retained only in process memory and was not saved in the server environment file or logs. The temporary protected named pipe used for a background desktop launch was removed immediately after delivery. Navigation scripts and cases are now included in the rebuilt onboarding image; earlier live evaluations used source mounts.

Validation: **29 unit/service checks and 13 browser integration checks passed locally** (the final navigation change was rechecked with all eight navigation browser fixtures). The earlier revision's 17 focused navigation checks passed on the VPS; all eight browser fixtures also passed there after the final product-readiness fix. Fixture passes are distinct from the incomplete live results.
