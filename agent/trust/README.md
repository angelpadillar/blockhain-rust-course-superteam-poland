# Gifting approval and mandate prototype

**19 September update:** [The integrated gifting demo](integrated/README.md) connects browser quote, confirmed local Solana mandate, one-use execution and verified simulated fulfillment. Run `npm run demo:gifting` from the project root. It uses LiteSVM and ephemeral demo keys; no production wallet or real payment is connected.

Run from the repository root:

```sh
npm run demo:trust
# Open http://127.0.0.1:4317
npm run test:trust
```

The local demonstration shows exact-quote approval, rejection after a price or merchant change, expiry, and one-use execution. It creates simulated receipts. It does not sign a wallet transaction, charge a card or deploy a program.

The Anchor implementation lives in `../../programs/gift_campaign`. A sender creates an immutable one-use mandate bound to a campaign, delegated executor, merchant/specification/recipient commitments, card currency, card charge cap, escrow debit cap and expiry. Both approval and the recorded payment attempt check the bound quote; the attempt atomically consumes the mandate. Legacy approval and attempt instructions reject mandate-bound campaigns.

The old delivery shortcut now rejects modern quoted campaigns. A recorded purchase can settle after campaign expiry, so a late fulfillment receipt does not strand the escrow merely because the deadline for new spending has passed.

## Evidence

`evidence.mjs` checks an append-only hash chain and exact quote/approval/execution/confirmation correlations. Strict verification requires actual screenshot bytes and a canonical observation for every reached quote, approval and confirmation stage. `demo/attach-evidence.mjs` appends capture references without rewriting the approved quote.

`demo/evidence-captures/validation.json` records four browser-tested bundles: successful simulated confirmation plus rejected replay, changed price, changed merchant and expired quote. The successful bundle's final status is `rejected` because its final event is the intentionally rejected second attempt; it contains exactly one simulated confirmation. SHA-256 integrity is not proof that a merchant told the truth or that an authenticated wallet approved it. The local chain heads have not been anchored on-chain.

## Validation and limits

See `VALIDATION.md` and `ONCHAIN-VALIDATION.md` for commands and results. The Amazon measurement is saved separately at `../jev/benchmarks/shopping-head-to-head-v5/REPORT.md`. It produced no model ranking: the cold browser failed at AWS WAF verification requests blocked by the harness, before any model call.

**Fresh local accounts only.** Campaign account layout changed. This is not compatible with existing campaign accounts without an explicit migration/reallocation strategy. No chain deployment was performed. The existing card executor and CLI have not been switched to the new mandate instructions; the visible demo and Anchor tests are separate integration layers.

The contract enforces independent card and escrow limits. The stored conversion rate is oracle-supplied metadata, not a verified exchange rate or enforced arithmetic conversion. Merchant/order attestations still depend on the configured fulfillment oracle; one-use authorization is per campaign, not a global order-ID registry. An ambiguous external payment result requires reconciliation and must not trigger an automatic second purchase.
