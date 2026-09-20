# Optional 5SIM adapter: default disabled, explicit attempt approvals

There are now **three activations and US$0.4345 gross SMS charges**, with **one assisted observed new Delio test account**. The first two [operator attempts](../evidence/onboarding-live-test.json) cost US$0.1269 and US$0.1538 and ended in `TIMEOUT`; their request dispatch was unverified, so they are not evidence of provider delivery failure. Refund credits remain independently unverified and net cost unknown.

The user manually purchased the third Virtual53 activation for US$0.1538. The [owned-order check](../evidence/user-purchased-activation-check.json) verified ownership/price before import, which preserved earlier intents and made no new purchase. After approval of an observed authentication dependency, [one SMS/code arrived](../evidence/user-purchased-sms-received.json); the [final provider check](../evidence/user-purchased-final-provider-status.json) reports `FINISHED` with one SMS. OTP and profile completion used native worker calls plus approved Codex VNC input and human decisions. This is not autonomous Jev signup or a fully reconciled automated coordinator.

The module still defaults to `paidEnabled:false`. Earlier automated purchases used separate expressly authorized one-purchase ledgers and a common provider lock; public HTTP paid routes remain disabled. All earlier failed attempts remain recorded.

Read-only discovery and both authenticated profile checks are separate from the paid request. The [original profile check](../evidence/fivesim-auth-preflight.json) and [budget check](../evidence/fivesim-auth-budget-preflight.json) returned HTTP 200; the latter confirms the balance covered the authorized cap without retaining identity/balance values.

## Verified public findings — 19 September 2026

