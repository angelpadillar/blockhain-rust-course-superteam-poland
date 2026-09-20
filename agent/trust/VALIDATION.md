# Validation — 17 September 2026

## Approval and evidence code

`node --test trust-layer/evidence.test.mjs trust-layer/demo/demo.test.mjs` passed **24/24** tests (run in the experiment workspace). In the hackathon repository the equivalent command is `npm run test:trust`.

Coverage includes exact quote binding, expiry before/after approval, changed merchant/price, replay, wrong quote hash, concurrent execution requests, cross-origin rejection, durable local receipts, chain tampering, missing artifacts, strict stage coverage and observation mismatch. The local HTTP concurrency case returned one success and one rejected replay, with one execution record.

## Real browser pass on the local demo

The in-app browser exercised the displayed approval UI, using only local simulated data:

| Case | Observed outcome |
|---|---|
| Unchanged gift quote | Approved 29.90 PLN; one simulated confirmation |
| Repeat after confirmation | Rejected; still exactly one execution/confirmation |
| Price increased to 35.90 PLN | Rejected before execution |
| Merchant changed | Rejected before execution |
| Quote expired | Approval rejected; no execution |

Actual browser JPEG bytes and public DOM-derived observations were captured at every reached quote, approval and confirmation stage. The helper preserves the original JPEG bytes, hashes them and appends records referring to exact prior event hashes. Four independently verified bundles in `demo/evidence-captures/validation.json` have `integrityValid: true` and `boundaryComplete: true`. No confirmations were invented for rejected cases. The valid approval was local UI input, not a wallet signature.

## Browser benchmark and freeze

The Amazon cold preflight reached a blank page while the harness blocked AWS WAF verification traffic. Two setup receipts, including the initial insufficient rendering wait, were retained. No model cohort ran; no model-cost or speed winner was inferred. The final screenshot and observation hashes were recomputed successfully.

All 13 frozen v4 `.mjs` file hashes match `browser-adapter-freeze.json`. The shopping measurement safety policy and normalized upstream adapter passed 18 isolated tests; these do not establish Amazon completion.

## Contract

See `ONCHAIN-VALIDATION.md` for the fresh SBF binary, source fingerprints, commands and 18 LiteSVM integration tests. No network deployment or real payment was performed.
