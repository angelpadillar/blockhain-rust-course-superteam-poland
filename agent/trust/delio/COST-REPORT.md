# Delio pilot cost report — 19 September 2026

This report separates observed work from missing cost data. **No verified Delio checkout quote or real order has been completed.** Therefore cost per verified quote/success is undefined, and a sustainable paid fee has not been established.

| Item | Observed result | Interpretation |
| --- | --- | --- |
| First isolated homepage probe | **5.162 seconds** | Worker-reported elapsed probe time, including its setup/inspection work; not a checkout duration, pure page-load metric or browser-agent comparison. |
| Initial address-dialog check | **4.860 seconds** | Scanned too early; no dialog proof. This unsuccessful inspection remains part of the measured work. |
| Corrected address-dialog check | **5.003 seconds** | The dialog was observed after the readiness condition. No authenticated owner session or delivery coverage was established. |
| Private configuration read attempt | **4.918 seconds** | Failed setup inspection; retained in the measured work. No private configuration value is included here. |
| Address entry inspection | **10.412 seconds** | The observation was truncated; did not verify coverage. |
| Interactive address inspection | **10.499 seconds** | Private inspection found blank suggestions; no delivery selection or quote. |
| Diagnostic attempt | **8.298 seconds** | Failed inspection; retained in the measured work. |
| Dependency diagnosis | **5.978 seconds** | Identified a blocked map dependency; typing stopped on an ambiguous selector. |
| Corrected address lookup | **6.598 seconds** | Permitting the observed map dependency exposed a matching street/city candidate. Selection, postcode and coverage remained unverified. |
| Worker access status | **4.711 seconds** | Owner authentication and delivery remained unverified. |
| Address candidate match | **6.773 seconds** | Multiple place variants caused a stop. |
| Exact address inspection | **5.299 seconds** | The snapshot omitted the input; no delivery proof. |
| Native address click | **11.151 seconds** | Click timed out with an uncertain outcome; retained as unsuccessful work. |
| Exact address selection | **7.255 seconds** | Street/building/city/postcode matched and the candidate was selected. This does not confirm delivery coverage. |
| Delivery confirmation inspection | **6.755 seconds** | The actual confirmation control was still loading when the probe stopped. |
| Native delivery confirmation | **12.111 seconds** | Native control timed out; confirmation remained unverified. |
| Visible confirmation inspection | **6.517 seconds** | Native selector uncertainty prevented verified completion. |
| Restored worker status | **4.300 seconds** | Returned precise login, delivery-confirmation/address and uncalibrated-cart blockers. |
| Model calls across those eighteen probes | **0** | No model charge for those measured probes. Does not establish zero total operating cost. |
| Cart mutations in those probes | **0** | Live cart controls and checkout quoting remain uncalibrated. |
| SMS activations purchased | **3** | Gross **US$0.4345 = US$0.1269 + US$0.1538 + US$0.1538**. First two timed out; third was purchased manually by the user and produced a code. Refunds/net cost remain unknown. |
| SMS authorizations | **Two operator purchases plus one user purchase** | Original operator approvals/ledgers remain intact. The third owned activation was imported, not purchased again by the worker. No additional purchase is inferred. |
| New test account | **1 assisted observation** | Native worker calls plus approved Codex VNC input and human approvals; not an autonomous signup benchmark or a completed checkout. |
| Verified live checkout quotes | **0** | No success denominator. |
| Real merchant orders/payments | **0** | Not implemented or requested in this milestone. |
| Public catalogue | **8 cached items with photo links** | Public source/retrieval metadata and local category filters are available. Kraków/Warsaw selection is a browsing preference; regional inventory, fresh stock and checkout prices remain unverified. |
| Coupon benefit | **Unknown; none applied** | Receipt code `z5913` reports 75 zł off a 150 zł basket and apparent expiry 18 November 2026. Matching terms, expiry and account eligibility are unverified; no savings are counted. |
| Infrastructure | **Unknown** | VPS/browser/hosting/storage costs have not been allocated to these attempts. |
| Manual work/support | **Unknown** | Inspection, setup, recovery and support time are not priced or allocated. |
| Payment/FX costs | **Unknown / not exercised for merchant checkout** | No merchant payment occurred; SMS provider charges are recorded separately. Future processor, funding, currency conversion and settlement costs have not been measured. |
| Complete variable cost | **Unknown** | Missing components cannot be replaced with zero. |
| Cost per verified quote / completed order | **Undefined** | Zero verified quotes/orders, and no complete cost basis. |

