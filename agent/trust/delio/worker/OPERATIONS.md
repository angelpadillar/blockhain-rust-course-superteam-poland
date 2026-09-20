# Isolated Delio access worker

This is a live access/coverage probe and a fail-closed adapter skeleton. It does **not** yet implement authenticated cart reading, cart mutation or checkout quotation. It never treats the public zero-item counter as an owner cart.

## Boundary and interface

The fixed client reads one JSON object from stdin:

```json
{"operation":"status"}
```

The deployed operation names are `status`, `observeCart`, `mutateCart`, `quote`, `inspectRegistration`, `inspectRegistrationState`, `startRegistration`, `startFollowupRegistration`, `resumeRegistration` and `startImportedRegistration`. Recovery is limited to the explicitly authorized Virtual53 follow-up or the exact imported order, as described below. `mutateCart` accepts `lines: [{productId, quantity}]`, but currently returns a precise known-no-dispatch blocker. No URLs, selectors, JavaScript or tokens are accepted in these requests. Only private registration accepts an opaque account binding and Polish phone as described below.

The root application invokes the fixed command:

```sh
ssh root@100.121.5.10 docker exec -i buena-delio-worker node /app/delio/client.mjs
```

The client reads its own token from a private mounted file and calls `127.0.0.1:8794/rpc` inside the container. That API is not published to the host. Known replies are `{ok:true,result}` or `{ok:false,code,dispatched:false,blockers,result?}` and exit0 in both cases. The blocked `result` includes measured `browserRuntimeMs`, `modelCalls:0`, `usage:{modelCalls:0,modelCostUsd:0}`, observation time and evidence references. Transport failures exit1 and omit any no-dispatch assertion; their outcome must be reconciled. An initial integration attempt exposed the old nonzero exit for a valid blocker and was retained rather than erased.

`status` actively observes the browser. The frontend's cached `GET /api/state` must not invoke it; only an authenticated, explicit access check does so.

`inspectRegistration` accepts no other fields. Under the same ownership lock/busy gate, it opens the freshly observed sign-in control and reads the resulting native page. It can follow a distinct observed registration link, but contains no fill, checkbox, submit or SMS-request action. The result contains fixed field categories and markup attributes, never field values or arbitrary labels. A missing HTML `required` attribute does **not** prove a field is optional; application validation may still require it. It does not verify the sequence of later registration steps.

`inspectRegistrationState` accepts no other fields and reads the **current owned view only**. It never launches a new session, navigates, clicks sign-in, types or submits. If that view has expired, it returns `registration_current_view_unavailable` instead of reconstructing one. It privately hashes the current screenshot and observation. Ordinary read failures preserve the current page; a hard deadline can close the runtime. An input marked `autocomplete="one-time-code"` is classified as OTP even when its type is `tel`. This operation makes no statement about prior OTP requests or successful account creation, and is the appropriate observation after phone submission.

The first successful live inspection observed one `type=tel` phone field, terms/privacy text and a Google option; no email/password/OTP field appeared in that entry markup. It took4.847 seconds and used zero model calls. Both earlier failed reads remain in `../evidence/registration-inspection*.json`; the second failed because the reader assumed a dialog, then the successful reader used the resulting page directly. That inspection entered no personal details, accepted no terms, created no account and requested no SMS. The daemon/profile were preserved across the source-only graceful restarts.

A further4.973-second capture grounded the exact phone contract: one form, one empty tel input with `maxlength=11`, the visible required label `Numer telefonu *`, and one `Dalej` submit. The page says continuing accepts service/alcohol-sale terms and privacy policy; there are no consent checkbox controls. This is account onboarding, not an alcohol purchase. `inspectRegistration` now reports `phoneSubmissionReady` only when this fixed contract is observed and the phone input is empty. It reads an already-open form without another sign-in click. Private screenshot and observation files are hashed; only their opaque identifiers/hashes leave the worker.

The private stdin request `{"operation":"startRegistration","accountId":"delio-pilot-owner","phone":"+48XXXXXXXXX"}` is allowed only for the authorized test account. The phone must be an actual Polish E.164 value; placeholders are rejected. The native input receives its nine domestic digits and is checked before submitting the observed `Dalej` button. A private fsynced one-use intent is created before filling and updated before SMS submission. It binds the account to an HMAC of the phone; phone values never enter the journal or public result. Screenshots/DOM observations may contain the phone and remain in private worker storage. No optional marketing is selected.

The operation stops after one submit and a fresh observed view. `phone_submit_returned` is not SMS delivery or new-account proof. `needs_reconciliation`, a timeout or a lost reply never permits a blind retry; an existing `registration-intent.json` blocks another start. No OTP or email completion operation is implemented yet. A recycled number may expose an existing account after verification: this is not proof of a new registration and must not authorize reading its history/cart or adopting it. Further stages must be grounded independently. The operation was deployed and tested offline but **not executed with a real phone by this subtask**; the coordinating host owns the single paid activation and explicit execution.

