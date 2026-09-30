# gift_campaign — Pinocchio port

A hand-written [Pinocchio](https://github.com/anza-xyz/pinocchio) implementation
of `programs/gift_campaign`, built to minimise binary size and therefore deploy
rent. It is a drop-in replacement for the Anchor binary: same program id,
instruction and account discriminators, packed Borsh account layouts, argument
encoding, `Program data:` event payloads, and custom error codes (6000+). The
existing IDL, TypeScript types and Rust clients work unchanged.

| Build                             | `.so` size | Program rent (mainnet, 5,080 lamports/byte) |
| --------------------------------- | ---------: | ------------------------------------------: |
| Anchor 1.1.2 (`gift_campaign`)    |  425,568 B |                                  2.1628 SOL |
| Pinocchio 0.11.2 (this crate)     |   43,032 B |                                  0.2195 SOL |

Compute use is 2–10× lower per instruction (for example `settle_fulfillment`
36,853 → 19,368 CU, `submit_quote` 8,239 → 1,379 CU).

## Build and test

```bash
anchor build                       # reference Anchor binary (target/deploy/gift_campaign.so)
cargo build-sbf --manifest-path programs/gift_campaign_pinocchio/Cargo.toml
cargo test --workspace             # includes the differential parity suite

# The original LiteSVM suite against the port:
GIFT_CAMPAIGN_SO=$PWD/target/deploy/gift_campaign_pinocchio.so \
  cargo test -p gift_campaign --test gift_campaign

# Longer differential fuzzing (default 24 seeds x 250 steps):
PARITY_SEEDS=300 cargo test -p gift_campaign --test parity
```

`programs/gift_campaign/tests/parity.rs` runs both binaries in lockstep and
asserts identical success/failure, custom error codes, account bytes, lamports
and events after every transaction: scripted happy paths for all 16
instructions, seeded random instruction sequences, pre-funded PDAs, duplicate
and surplus accounts, and forged, truncated or type-confused accounts.
`Anchor.toml` excludes this crate so `anchor build` / `anchor deploy` never
treat it as a second program.

## What differs from the Anchor binary

- No log strings: no `Instruction: …` line, and failures surface as
  `custom program error: 0x…` rather than Anchor's named `AnchorError` log.
  Match on the numeric code. Framework-level failures (bad owner, seeds,
  signer, …) return built-in `ProgramError`s instead of Anchor's 2xxx/3xxx
  codes.
- Rent is read from the rent sysvar and supports both the SIMD-0194 model
  (threshold 1.0, live on devnet and mainnet) and the legacy 2-year threshold
  (litesvm, older validators). Any other threshold fails closed.

## Implementation notes

- Account structs in `src/state.rs` are alignment-1 byte-array views of the
  Anchor layouts. Contiguous field groups mirror the instruction argument order
  and the mandate terms preimage, so `submit_quote` is five struct copies and
  `quote_terms_hash` is one `sol_sha256` over 14 slices of account data (the
  Anchor version builds a heap `Vec`).
- Loaders skip runtime borrow tracking; see the aliasing invariant in
  `src/state.rs`.
- Handlers mirror Anchor's check order (account types, then `init`s, then
  per-field constraints, then the handler's `require!`s), so multi-fault inputs
  report the same custom error.
- `Result<(), Error>` wraps the final `u64` error encoding, so each `?` is one
  register test, and the entrypoint returns it directly.
- platform-tools v1.52 zeroes the upper 32 bits of plain 64-bit words that share
  a static with relocated function pointers. The dispatch discriminators
  therefore live in their own table (`src/lib.rs`). Keep 64-bit constants out
  of statics that contain pointers.

## Deploying

Deploy this binary under the existing program id, for example
`solana program deploy --program-id target/deploy/gift_campaign-keypair.json
target/deploy/gift_campaign_pinocchio.so`, or upgrade an existing deployment
with its upgrade authority. `cargo build-sbf` also writes an unused
`gift_campaign_pinocchio-keypair.json`; do not deploy to that address.

Upgrading an existing deployment reuses its program-data account, which never
shrinks. The rent saving applies to fresh deployments (for example mainnet);
the devnet deployment keeps its 348,837-byte allocation unless the program is
closed, which permanently retires its id.
