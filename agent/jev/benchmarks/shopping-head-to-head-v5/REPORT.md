# Amazon.pl bounded measurement — 17 September 2026

**No head-to-head winner was established.** The isolated cold browser did not get past the initial Amazon page. Its AWS WAF challenge requested cross-origin verification resources that the measurement harness blocked. This is a harness/site compatibility failure before a model decision, not evidence that Jev or Gemini chose poorly.

Browser development is now frozen. This report closes the bounded measurement exercise; the mandate and approval boundary are the implementation priority.

## Fixed task and scoring

Start a fresh Chrome process and guest context at `https://www.amazon.pl/`, with no prepared basket or reused login. Search `BIC Cristal niebieski 10`, open **BIC Cristal Original Długopisy kulkowe, średnia końcówka (1 mm) - niebieskie, pudełko 10 sztuk**, and add one pack only if its price is at most 25 PLN. Verify the exact cart product and quantity. Checkout, purchase, account changes and payment remain blocked.

The intended arms are joint-action Jev, Gemini 2.5 Flash Lite through OpenRouter, and the normalized Mahmoud Jev decision policy. All receive the same goal, literal text slots, observed controls and guarded native executor. This would compare decision policies, not complete upstream repositories. Two repetitions in reversed order are specified in the saved harness; **the model cohort was not run** because its prerequisite failed.

Ranking is verified success first, then total attempt time divided by verified successes, then all model spend divided by verified successes. Failed attempts and corrective calls belong in those numerators. With zero successes these ratios are undefined. Browser infrastructure and proxy costs are unknown, not zero.

## Actual evidence

| Measurement | Outcome | Elapsed task time | Model calls | Known model spend |
|---|---|---:|---:|---:|
| Supervised in-app browser feasibility check | Search → exact product → cart verified, then test item removed | Not instrumented | No benchmark-provider calls | Not a model comparison |
| First isolated preflight | Blank initial page; rendering wait was missing | 1.584 s | 0 | $0 |
| Final isolated preflight | No rendered page after bounded wait; AWS WAF fetches blocked by guard | 10.007 s | 0 | $0 |

The supervised guest flow displayed a 9.98 PLN pen pack and one cart item. That flow used a different browser environment and cannot be substituted for a cold agent result. The basket was returned to zero items. No checkout or purchase occurred.

The final cold receipt records GET `/inputs` and POST `/report` to an `eu-central-1.token.awswaf.com` origin, rejected as `outside_origin`. It does **not** establish that an unrestricted normal browser could not complete the site's challenge. No challenge bypass or special exception was added.

Raw final receipt and screenshot:

- `results/preflight-2026-09-17T13-44-25-757Z/attempt-1.json`
- `results/preflight-2026-09-17T13-44-25-757Z/attempt-1.png`
- `results/preflight-2026-09-17T13-44-25-757Z/batch.json`

Receipts include source fingerprints and SHA-256 screenshot/observation hashes. This screenshot is evidence of the blocked page, not a quote, approval, merchant confirmation or successful purchase. The quote/approval/confirmation evidence fields remain absent because those boundaries were never reached.

## Scope and next production gate

The prior 643 ms and 929 ms local-page results remain executor/decision measurements and are not Amazon reliability or payment-boundary results. There is no evidence here of a production success rate or an all-in cost advantage.

The v4 execution adapter is preserved byte-for-byte, with its freeze manifest in `trust-layer/browser-adapter-freeze.json`. The isolated v5 measurement harness is not promoted to the production agent. Before a future live payment pilot, a normal supported browser session must reliably reach the quote boundary, and the mandate/evidence gate must reject any change to the approved merchant, items, amount, currency or expiry. A successful DOM click is insufficient proof of payment or delivery.