The eighteen reported probes total **126.600 seconds of measured probe time**, as retained in the [canonical probe receipt](./evidence/live-probe-summary.json). This is the sum of those individual measurements, not complete project time, elapsed operator time or a successful-checkout time. One source-upload/follow-up attempt stopped before browser startup when the SSH signing agent was unavailable; its operator/setup time is unmeasured and excluded from this browser-runtime sum, not treated as free work. Connection recovery allowed later probes and worker restoration. None of the probes proves authenticated access, address coverage, successful cart changes, final checkout, latency under repeat use or a reliable conversion rate. Further access inspection must retain its own attempt timing and outcome; it must not be merged into the 5.162-second homepage figure or discarded because it failed.

## Operator UI attempts

| Controller attempt | Elapsed time | Outcome and model cost |
| --- | --- | --- |
| First UI merchant-access check | **386 milliseconds** | Uncertain worker outcome; cost unknown. The worker client returned a nonzero exit for a parsed blocker response, which the adapter classified as a transport failure. |
| Recheck after client-exit fix | **377 milliseconds** | Authenticated UI → controller → SSH worker returned accurate access blockers; operation `not_dispatched`, zero model calls and known model cost **US$0**. |

These controller attempts total **763 milliseconds**, measured separately from the browser diagnostics above and retained in the [UI access receipt](./evidence/ui-access-check.json). Both recorded zero model calls. The successful status round trip verifies transport and blocker display, not a checkout quote. Both attempts remain in the accounting; the first attempt's missing cost is not zero. No quote-success denominator was added.

## Later registration inspections

| Attempt | Controller time | Nested worker/browser time | Outcome |
| --- | --- | --- | --- |
| [Inspection 1](./evidence/registration-inspection.json) | Unknown | Unknown | `registration_entry_ambiguous`; no cart operation dispatched. Missing usage/timing is not replaced with zero. |
| [Inspection 2](./evidence/registration-inspection-2.json) | 9.247 s | 9.082 s | Native wait timed out; no customer details, SMS or cart operation requested. Zero model calls / US$0 model cost. |
| [Inspection 3](./evidence/registration-inspection-3.json) | 5.022 s | 4.847 s | Phone-first entry observed. No fields filled, terms accepted, OTP requested or account created. Zero model calls / US$0 model cost. |
| [Inspection 4](./evidence/registration-inspection-4.json) | 5.244 s | 4.973 s | Phone-first entry confirmed with private screenshot/observation hashes; still no fields, OTP or account. Zero model calls / US$0 model cost. |

The three retained controller measurements total **19.513 s**, including **18.902 s** of nested worker measurements; these must not be added together. The first attempt remains untimed. Those inspections did not verify later signup fields. They are separate from the eighteen earlier probes and do not add checkout successes.

## Jev and public mailbox test

The [mailbox receipt](./evidence/jev-mailbox-smoke.json) retains **two real Jev calls**. Both failed the choice-confidence gate and executed no browser action from their answer. The first call's tokens/latency were not retained; its cost is unknown. The second took **650 ms**, used **515 input / 33 output tokens** on `jev-1.13.0`, and proposed `get_email` with probability **0.74**, below the required gate. Its charged cost is also unknown. The retained tokens are a partial total, not all token usage.

A separate reviewed fallback opened an empty FVI inbox under the user's explicit single-hackathon-account public-mailbox consent. That initial mailbox action created no Delio account. Its address was later used in the assisted test profile; inbound email delivery remains unverified. This is not a Jev-only completion. Manual/fallback effort is unpriced.

## 5SIM read-only discovery

| Retained request group | HTTP result | Known request time |
| --- | --- | --- |
| [Earlier local public probes](./sms/public-docs-snapshot.json), four requests | 403 each | Not retained |
| [VPS Python public products/prices](./sms/public-preflight-20260919.json) | 403 / 403 | 38 / 25 ms |
| [Authenticated profile and public products](./evidence/fivesim-auth-preflight.json) | 200 / 403 | 124 / 48 ms |
| [Credential-free Node public products/prices](./sms/public-preflight-20260919.json) | 200 / 200 | 69 / 102 ms |
| [Fresh operator public products/prices](./evidence/fivesim-operator-preflight.json) | 200 / 200 | 198 / 167 ms |
| [Authenticated budget preflight](./evidence/fivesim-auth-budget-preflight.json) | 200 | 387 ms; confirms balance covers the authorized cap without exporting the balance |

