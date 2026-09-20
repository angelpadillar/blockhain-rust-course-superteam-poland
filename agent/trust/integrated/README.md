# One gifting workflow, with an enforced authorization boundary

Implemented 19 September 2026. This connects a real browser observation, exact quote approval, executed local Solana transactions, a simulated merchant order and independent result verification in one interface.

**Local demo:** `http://127.0.0.1:4318`. From the hackathon repository, run `npm run demo:gifting`. From the experiment workspace, run `node trust-layer/integrated/server.mjs`. Chrome and the built local bridge are required. The URL is on the Mac running the process, not the VPS.

## Rehearse the three stories

1. **Everything matches:** review the fictional recipient brief and coffee gift, approve exactly PLN 129, then execute. The program confirms a sender-signed mandate, consumes it before the browser submits the fixture order, and records the verified result. Click **Test duplicate protection**: a fresh signed replay transaction fails in the program and merchant dispatch count stays one.
2. **The price changes:** start a fresh story and approve PLN 129. The fixture changes checkout to PLN 149. Execution stops before consuming the mandate or contacting the merchant order endpoint. The screen retains approved and observed totals and asks for a new approval.
3. **The reply goes missing:** approve and execute. The fixture accepts one order but simulates response loss. The run pauses. Reconcile to read the existing order, verify it and complete its chain receipt; no second order is sent. Starting a replacement run is blocked while this remains unresolved.

The evidence screen exposes real local signatures, transaction logs, decoded account state, verified fields, screenshots and an exportable JSON receipt. Screenshots and observations are hashed at quote, approval and confirmation. Quote/approval evidence must be complete before execution.

## What is real, and what is simulated

| Part | Meaning in this demo |
| --- | --- |
| Recommendation | Fixed coffee gift justified by an explicitly fictional recipient brief and fixture catalogue. No live research or model recommendation is claimed. |
| Browser | Actual isolated Playwright/Chrome session reads the fixture checkout and submits its order form. Existing Glovo/v4/Camoufox/Jev work is not changed or newly benchmarked. No model call is necessary for this fixed fixture. |
| Solana | The compiled Anchor SBF program executes signed transactions in **LiteSVM**, a local in-process Solana environment. It is not devnet, a public validator, a deployed service or a wallet-connected UI. |
| Signers | Ephemeral demo sender, executor and trusted oracle keys, generated per run. An interface approval requests their local transaction; the executor independently checks program state. |
| Money and fulfillment | PLN amounts and merchant fulfillment are simulated. A fictional token uses a declared 1 PLN-to-1-demo-token mapping, with zero fee. No real card charge, FX, shipping or physical delivery. |
| Outcome | Merchant DOM and a separate fixture order ledger must match the approved item, variant, quantity, merchant, recipient, amount, currency and attempt. The trusted local oracle then records `Purchased`. Escrow settlement and delivery are outside this slice. |

There are no public explorer links. The same process controls the local signers and fixture oracle; this demonstrates the program/executor integration, not production separation of trust.

## Exact binding and execution

`encoding.mjs` independently reproduces Rust's **602-byte** `gift-campaign:mandate-quote:v1` digest. Browser-derived merchant, item/variant/quantity, recipient and complete quote commitments enter that encoding. Preparation compares the intended values to the chain's canonical inputs; approval and execution compare both digests and decoded state.

The sender signs an exact-cap mandate and executor quote approval atomically. Execution requires confirmed `Approved` / `Active` accounts with the exact approved digest; a UI Boolean is insufficient. The executor re-reads checkout, rejects any change, persists attempt identity, then submits the program instruction that atomically records `PaymentAttempted` and consumes the mandate. Only confirmed consumption enables one fixture dispatch.

The contract enforces signer, account binding, commitments, caps, expiry and one-use state. **The executor checks the live checkout.** Solana does not inspect merchant pages. Matching hashes alone do not establish truthful source data.

Uncertain chain outcomes retain the pending attempt ID and stop for reconciliation. An already recorded matching purchase is recognized without reissuing its confirmation transaction, allowing missing evidence to be recovered. A missing order after mandate consumption stays unresolved for operator review; it is not permission to buy again.

## Verification and artifacts

`integration.test.mjs` runs real browser and SBF paths, including three consecutive fresh successes, changed price, fresh-signature replay, concurrent requests, forged UI approval, missing evidence, lost merchant response, lost chain response and recovery after confirmation evidence failure. `encoding.test.mjs` covers the independent published vector and field mutations. The original trust and contract tests also remain applicable.

From the hackathon root:

```sh
npm run test:gifting
npm run test:trust
cargo test --locked
cargo test --locked --example gifting_bridge
```

Private per-run artifacts are under `runs/<run-id>/`. Automated rehearsals use `validation-runs/<timestamp>/`, including `validation.json`. `VALIDATION.md` records the completed checks. Generated runs and local binaries are ignored by Git; share only reviewed fictional demo artifacts. A source checkout needs a local build, not a committed machine-specific executable.

## Build and operational limits

The local Mac copy includes generated `bin/gifting_bridge` and `bin/gift_campaign.so` for immediate rehearsal. The bridge is a host executable: rebuild it on Linux before a future VPS deployment. `GIFTING_BRIDGE_BIN` and `GIFTING_PROGRAM_SO` can point to explicit artifacts. The controller checks the SBF digest against the reviewed program before launching. `CHAIN-BRIDGE.md` documents the JSONL protocol and offline build cache used for this run.

From the hackathon root, `cargo build --locked --example gifting_bridge` builds the host bridge. Build the current SBF program using the existing Solana toolchain, or supply the reviewed SBF artifact; an older pre-mandate program is not interchangeable. `GIFTING_PORT` changes the loopback UI port. Playwright is resolved from the existing `agent/jev` installation; `GIFTING_BROWSER_CHANNEL` defaults to installed Chrome.

Chain state and ephemeral keys live only in the child process. Receipts and artifacts persist, but restarting the demo is **not** recovery of a durable chain. Do not restart an unresolved run and treat a fresh campaign as permission to repeat its order. No VPS deployment, real wallet authorization, live payment integration, account migration or production durability is claimed. The earlier account-layout migration requirement still applies before any existing on-chain deployment is upgraded.

The next product step is to rehearse this flow and replace the labelled fixture boundaries one at a time, starting with genuine recipient/product evidence and authenticated wallet authorization. Keep the measured goal: verified customer outcome, safe stops and cost per verified success including retries.
