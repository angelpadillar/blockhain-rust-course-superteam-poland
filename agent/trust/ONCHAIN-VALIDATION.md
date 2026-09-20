# Local mandate validation — 2026-09-17

The staged Rust program builds as a fresh SBF binary and passes **18 integration-suite tests and 1 program-ID unit test**. The integration suite retains 9 existing tests and adds 9 mandate groups (including one independent SHA-256 encoding vector). LiteSVM executes the newly built local program; no old repository binary, network transaction, deployment, merchant purchase, or live payment was used. The original repository was not modified by this implementation agent.

## Artifact and source identity

- Binary: `project/target/deploy/gift_campaign.so`, 425,568 bytes.
- Binary SHA-256: `5f04b46558cf0427dda612e53f6bec921bb67fc7e08b10f4a868e08113e12e00`.
- Source-set SHA-256: `9842691513694ffaf6ea805b1f4fab9652a1c54734a4c41d1005aa28f98dcc10`.
- The source set contains 29 files: every `.rs` under the program's `src/` and `tests/`, the program and workspace `Cargo.toml`, workspace `Cargo.lock`, and `rust-toolchain.toml`. Sort their workspace-relative POSIX paths; hash each file; concatenate `path + NUL + lowercase SHA-256 + newline`; hash that UTF-8 sequence. Build artifacts and this report are excluded.
- Final SBF build completed at 13:59:11 UTC. The complete test suite was rerun against this final binary and passed.

Tool versions: host `rustc 1.98.0 (88d9e12ae 2026-08-18)`, `cargo 1.98.0 (797e8a9bc 2026-08-05)`, `solana-cargo-build-sbf 3.1.10`, installed Solana platform tools v1.52 / `rustc 1.89.0-dev`, Anchor 1.1.2, LiteSVM 0.10.0. A direct `solana-sha256-hasher = "3.1.0"` dependency uses the already locked version; no custom cryptography was introduced.

## Reproduction commands

Run from `/Users/buena/Documents/ChatGPT/typesafe-ai-experiment`. Dependencies were downloaded into the staged cache with the first command; all final builds/tests run offline.

```sh
CARGO_HOME=/Users/buena/Documents/ChatGPT/typesafe-ai-experiment/trust-layer/cargo-cache cargo fetch --locked --manifest-path trust-layer/project/Cargo.toml

CARGO_TARGET_DIR=/Users/buena/Documents/ChatGPT/typesafe-ai-experiment/trust-layer/project/target CARGO_HOME=/Users/buena/Documents/ChatGPT/typesafe-ai-experiment/trust-layer/cargo-cache cargo check --offline --locked --manifest-path trust-layer/project/Cargo.toml

RUSTC=/Users/buena/.cache/solana/v1.52/platform-tools/rust/bin/rustc CARGO_TARGET_DIR=/Users/buena/Documents/ChatGPT/typesafe-ai-experiment/trust-layer/project/target/sbf-build CARGO_HOME=/Users/buena/Documents/ChatGPT/typesafe-ai-experiment/trust-layer/cargo-cache cargo build-sbf --manifest-path trust-layer/project/programs/gift_campaign/Cargo.toml --sbf-out-dir /Users/buena/Documents/ChatGPT/typesafe-ai-experiment/trust-layer/project/target/deploy --offline --skip-tools-install --no-rustup-override

CARGO_TARGET_DIR=/Users/buena/Documents/ChatGPT/typesafe-ai-experiment/trust-layer/project/target CARGO_HOME=/Users/buena/Documents/ChatGPT/typesafe-ai-experiment/trust-layer/cargo-cache cargo test --offline --locked --manifest-path trust-layer/project/Cargo.toml
```

The SBF postprocessor warns that standard Solana syscall imports, including `sol_sha256`, are unknown, and warns about both `cdylib` and `lib` crate types. The build exits successfully. The final binary loads in LiteSVM, and its mandate approval/attempt paths execute SHA-256 successfully. This is local runtime evidence, not certification for a deployed cluster.

## Enforced behavior

`authorize_mandate` requires the campaign sender's signature and creates the permanent `["mandate", campaign]` PDA only once, for a Funded/Researched/Quoted campaign without a prior attempt. It fixes a nonzero executor, merchant/specification/recipient commitments, charge currency/exponent, charge cap, escrow debit cap and expiry. The sender can revoke an Active mandate. There is no reset, replacement, reactivation or close instruction.

`approve_quote_with_mandate` requires the designated executor, active sender terms, matching merchant/specification/currency, both caps, and an exact domain-separated SHA-256 commitment. That commitment includes program/campaign/mandate/mint, sender/executor, immutable mandate terms and recipient, every stored quote field, protocol fee and campaign expiry. `record_payment_attempt_with_mandate` checks them again, requires `now < expiry` for mandate/quote/campaign, and atomically changes Active to Consumed with PaymentAttempted. Failed checks leave authorization unconsumed. A consumed authorization cannot be revoked or exercised again.

Legacy approval and payment-attempt instructions reject mandate-bound campaigns. Modern quoted campaigns cannot invoke legacy `confirm_delivery`. Already Purchased campaigns can settle after expiry so completed purchases do not strand escrow. Existing unbound lifecycle tests continue to pass.

Tests cover owner/executor authorization, zero commitments, malformed currency/exponent, invalid caps/expiry, campaign substitution, all quote-field commitment changes, recipient changes, fee changes and overflow, exact expiry, revocation before/after approval, fresh-transaction replay rejection, legacy bypass attempts, late Purchased settlement and refund balances. The canonical 602-byte test vector was independently encoded using Python `struct.pack` and `hashlib.sha256`; expected digest is `e6367d2fc9f36ad885022a42e1456af7d67e705e435b9e0fa4ada4c8b1395f89`.

## Boundaries before integration or deployment

**Account migration is mandatory.** `Campaign.mandate` changes the existing account layout under the existing discriminator and PDA. This patch is only for fresh local accounts. Existing deployed accounts must have an explicit migration/reallocation or a versioned program/account design before deployment. Client IDL/types must also be regenerated for the new interface.

This is one-use **sender preauthorization**: an executor may approve an exact quote within the sender-signed bounds. It is not a new sender signature for every quote. The browser/demo's canonical JSON hash is a different protocol until deliberately ported to the Rust encoding; this patch does not assert demo-to-chain compatibility.

The chain treats merchant, specification and recipient hashes as opaque commitments. The exact specification must describe quantity and variant, and the off-chain verifier must establish that the website/cart/recipient matches it. The ledger cannot inspect a website or prevent an executor from issuing unauthorized external requests.

Card-charge and escrow-debit caps are checked independently, including protocol fee in the latter. The existing FX field is oracle-supplied informational metadata; arithmetic consistency between it and the two amounts is not enforced. Research and fulfillment oracle keys remain trusted for quote and purchase/delivery attestations. One-use/replay protection is per mandate/campaign; there is no global registry deduplicating oracle-supplied payment/order receipt hashes across campaigns. Existing oracle cancellation after expiry remains available for unresolved attempted/authenticated payments, so safe reconciliation is an oracle responsibility.

No deployment, RPC integration, real token movement, production key management, or adversarial audit of the entire inherited program is claimed.