The successful product/price discovery observed product `zabkajush`, five in-stock Polish offers, and **US$0.1026–0.1538** prices under the separately recorded official USD denomination evidence. Three offers report success rate zero and two omit it; none meets a 90% preference, and no sample size/window is supplied. They are neither high-success offers nor reserved prices. API responses themselves omit currency. Earlier 403s remain evidence of those attempts, not global provider unavailability or invalid credentials.

The saved [fresh operator preflight](./evidence/fivesim-operator-preflight.json) observed stock 28,679 and the same price range with zero/missing rates. Its concurrent request durations are components of the operator preflight, not additional elapsed operator time. The authenticated budget preflight confirms funding for the authorized cap without publishing account identity or balance.

Those discovery receipts performed no purchases. The subsequent live purchase is reported below and plus the later user purchase bring current gross SMS spend to **US$0.4345 for three activations**. A service listing and successful purchase still do not prove Delio acceptance, delivered OTP or account recovery. No cancellation, finish, rental or notification is recorded; no refund is assumed.

## Accounting policy

`costs.mjs` sums recorded worker attempts, including failed, uncertain and abandoned attempts. It separates known and estimated model charges from missing usage. Complete cost and contribution margin remain null when infrastructure, manual support, payment/FX or model components are missing. A numerator with known charges only is a lower bound, not an all-in cost.

The optional 5SIM adapter reserves a provider-denominated cap before purchase, records actual gross price after a known response, and preserves unknown cost/reservation after an uncertain response. It does not infer a refund from cancellation. The official provider website/balance migration statements now supply USD evidence, retained in the public preflight. Numeric API prices still carry no currency field. The caller must explicitly retain that denomination evidence and a current, fee-inclusive conversion upper bound showing the whole reservation fits each explicitly authorized attempt’s US$0.20 ceiling before its paid request. The additional named-operator authorization accepts that only a fresh exact quote, not a provider-enforced `maxPrice`, constrains its quoted price. The code can rank reported available offers by historical delivery percentage, but missing rates are unknown and a high percentage is not a delivery guarantee.

See [SMS research and implementation notes](./sms/README.md) for sources, precision, one-purchase reservations and uncertain-outcome reconciliation. Infrastructure, manual work, funding/payment/FX costs and the missing Jev charges remain unknown; none is made zero by successful public discovery.

## Pilot fee recommendation

**PLN 0 Buena service fee; no charge for this pilot.** Display that fee separately from merchant charges and obtain acceptance of the exact quote. Do not charge for an unverified quote or describe the pilot as profitable.

Before proposing a paid fee, collect repeated verified quotes and eventual authorized order outcomes, preserving all retries and failures. Measure model/provider bills, browser runtime and allocated infrastructure, manual setup/recovery/support, payment/FX costs, refund/reconciliation costs and the fraction of quotes that become completed orders. Allocate abandoned quotes to that cohort rather than omitting them. Coupons reduce the customer's merchant bill; they are not service revenue. Only then compare a proposed disclosed fee with a defensible cost-per-completed-outcome estimate.

## Evidence and scope

The prior [local gifting recording](/Users/buena/Documents/ChatGPT/typesafe-ai-experiment/checkpoints/gifting-2026-09-19/recording-complete/gifting-local-demo.mp4) and [hashed checkpoint](/Users/buena/Documents/ChatGPT/typesafe-ai-experiment/checkpoints/gifting-2026-09-19/README.md) preserve fictional merchant and local LiteSVM demonstrations. Their transactions and success counts are not Delio production outcomes and are excluded from this report's denominator. Wallet authentication, devnet deployment, real merchant execution/payment, fulfillment and recipient notifications remain separate milestones.

## Historical first two activations — 19 September 2026, 10:42:32 UTC