The [official API documentation](https://5sim.net/docs) describes public country/product/price endpoints. Prices expose stock and historical delivery percentage; a missing percentage is unknown. Buy, check, cancel and finish all use GET, but buy/cancel/finish change provider state. `maxPrice` works only with operator `any`. The adapter therefore does not promise a named highest-rate operator while enforcing that cap. Order responses supply status, expiry, price and SMS data. History is paginated. The [actual read-only history diagnostic](../evidence/fivesim-history-diagnostic.json) returned 14 rows with numeric `Total:999999`. The adapter handles only that exact sentinel, using pages of at most 100 rows, valid unique IDs across pages and a 500-row bound; sentinel pagination completes only on a short page. Ordinary totals still require an exact complete count. Failed pre-purchase history checks throw `provider_pre_purchase_check_failed` with `dispatched:false` before any paid intent/request; they are not silently retried.

The earlier credential-free **Node fetch** preflight returned HTTP 200 from both `/v1/guest/products/poland/any` (69 ms) and `/v1/guest/prices?country=poland` (102 ms). It observed the Polish activation identifier **`zabkajush`**, aggregate stock 28,885, and five in-stock offers priced **US$0.1026–0.1538**, using the separately recorded official USD evidence below (the API has no currency field). Three report rate **0**; two omit rate. **No offer in that saved sample met a 90% minimum rate.** Earlier Python HTTP clients returned 403; those attempts remain recorded and do not mean the key is invalid or all endpoints are blocked. See [public-preflight-20260919.json](./public-preflight-20260919.json) and the later [operator preflight](../evidence/fivesim-operator-preflight.json), which observed stock 28,679 with the same price range and no high-rate offer. These observations are a point-in-time sample, not a stock reservation or delivery guarantee. The official [service catalogue](https://5sim.net/products) independently lists Zabkajush. The requested label is now resolved to an observed identifier. The listing alone does not verify acceptance for this Delio/Jush flow; compatibility must not be fabricated from the product name.

The official [News link on the catalogue](https://5sim.net/products) leads to `news_en_5sim`. Its [USD migration announcement](https://t.me/news_en_5sim/1945) states website pricing moved to USD; its [balance announcement](https://t.me/news_en_5sim/1947) states customer balances were converted from coins to USD. These current provider statements establish website/balance USD denomination; the [terms](https://5sim.net/docs2/offer.html) retain older coins wording. API responses do not include a currency field. A caller may record the official USD evidence and identity USD conversion explicitly; the code does not infer a denomination from `$` or silently enable purchases. Use **six decimal places** for provider USD precision: `totalMinor:200000`, `perOrderMinor:200000`, `usdMicrosPerUnit:1000000` represent the authorized $0.20 cap while handling fractional-cent offers. The separate USD authorization stays `totalMinor:20,maxPurchases:1`. Any additional funding fees require their own verified allowance; no top-up is implemented.

The [number reuse FAQ](https://5sim.net/support/%E9%87%8D%E7%94%A8%E5%90%8C%E4%B8%80%E4%B8%AA%E6%89%8B%E6%9C%BA%E5%8F%B7) says finishing an order prevents further SMS to that number. It describes limited active periods and operator-dependent repeat receipt. The API separately offers conditional reuse; this adapter does not request it or implement rental. Temporary activation is unsuitable as a promise of long-term login/account recovery. The [manual](https://5sim.com/manual) describes short activation windows. Do not store a temporary number as a reliably retained recovery factor.

## Server-only interface

Node.js, no external dependencies. Import `createFiveSimAdapter`, `createFiveSimStore`, `createManualOtp`, and `priceToMinor` from `fivesim.mjs`.

`createManualOtp({onOtp,onPhone?,expiresAt?,now?})` works without a provider token. Its `submit(code)` and optional `submitPhone(phone)` pass secrets directly to private callbacks and return only status. OTP use is one-shot, including an uncertain consumer failure. This is an input channel, not proof that Delio accepted the code. The HTTP host must authenticate/rate-limit its manual endpoint and exclude inputs from request logging, model context, screenshots and evidence exports.

`createFiveSimStore({initial?,durableWrite})` serializes access across adapters sharing that object. `durableWrite(snapshot)` must atomically persist the **whole** snapshot to private storage and flush it before resolving. Reload the same snapshot on restart. The included mutex is process-local: run one owner per provider account, or replace the store with a transactional database/distributed lock implementing `exclusive(callback)` with `read`, `write`, `assertWritable`. Never reset a ledger or open another store to evade an uncertain purchase or exhausted allowance. The separately approved Virtual53 test uses a distinct retained attempt ledger only after explicit additional authorization, with the same account/mailbox binding and a common provider lock; it is not an automatic retry. Provider order IDs and reservation metadata are operational records; tokens, phone numbers and SMS are absent.

`createFiveSimAdapter(options)` accepts:

```js
{
  paidEnabled: false,                    // Default; set true only after every condition below is verified.
  token: process.env.FIVESIM_TOKEN,       // Server environment only. Never include in browser/model payloads.
  fetchImpl: globalThis.fetch, store,
  exclusiveProviderAccount: true,        // No other tool/operator may buy from this account concurrently.
  service: {
    country: 'poland', product: 'zabkajush',
    verified: true, evidenceUrl: verifiedCatalogueSource,
    merchantCompatible: true, compatibilityEvidenceUrl: verifiedDelioCompatibilitySource
  },
  budget: {
    currency: 'USD', exponent: 6,
    totalMinor: 200000, perOrderMinor: 200000,
    currencyVerified: true, currencyEvidence: verifiedDenominationSource,
    authorization: { currency: 'USD', totalMinor: 20, maxPurchases: 1 },
    conversion: {
      usdMicrosPerUnit: verifiedUpperBoundIncludingFees, // 1000000 only if identity USD is all-in.
      verified: true, includesFees: true, evidenceUrl: verifiedConversionSource,
      validUntil: conversionExpiryEpochMs
    }
  }
}
```

The observed country/product and maximum USD amount above are concrete; the evidence, compatibility, fee-inclusive conversion and freshness fields must be supplied from verified operator records. Verification booleans are caller attestations backed by that evidence, not verification performed by this module. A successful discovery does not turn paid mode on. `usdMicrosPerUnit` is a conservative all-in upper bound in millionths of USD per **one major provider unit**, not per minor unit. The code rounds conversion up to USD cents and rejects a provider budget above the authorization. Conversion expiry blocks new buys while allowing reconciliation/explicit cleanup of existing owned orders. Without a verified conversion, the dollar authorization cannot be translated into a provider purchase cap.

For the separately authorized Virtual53 test only, the server can supply:

```js
approvedNamedOperator: {
  operator: 'virtual53', expectedPriceMinor: 153800,
  approvalId: 'virtual53-test', priceCapNotEnforcedAcknowledged: true
}
```

This approval is bound into the store policy and requires Poland/`zabkajush`, `maxPurchases:1` and a price within the configured per-order/total budget. Call `buy({operator:'virtual53',onPhone})` explicitly; defaulting to `any` on that approved adapter is rejected. After complete baseline history, an unauthenticated public price request must show positive Virtual53 stock and the exact approved price. The quote must remain within five seconds from request start through durable intent persistence, and the named buy sends **no `maxPrice` parameter**. The ledger records operator, approval, quoted price/time and `capMechanism:'fresh_quote_only_not_provider_enforced'`.

If the returned actual price or operator differs, actual cost is retained, the phone is withheld and `purchase_price_variance_reconcile_required` blocks further purchases even after an order-status refresh. Lost purchase responses retain their reservation. No SMS success-rate parameter is sent. The [saved operator check](../evidence/virtual53-check-1789813418126.json) returned rate zero, while the user reported a 69.01% UI rate; neither is treated as a guarantee.

Methods:

- `publicPreflight({product?,operator:'any',minimumRate:90,terms?})`: exactly two bounded, unauthenticated public GETs. Returns sanitized discovery, a shortlist assessment, and the existing store's purchase blocker without changing the journal. Unknown purchase state still requires reconciliation. It never authorizes a purchase. The standalone `discoverFiveSimOffers` and `assessFiveSimOffers` exports are in `discovery.mjs`; discovery needs no token or store. Offers retain zero stock/zero rates, omitted rates remain null, and failed requests retain exact HTTP status without raw bodies. Incomplete, stale or truncated discovery cannot qualify.
- `offers({country:'poland',product})`: unauthenticated read only; ranks available offers by reported rate, unknown last. Returns `currency:null`; callers must not label raw prices USD. It cannot verify Delio compatibility or guarantee future delivery.
- `buy({onPhone,operator:'any'})`: returns a reservation/status/cost summary; invokes the private phone consumer only after cost persistence. The default path uses `operator=any` and `maxPrice`. Named operators are rejected before any request unless the narrowly scoped approval below is configured; that exception does not send or claim provider-enforced `maxPrice`. No `minRate` buy parameter is documented or sent. The shortlist can show high-rate candidates, but an `any` buy cannot enforce their identity/rate; no high-success guarantee is made. A strict high-rate requirement must stop if it cannot be met.
- `poll({reservationId,onOtp,signal?,timeoutMs?})`: checks only an owned order, observes expiry, and sends a code only to the private callback. Default limits: 10-second requests, 3-second intervals, 120-second polling, 40 checks. Poll timeout/abort/expiry does not cancel automatically. A durable one-shot marker prevents another OTP dispatch after uncertain callback delivery. Never log callback inputs.
- `mutateOwned({reservationId,operation:'cancel'|'finish'})`: explicit operation for an order already owned by this store; records pending intent durably before the mutating GET. No arbitrary provider order ID, ban, rental, reuse or notification method is exposed.
- `reconcile({reservationId,providerOrderId?})`: reads known order state or bounded complete history after an uncertain buy. Without a selected ID, reports candidate IDs privately. Adopting a match requires explicit selection, one unique new matching candidate and a confirming check. Account exclusivity is essential: the API exposes no client idempotency key. An absent match never releases the reservation or proves no charge. Ambiguity requires operator review; no auto-rebuy.
- `publicStatus()`: allowlisted cost/state plus `purchaseConfigurationValid`, `purchaseBlocker` and effective `usdAuthorization`. It checks the configured cap even for a fresh store before its first purchase; disabled, incomplete, expired or inconsistent configuration cannot report buy readiness. This call makes no provider request or durable mutation. Costs include all successful purchases, even canceled ones; no refund is assumed from cancellation status. Missing cost remains unknown and blocks further purchases.

All provider requests use fixed `https://5sim.net`, no redirects and bounded timeouts. Only authenticated endpoints receive authorization headers; public discovery does not. Error strings are static and exclude raw provider bodies, tokens, phone numbers and OTPs. A durable-write failure stops mutations; recover from storage/provider state rather than discarding the store. The caller must also keep fetch tracing, HTTP middleware, callback handlers and crash reports free of secrets.

## Single-account onboarding boundary

`../customer-onboarding.mjs` requires complete fresh adapter readiness and the effective USD cap before reserving one purchase for its explicitly authorized attempt. The second attempt required additional user approval, retained the earlier ledger and uses a common provider lock; exhaustion or refund speculation never triggers an automatic new attempt. Intent and operator reconciliation evidence persist across restarts; uncertain purchases cannot be retried with a new empty store. Notifications are not sent here. Their separately verified contacts are bound to customer/account ownership, contact kind and a hash of the exact private contact.

The user explicitly permitted a **public FVI mailbox for one hackathon test account**. That exception requires `mode:'hackathon'`, `publicMailboxTestConsent:true` and a one-account registry; it does not relabel a real account as a fixture or bypass production private-mailbox requirements. The [mailbox receipt](../evidence/jev-mailbox-smoke.json) records two rejected Jev choices and a separately reviewed fallback that initially opened an empty inbox. The same address was later associated with the assisted Delio profile. Inbound deliverability and email verification remain unproven; no Buena notification was sent. This does not assert that merchant welcome emails are absent.

The [third registration inspection](../evidence/registration-inspection-3.json), confirmed by [inspection 4](../evidence/registration-inspection-4.json), observed a phone-first entry, not an email-first signup flow. Those inspection receipts entered no details and requested no OTP. The two later operator-led phone-submit attempts did not verify an OTP/account. A third user-purchased activation subsequently produced a code and an assisted account observation, as described below. A returned native click does not establish a successful merchant SMS request. A new number is not proof of first-order promotion eligibility; receipt code `z5913` remains subject to [unverified promotion conditions](../promotion.provenance.json).

## Verification

Run `node --test trust-layer/delio/sms/*.test.mjs`. Tests cover the existing budget/unknown-state behavior, credential-free bounded discovery, exact HTTP errors, named-operator rejection, stock/rate ranking, stale data, expired conversion, rounding above the USD cap and fractional-cent provider prices. Live evidence now establishes three activations, one delivered code and an assisted test-account observation. It does not establish autonomous signup or a fully integrated coordinator. The latest adapter/discovery suite passed **44 offline tests**, including exact named-price/stock/freshness gates, variance preservation, single-purchase enforcement, history bounds and unchanged uncertain-purchase protection. The combined workspace suite passed **204/204 tests**, with zero failures/skips, including the imported-order/authentication/form changes. See the timestamped [validation summary](../validation/validation.json). Offline/fixture checks are separate from both failed attempts and the assisted account outcome.

## Historical operator attempts — both activations timed out

The [live receipt](../evidence/onboarding-live-test.json) retains **17.356 seconds** of initial operator attempts and **11.534 seconds** for the separately approved Virtual53 attempt, including failures. These are development attempt totals, not a successful-signup benchmark. The original history failure (6.006 s), explicit non-dispatch reconciliation (19 ms), uncertain initial submission (9.901 s) and failed second readiness attempt (6.973 s) remain in the accounting.

The Virtual53 phone-submit worker call returned `phone_submit_returned` in **2.093 s**, inside a **2.620-s** operator advance. No OTP field was observed, so the coordinator retained the pending operation and requires reconciliation. A later [read-only view](../evidence/registration-virtual53-post-submit.json) also showed phone/no OTP. Provider status `RECEIVED` means waiting for SMS, not code delivery. The [final provider receipt](../evidence/virtual53-sms-check.json) shows Virtual53 also reached `TIMEOUT` with zero SMS. Its requested same-number retry stopped in **169 ms** at the fresh-provider gate before a merchant call. The subsequent terminal-status refresh took **121 ms**; the prior zero-SMS refresh took **118 ms**. These failures/checks are retained in the operator totals. A future expiry value cannot override terminal status. The user reports the first refund, but neither order-linked credit is independently reconciled, so their historical gross subtotal remains **US$0.2807**, with net cost unknown. Including the later user purchase brings cumulative gross to US$0.4345.

No retry submission or third purchase was dispatched during those earlier attempts. Both original registration intents remain preserved for reconciliation; neither produced a verified account. The third imported activation is a separate assisted outcome. Later refund/account reconciliation must append its own sanitized receipt. No merchant order or payment is authorized by these registration tests.

## Latest assisted outcome — third activation

The imported activation’s first [submit](../evidence/user-purchased-registration-start.json) stalled while a POST to `identitytoolkit.googleapis.com` failed. The user explicitly approved allowing that **exact hostname** in the isolated worker, followed by a corrective same-number attempt. The [resume receipt](../evidence/user-purchased-registration-resume.json) and [SMS receipt](../evidence/user-purchased-sms-received.json) record authentication POST HTTP 200 responses and one code; no wildcard host expansion or new worker purchase was used for that correction.

The correction returned at **13:36:39.143 UTC**; the provider message was created at **13:36:55.434 UTC** and first observed at **13:37:01.092 UTC**. Approved VNC keyboard input entered the OTP, reached a new-user form and completed authorized test-profile details with the same prepared FVI email. Optional marketing remained unchecked. “Twoje dane” subsequently displayed the matching profile; the completed [private match verification](../evidence/user-purchased-account-verification.json) independently matches the expected name, birth date, email and phone and verifies the saved profile/onboarding artifact hashes. The new-profile path and unchecked marketing also rely on recorded operator UI observations, rather than the generic current-view classifier alone. The [final provider status](../evidence/user-purchased-final-provider-status.json) is `FINISHED`, with one SMS.

The owned-order check at **13:29:26.613 UTC** to the profile observation at **13:47:55.085 UTC** spans **18 minutes 28.472 seconds**, including approvals, setup and manual Codex VNC work. This is an observed assisted interval, not autonomous runtime, a reproducible speed benchmark or a population delivery-rate estimate. Email association does not prove email deliverability/verification. No Buena notification, coupon application, checkout quote or merchant order occurred. Gross cumulative SMS cost is **US$0.4345**; refunds/net cost remain unknown, and the automated coordinator’s earlier attempts still need reconciliation.