The coordinating host subsequently ran the single authorized phone attempt. Its4.399-second worker result was uncertain. The durable intent records an attempted SMS submit; a later131-ms read observed the same phone form, no OTP field and the same bound phone digits. This does not prove whether the merchant dispatched an SMS. The provider subsequently returned terminal `TIMEOUT` with zero SMS; that terminal status overrides its nominal future expiry. No resume was run, no new activation was bought and no account was verified.

The first activation's proposed recovery was never enabled or executed because its provider status became terminal `TIMEOUT`. It remains ineligible. A later explicit authorization applies only to the separately purchased Virtual53 follow-up, with the same owned profile and customer. It does not reset or erase the first activation's audit.

`resumeRegistration` now accepts only the private `accountId` and current Polish E.164 `phone`. The existing intent must have `followupCount:1`, `approvalId:"virtual53-test"`, one prior submit, no used recovery, the same account/phone HMAC, and an uncertain or `phone_submit_returned` stage at least60 seconds old. It preserves the first native-returned outcome as outcome-unverified and retains the older activation's history. The controller must independently refresh the same owned provider activation and require zero SMS, active status and unexpired lease immediately before invocation. The worker never buys or polls an SMS activation itself.

Recovery reserves its one-use allowance before any same-phone refill and durably records submit two before clicking a freshly observed native reference. It refuses OTP/email/password/account/challenge views, mismatched phone, disabled/read-only input, active invalid markers or disabled submit. It can reopen only a freshly observed anonymous sign-in entry after source reload, then fill the same bound phone if blank. It permits no third submit and never automatically retries a native error. A bounded post-action observation is not account or SMS proof. Agent deployment/testing does not invoke recovery; the coordinating host owns that action.

**Prior automated-activation outcome:** the coordinating host's fresh provider check at1789814540539 returned terminal `TIMEOUT` with zero SMS for the Virtual53 activation, despite its nominal expiry still being in the future. The provider guard stopped before any recovery merchant call. The one-use recovery RPC remains implemented and enabled but was **not invoked**; the terminal activation is ineligible. No further number is authorized, no OTP completion was built or attempted, and a live new account remains unverified. The original uncertain activation and the Virtual53 native-returned-but-unverified submit remain separate preserved audit history. Worker sources are frozen;42 offline worker tests pass.

## Separately authorized follow-up

`startFollowupRegistration` accepts only `accountId`, a new Polish E.164 `phone`, the original `previousPhone`, `previousActivationStatus:"TIMEOUT"`, and `approvalId:"virtual53-test"`. The trusted controller must first verify the terminal status against the same owned provider order; the worker does not independently query the SMS provider. This is one separately approved activation, not an automatic retry or allowance reset.

The worker requires the original account and phone HMAC, an uncertain submitted prior intent, no previous follow-up and a different new phone. It observes the same owned browser profile and exact anonymous phone form, stops on OTP/email/password/account/challenge indicators, and can clear only an empty field or the bound old phone. It atomically reserves the one follow-up before entering the new phone. The complete old intent, including every prior artifact and uncertainty flag, is embedded in a history record with its SHA256; it is never deleted or replaced by a fabricated successful record.

Baseline start and follow-up both fill and click fresh observed native references, with one durable submit reservation before clicking. The follow-up permits one submit, reads the resulting view briefly without repeating actions, and retains failures privately. A returned native action is not SMS delivery or account-creation proof. Existing email/profile ownership is unchanged, no email is supplied to this operation, and later OTP/onboarding remains unimplemented until observed. Source deployment and offline tests do not execute this operation; the coordinating host owns the actual invocation.

Registration reads use interactive snapshots within the installed tool's1,000-element maximum and its524,288-byte HTML maximum. An earlier homepage capture hit the smaller prior limits and correctly failed readiness; it was never used to justify buying a number. After this bounded correction and a fresh sign-in entry inspection, the worker observed the exact empty phone form in5.131 seconds. Both initial and follow-up readiness were true, with no OTP/email/password or consent checkbox. `followupSubmissionReady` is separate from initial empty-field readiness: it requires the existing uncertain intent, no used follow-up allowance and a blank field or the exact old phone HMAC, and exports only the server-owned opaque `registrationIntentAccountId`. The controller must still validate the provider's terminal status. The reader never reports an arbitrary filled phone as ready.

## Explicitly supplied existing order

The user separately supplied an already-purchased activation and authorized signup on the same test customer/profile. `startImportedRegistration` is scoped to `activationOrderId:"1094850855"` and `approvalId:"user-order-1094850855"`, with private `accountId` and `phone` passed over stdin. The coordinating host verifies that exact owned order, phone, product, country, operator, active status and lease before invoking the worker. This operation never purchases a number and does not authorize another purchase.