The [consolidated receipt](./evidence/onboarding-live-test.json) retains **two actual purchases: US$0.1269 and US$0.1538, totaling US$0.2807 gross**. Both activations are `TIMEOUT` with no verified code. The user reports the original refund, but neither credit has been independently reconciled. **Net SMS cost remains unknown.** The second purchase had [separate explicit approval](./evidence/virtual53-authorization.json) and exactly matched its fresh quote. Each authorized ledger allows one purchase; the original ledger is preserved and a common lock prevents concurrent provider operations.

| Attempt / operator action | Duration | Outcome |
| --- | --- | --- |
| Initial: public preflight | 231 ms | Read-only offers. |
| Initial: first phone-ready advance | 6.006 s | History sentinel stopped the flow before paid intent/dispatch. |
| Initial: explicit non-dispatch reconciliation | 19 ms | Recorded the known pre-purchase failure; no paid replay. |
| Initial: phone-ready advance after fix | 1.029 s | Activation purchased for US$0.1269. |
| Initial: advance toward OTP | 9.901 s | Phone submission outcome uncertain; reconciliation required, no OTP verified. |
| Initial: provider refresh | 170 ms | Original activation observed `TIMEOUT`. |
| Virtual53: first readiness advance | 6.973 s | `merchant_registration_page_unverified`; no purchase during this failed advance. |
| Virtual53: phone-ready advance | 1.296 s | Exact US$0.1538 purchase after fresh stock/price check. |
| Virtual53: advance toward OTP | 2.620 s | Worker returned `phone_submit_returned`; no OTP field, so coordinator retained reconciliation requirement. |
| Virtual53: first provider refresh | 237 ms | Provider `RECEIVED`; waiting for SMS, not OTP delivered. |
| Virtual53: later provider refresh | 118 ms | `RECEIVED`, zero SMS. |
| Virtual53: requested same-number retry | 169 ms | Fresh provider check rejected `registration_retry_sms_not_ready` before a merchant call; no retry dispatched. |
| Virtual53: final provider refresh | 121 ms | `TIMEOUT`, zero SMS; no third purchase. |

Recorded operator totals are **17.356 s initial + 11.534 s Virtual53 = 28.890 s**. Nested merchant-controller totals are **15.907 + 10.025 = 25.932 s**, including nested browser totals **15.052 + 8.994 = 24.046 s**. Do not add nested measurements again. The second submit itself took **2.093 s** at the worker-call boundary, including **1.921 s** browser time; it is already inside the 2.620-second operator advance.

Additional standalone read-only evidence remains separate: [initial post-submit inspection](./evidence/registration-post-start-inspection.json), 293-ms controller / 131-ms browser; [provider SMS check](./evidence/sms-after-uncertain-submit.json), 650 ms with no code; [requested refresh](./evidence/sms-user-refresh-1789813323577.json), 156 ms and `TIMEOUT`; [Virtual53 offer check](./evidence/virtual53-check-1789813418126.json), 211 ms; [failed follow-up view inspection](./evidence/registration-followup-preflight-inspection.json), 390-ms browser; [ready follow-up inspection](./evidence/registration-followup-preflight-inspection-2.json), 5.131-s browser; and [second post-submit inspection](./evidence/registration-virtual53-post-submit.json), 164-ms browser with phone field/no OTP. Related analysis/readiness files may reference these same observations; those copies are not new attempts. Missing controller timings remain unknown. There is no complete project-time or signup-speed denominator.

The [history diagnostic](./evidence/fivesim-history-diagnostic.json) retains response structure only. The fix recognizes exactly numeric `999999`, requires valid unique IDs, limits each page to 100 rows and the scan to 500, and ends sentinel pagination only on a short page. Other incomplete histories stop before paid dispatch. Unknown paid outcomes still reserve the cap and require reconciliation; no automatic paid retry was added.

The user’s Virtual53 UI report was **69.01%**, while the saved public API check returned **0%** at that time; the price/stock matched US$0.1538/four numbers. Reported historical delivery rates are not account-success measurements. The named purchase has no provider-enforced price cap: a fresh exact quote plus explicit risk acknowledgement permitted this one test, and actual price/operator variance would be retained and block further purchases.

The [final Virtual53 checks](./evidence/virtual53-sms-check.json) preserve its transition from `RECEIVED` with zero SMS to `TIMEOUT` with zero SMS. Terminal provider status blocked the requested recovery even though an expiry timestamp was still in the future. No retry merchant call or third purchase occurred during that historical attempt; the later user purchase is recorded separately below.

