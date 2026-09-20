# Local Solana transaction bridge

`project/programs/gift_campaign/examples/gifting_bridge.rs` runs the existing compiled `gift_campaign` SBF program inside LiteSVM. It creates ephemeral demo signers and submits actual signed local Solana transactions. There is no RPC, wallet connection, real merchant call, real payment, public deployment, or explorer link. Closing the child process discards its chain state and keys. The Node parent should durably retain responses as evidence.

One child process owns one fresh campaign. Start the executable without arguments. It reads one JSON object per stdin line and writes exactly one JSON response per stdout line. It flushes each response. Lines over 16 KiB and malformed/unknown fields are rejected; the process remains usable for `state`. Public keys in responses are public information; private signer bytes are never returned.

```sh
CARGO_HOME=/Users/buena/Documents/ChatGPT/typesafe-ai-experiment/trust-layer/cargo-cache cargo build --offline --locked --manifest-path trust-layer/project/Cargo.toml --example gifting_bridge
```

Executable: `trust-layer/project/target/debug/examples/gifting_bridge`. The Node host may locate it using its own `GIFTING_BRIDGE_BIN` configuration. The bridge accepts `GIFTING_PROGRAM_SO` to select a local SBF file; by default it uses `trust-layer/project/target/deploy/gift_campaign.so`, resolved at build time. Every response reports the loaded file's SHA-256. Initial verified SBF: `5f04b46558cf0427dda612e53f6bec921bb67fc7e08b10f4a868e08113e12e00`.

## Commands

Hashes must be 64 hexadecimal characters. Expiry is Unix **seconds**, checked against the machine's current clock before every signed transaction. The narrow fixture accepts PLN with exponent 2 and a positive integer total up to 10,000,000 minor units. The campaign budget and mandate caps are exact. With 12,900 PLN minor units, settlement is 129,000,000 units of an ephemeral 6-decimal demo token, protocol fee zero. This fixed fixture mapping is not an FX quote or a real asset conversion.

```json
{"op":"prepare","quote":{"merchantHash":"<64 hex>","specHash":"<64 hex>","recipientHash":"<64 hex>","quoteHash":"<64 hex>","currency":"PLN","currencyExponent":2,"totalMinor":12900,"expiresAt":1800000000}}
{"op":"authorize","termsHash":"<64 hex>"}
{"op":"attempt","termsHash":"<64 hex>","attemptHash":"<64 hex>"}
{"op":"confirm","orderHash":"<64 hex>","receiptHash":"<64 hex>"}
{"op":"state"}
```

Use a fresh future expiry rather than the illustrative timestamp above.

- `prepare`: funds fixture signers, creates the mint and sender token account, initializes program config, funds a campaign, and submits its quote. The decoded campaign is `Quoted`; no mandate exists. Repeating preparation requires a new process, including after partial setup failure.
- `authorize`: one atomic transaction contains sender-signed `AuthorizeMandate` and executor-signed `ApproveQuoteWithMandate`. Both use the exact prepared terms. A wrong digest is rejected by the SBF and rolls back mandate creation. Success is `Approved` / `Active`.
- `attempt`: executor-signed `RecordPaymentAttemptWithMandate` atomically records `PaymentAttempted` and consumes the mandate. Every invocation refreshes the blockhash, so repeated identical inputs exercise program rejection rather than transaction deduplication. No merchant action occurs here.
- `confirm`: the **trusted local fixture oracle** signs one atomic transaction containing `RecordPaymentAuth` and `RecordPurchase`, using the exact stored currency and charge. The parent must call this only after verifying its simulated merchant result against the approved quote. The bridge does not independently attest merchant facts. `receiptHash` becomes `purchase_hash`; `orderHash` becomes `order_id_hash`. The payment-auth hash is SHA-256 of `local-fixture-payment-auth:v1` plus raw receipt and order hashes. Invalid receipt/order input rolls back both instructions. Success is `Purchased`; this command does not settle escrow or prove delivery.
- `state`: decodes the actual campaign/config/mandate accounts and token balances without sending a transaction. The reported clock is the last executed transaction's clock, not a fresh wall-clock assertion.

## Response and independent digest check

Every response contains `accepted`, `error` (null or `{code,detail}`), `backend: "LiteSVM local Solana"`, `transactions`, `state`, `canonical`, `publicKeys`, `binarySha256`, and explicit fixture/no-real-funds labels. Each transaction contains its real `signature`, `accepted`, `error`, `logs`, `computeUnits`, and operation label. Failed transactions retain their logs and decoded post-failure state. State keys are camelCase; enum statuses preserve Rust names such as `Quoted`, `Approved`, `PaymentAttempted`, `Purchased`, `Active`, and `Consumed`. All 64-bit values in state and canonical inputs are decimal strings.

`canonical` contains `domain`, `mandateSource`, `inputs`, `bytesHex`, and `termsHash`. Before approval, `mandateSource` is `planned`: a prospective mandate derived from the quote and intended ephemeral signers. After authorization it is `account`: the decoded SBF account. The digest is computed by the contract's Rust `quote_terms_hash`; the bridge also reconstructs the wire bytes and checks their hash agrees. `inputs` uses raw public keys and hashes as lowercase 64-character hex, unlike display `publicKeys`, which uses base58.

`inputs` has `{programId,campaignKey,mandateKey,config,mandate,campaign}`. Its nested fields match `encoding.mjs` and the exact order in `project/programs/gift_campaign/src/mandate.rs`. The encoding is a UTF-8 domain prefix, raw 32-byte keys/hashes, raw three-byte currency codes, and little-endian integers; there are no JSON bytes or field names in the digest. The current encoding has 602 bytes. The independent JavaScript encoder should recompute **both bytes and digest** before enabling approval, then bind the digest to the displayed merchant/item/recipient/quantity/total commitments. Opaque commitments alone do not prove the contents of a merchant cart.

## Verification

The actual JSONL executable smoke passed `Quoted → Approved → PaymentAttempted → Purchased`, wrong-hash atomic rollback, replay rejection with a fresh signature, malformed-command recovery, exact charged amount, and unchanged canonical digest after execution. It produced no stderr output. A separate protocol check rejected an oversized line and unknown fields, then successfully answered `state`. All three example tests passed, exercising real SBF authorization, replay, atomic invalid confirmation, expiry rejection, and strict input parsing. The independent JavaScript encoder also matched all 602 canonical bytes and the digest from an actual bridge preparation response.

```sh
CARGO_HOME=/Users/buena/Documents/ChatGPT/typesafe-ai-experiment/trust-layer/cargo-cache cargo test --offline --locked --manifest-path trust-layer/project/Cargo.toml --example gifting_bridge
```

These are local program-execution checks. They do not establish production wallet authentication, trusted merchant evidence, chain deployment, settlement, or real payment correctness. The original contract source and frozen browser/payment adapters are unchanged by this bridge.