The worker requires the same existing account, a different phone from the current bound intent, a prior uncertain/native-returned submitted attempt, and no previous imported activation. It permits one imported submit only. An empty field or the previous bound phone may be replaced; an unrelated filled phone, OTP/account/challenge view or invalid form stops execution. The entire prior intent, including its older activation history, is retained inside a hashed history record before private input. A repeated import is denied. Deployment and48 offline tests are complete; the coordinating host owns execution.

The first imported native submit observed a `POST` response200 from Delio and a failed `POST` to `identitytoolkit.googleapis.com`; the phone view remained and no OTP was verified. That hostname was absent from the allowlist. This evidence alone did not prove the failure was a policy denial. The user then explicitly approved adding that exact Google authentication host to this isolated worker. The host was added under `reviewedAuthHosts` and the daemon reloaded. No wildcard or other authentication host is accepted. Google documents it as the phone-verification SMS endpoint; the worker continues only through native Delio UI and never calls it directly.

For this exact imported activation, `resumeRegistration` permits one corrective same-number attempt with the same account/HMAC, exact imported order/approval,60-second cooldown, unused recovery and one previous submit. The controller still requires a fresh active/unexpired/sms0 provider check immediately before dispatch. Prior returned-but-unverified native outcome and all older history remain intact.50 offline worker tests pass; the agent applied configuration but performed no corrective submit.

Registration responses now include native network diagnostics reduced to hostname, closed HTTP method/event/status categories, a policy-block boolean only when explicitly reported, and aggregate count. Paths, query strings, headers, bodies and raw network errors never leave the process. A failed request alone does not establish allowlist denial. This adds no eval, cookie, upload, arbitrary browser command or new host permission.

## Isolation and lifecycle

- Code: `/opt/buena-delio-worker`, mounted read-only as `/app/delio`.
- Only this worker's profile/config/secrets: `/data/buena-delio`.
- Base image: `buena-captions-editor-camoufox:0.1.29-9`; process uid1001.
- Production MCP uses `full` only to include native hostname-level network diagnostics behind the fixed private operation API, one session, a ten-minute upstream TTL and no eval, cookie, upload, download, proxy or import/export enable flags.
- Exact reviewed browser hosts: `delio.com.pl`, `maps.googleapis.com`, `maps.gstatic.com`, `identitytoolkit.googleapis.com`. The two map dependencies were observed failing, then returning200 when allowed. Analytics, consent and unrelated CDN hosts were not broadly admitted.
- A filesystem ownership lock prevents a second process from using the profile. An unreviewed stale lock stops startup rather than being erased automatically.
- A request is bounded to27 seconds of active work; the client timeout is29.5 seconds. Cleanup may take additional time. A single operation owns the browser; requests are not queued across a changing page state.
- The browser closes after five idle minutes when manual desktop is enabled (two otherwise). The daemon retains ownership; the next operation reopens the same profile and observes it again. No cookies or session values are exported.
- Desktop is password protected and published only as `100.121.5.10:6094` on Tailscale. It starts on explicit worker activity and closes with the browser. Its private credential is in the new Delio secrets directory, never in API output or source.

The existing Captions service, its profile and its secrets are not read or changed. Three source helpers were copied with provenance from that service: private MCP client, display lifecycle and ownership lock. The worker does not connect to its running browser.

## Evidence and remaining work

`evidence/public-home.png` is a real fresh-profile homepage screenshot reviewed before publication. Address screenshots and DOM/text diagnostics remain private on the VPS; they are not public artifacts. The access status exports only fixed messages, booleans, time, capability flags and opaque observation hashes. A delivery commitment remains null until the exact delivery and required slot are both verified; merely seeing a suggestion is insufficient.

The operator inspection scripts are development-only native UI probes. They do not form a general remote-control API. A diagnostic pass used `full` only to read hostname-level network events, with the same missing eval/cookie/upload/proxy permissions. Request URLs, query strings, headers and bodies are not exported. Failed requests alone do not prove policy denial.

The daemon is restored. The desktop at `http://100.121.5.10:6094/vnc.html` returned HTTP200, the RFB server required password authentication, and unauthenticated RPC returned401. The private password can be retrieved by the operator on the VPS from `/data/buena-delio/secrets/vnc-password.txt`; do not put it in a URL, source file or evidence log.

The exact street/building/city/postcode was observed after selecting the matching address suggestion. The final native confirmation control remains uncalibrated. This is `delivery_confirmation_unverified`, not a delivery-area rejection. Manual address confirmation and owner login remain necessary; the delivery slot is not verified and no delivery commitment is issued. Historical access measurements and failures are tracked in `../evidence/live-probe-summary.json`; later registration inspections have separate receipts. The separately authorized phone operation does not enable payment or merchant orders.

Before enabling real cart methods, calibrate them against an authenticated owner session and exact delivery selection, add independent observation/reconciliation and quote evidence, and preserve the core's version/fee/expiry guards. A local LiteSVM quote authorization is not a merchant purchase.