Those two attempts verified no OTP or account. Their request dispatch remained unverified; the later authentication-host finding means these timeouts must not be classified as proven provider delivery failures. Their costs and failed work remain in this report. The full workspace suite passed **204/204 local tests** with zero failures or skips in **5.067 seconds**; see timestamped [validation](./validation/validation.json). These offline checks are separate from live outcomes.

## Third user-purchased activation and assisted account outcome

The user purchased another Virtual53 activation at **US$0.1538**; the [owned-order check](./evidence/user-purchased-activation-check.json) confirmed its price, operator, ownership and active state in **163 ms**. Importing it did not buy another number or erase the earlier attempts. Combined **gross SMS cost is US$0.4345**; neither earlier refund is independently reconciled, so net cost is unknown. The user reported a 68.85% UI rate for this purchase, while the public API rate remained zero; no population success-rate claim follows from either display or this single outcome.

| Recorded component | Controller time | Nested browser time | Outcome |
| --- | --- | --- | --- |
| [Imported-order initial submit](./evidence/user-purchased-registration-start.json) | 7.975 s | 6.953 s | Stalled; observed authentication POST failed, outcome retained. |
| [Approved same-number correction](./evidence/user-purchased-registration-resume.json) | 7.952 s | 7.091 s | After exact-host approval, authentication POST returned HTTP 200; no new purchase. |
| [Post-authentication observation](./evidence/user-purchased-registration-after-auth.json) | Not retained | 152 ms | Four-input code view subsequently grounded from its private artifact. |
| [After OTP entry](./evidence/user-purchased-after-otp.json) | Not retained | 158 ms | Current view retained; interpreted with the approved VNC flow, not a generic classifier success flag. |
| [Profile-form observation](./evidence/user-purchased-profile-step.json) | Not retained | 215 ms | Name/email/phone controls observed. |
| [Later profile-view capture](./evidence/user-purchased-account-profile-observation.json) | Not retained | 303 ms | Saved artifacts retained; expected profile fields independently matched and artifact hashes checked in the separate verification receipt. |

The two submit calls total **15.927 s controller**, including **14.044 s browser**. The four separate observation measurements total **828 ms browser**. These are component timings only. The recorded owned-order check at **13:29:26.613 UTC** to profile observation at **13:47:55.085 UTC** spans **18 minutes 28.472 seconds**, including approvals, setup, waits and manual Codex VNC interaction. It is an assisted observed interval, not autonomous execution time or a repeatable signup benchmark. Earlier purchase/setup time and complete human effort remain unmeasured and unpriced.

The [SMS receipt](./evidence/user-purchased-sms-received.json) confirms **one message/code available**, following authentication HTTP 200 responses after the [user-approved exact-host change](./evidence/registration-auth-host-approval.json). The corrective submit returned at **13:36:39.143 UTC**; the message was created at **13:36:55.434 UTC**, first observed at **13:37:01.092 UTC**, and the [final provider check](./evidence/user-purchased-final-provider-status.json) reports `FINISHED` with one SMS. The code itself is not exported. Approved VNC keyboard input completed OTP verification and a new-user profile form, with all optional marketing unchecked. “Twoje dane” then displayed the matching profile, giving **one assisted observed new test account**. Raw contact and test-profile values are private; the completed [private profile-match verification](./evidence/user-purchased-account-verification.json) independently matches all expected profile fields and verifies both saved DOM/screenshot pairs. New-flow and unchecked-marketing conclusions also include recorded operator observations; this does not make the signup autonomous. Email association is observed, but deliverability/email verification is not proven. No Buena notification was sent; merchant welcome-email delivery was not assessed.

This outcome used native RPC, Codex VNC interaction and explicit human decisions. It does **not** demonstrate autonomous Jev signup, a repeatable provider delivery rate or a fully reconciled automated onboarding coordinator. The old coordinator intents remain pending. The known gross SMS subtotal associated with this one assisted account is **US$0.4345**, not complete account-acquisition cost. Model charges, infrastructure, manual work and future merchant payment/FX remain incomplete. Verified checkout quotes, coupons and orders remain **zero**, so quote/order cost-per-success remains undefined and the **PLN 0 no-charge** pilot recommendation remains.
