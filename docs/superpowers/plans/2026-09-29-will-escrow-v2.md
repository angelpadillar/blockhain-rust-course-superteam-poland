# will_escrow v2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace `gift_campaign` with a Pinocchio escrow (`will_escrow`) where
customer funds pay each purchase at the moment it happens, the fee is paid only
after proof and a dispute window, and every job closes with its rent returned.
Then wire the real Altitude-card flow and the judge-facing pieces.

**Architecture:** One Pinocchio program: a config PDA, plus per job a job PDA
and a vault token account. The helpers are carried over from the verified v1
port (entrypoint loop, `NonZeroU64` errors, init with the pre-funded path,
single CPI path, rent read from the sysvar). Codama generates the IDL and a
`@solana/kit` TypeScript client that the agent, scripts, MCP server and `/jobs`
indexer share.

**Tech Stack:** Rust with Pinocchio 0.11.2 on platform-tools v1.52; LiteSVM
0.17; Mollusk 0.15 (compute-unit measurement); proptest 1.11; Codama 0.13
(Rust macros) with `@codama/renderers-js` 2.5 and `@solana/kit` 8.4;
`@sqds/multisig` 2.1; `@modelcontextprotocol/sdk` 1.31; Node 24.

**Spec:** `docs/superpowers/specs/2026-09-29-will-escrow-v2-design.md`

## Global Constraints

- Don't touch mainnet or spend real money without the user's explicit OK for **each** step.
- Secrets live only in env vars. The RentAHuman key is never written to a file or a log.
- Commit in small steps with clear messages, on branch `will/escrow-v2`.
- New crate `programs/will_escrow`, in Pinocchio. `job_kind` and `adapter` are u8 codes; the program accepts 0–15.
- `/jobs` shows real jobs only, no seeded data.
- appliedwill-site follows its own redesign constraints (Lever/Monument tokens). Nothing there is pushed or deployed without the user's OK.
- The v1 program (`gift_campaign` and its Pinocchio port) is left untouched. Its tests keep passing.

## Review Focus

1. **Card charge differs from the quote** (FX drift, a tip change). Expect a
   top-up release up to `release_cap`, and a rejected `record_purchase` if
   `charged > released`.
   Task 7 tests: `charge_above_release_needs_top_up` and
   `record_rejects_charge_over_released`.
2. **Altitude credit is late, or checkout fails after release.** The operator
   must be able to return the released funds and refund everything, from
   RELEASED.
   Task 10 test: `operator_cancel_from_released_with_return_refunds_all`.
3. **The customer's token account is not their ATA, or was closed.** Refunds go
   to any USDC account the customer owns; any other owner is rejected.
   Task 9 test: `settle_refund_to_any_customer_owned_usdc_account`.
4. **Timestamps exactly on a boundary.** A dispute is allowed while
   `now < proof_at + window`; a permissionless settle is allowed when
   `now ≥ proof_at + window`.
   Task 9 tests: `dispute_at_window_end_rejected` and `settle_at_window_end_allowed`.
5. **A job id reused after close.** Re-creating it yields a fresh job with no
   leftover state.
   Task 9 test: `recreate_after_close_is_fresh`.

---

## Phases and gates

| Phase | Deliverable | Gate before starting |
|---|---|---|
| 1. Program | `will_escrow` + tests + SECURITY.md + IDL/TS client + devnet deploy + COSTS.md draft | your OK on this plan |
| 2. Devnet flow | end-to-end on devnet (Glovo quote → phone approval → release → checkout stopped before payment → settle) + RentAHuman dry run | Phase 1 review |
| 3. Mainnet | Squads multisig → deploy → initialize → authority transfer → $1 Altitude deposit test → one real job | **your OK for each numbered step** |
| 4. Judges | `will.buy` MCP server, `/jobs` page, Loom demo script | Phase 3 job settled |

Phases 2–4 each get their own step-level plan written when they start (they
depend on Phase 1 interfaces and your answers below). Phase 1 is detailed here.

---

### Task 1: Branch, baseline commits, crate skeleton, Codama spike

**Files:**
- Create: `programs/will_escrow/{Cargo.toml,src/lib.rs,src/error.rs}`
- Modify: `Anchor.toml` (add `programs/will_escrow` to `[workspace] exclude`)
- Modify: `Cargo.toml` (`[profile.release.package.will_escrow] opt-level = "s"`)

- [ ] **Branch and baseline:** create branch `will/escrow-v2`. Commit the existing
  uncommitted v1 port as three commits:
  - `feat: Pinocchio port of gift_campaign`
  - `test: Anchor/Pinocchio parity suite`
  - `docs: will_escrow v2 design and plan`
- [ ] **Skeleton:** copy the proven helpers from `programs/gift_campaign_pinocchio`:
  - `lib.rs`: the entrypoint loop and split dispatch tables (discriminators kept
    out of pointer tables);
  - `error.rs`: the `Error` type;
  - `util.rs`: `init_pda`, `invoke`, `minimum_balance`, the checks, `mul`.
  - Use 1-byte instruction discriminators 0–12.
- [ ] **Codama spike:** behind cargo feature `idl`, derive Codama on one
  instruction and run `codama-cli` to emit `idl.json`.
  - **Pass criteria:** IDL emitted, and `cargo build-sbf` without the feature
    produces a byte-identical `.so` compared with no derives.
  - **If Codama can't express Pinocchio 0.11 types**, fall back to Shank:
    `shank-cli 0.4.9` extracts the IDL, and Codama imports it through
    `@codama/nodes-from-anchor`.
- [ ] **Commit:** `feat(will_escrow): crate skeleton and IDL spike`

### Task 2: State layouts, errors, loaders

**Files:** `src/state.rs`, `src/error.rs`, host unit tests in `src/state.rs`

**Produces:**
- `Config` (275 B) and `Job` (324 B): zero-copy, alignment 1, with
  compile-time asserts on size and offsets.
- `status::{FUNDED=0, QUOTED=1, APPROVED=2, RELEASED=3, PURCHASED=4, PROVEN=5, DISPUTED=6}`.
- `WillError` codes from 6000, one per failure class. Examples: `Paused`,
  `BadState`, `NotOperator`, `NotCustomer`, `NotAdmin`, `NotUpgradeAuthority`,
  `CapExceeded`, `FundingNotAllowed`, `WindowOpen`, `WindowClosed`, `NotExpired`,
  `TermsMismatch`, `QuoteExpired`, `KindOutOfRange`, `BadAmount`, `Overflow`.
- `Config::load(&AccountView) -> Result<&Config>` and
  `Job::load_mut(&AccountView, &Address /*customer*/) -> Result<&mut Job>`.
  Both check owner, tag, size and PDA with the stored bump.

**Tests (host):**
- `layout_sizes_and_offsets`
- `load_rejects_wrong_owner`
- `load_rejects_wrong_tag`
- `load_rejects_short_data`
- `load_rejects_wrong_pda`

- [ ] Write the tests, then the layouts and loaders; run `cargo test -p will_escrow`.
- [ ] **Commit:** `feat(will_escrow): account layouts, errors and loaders`

### Task 3: initialize_config and update_config

**Files:**
- Create: `src/instructions/{initialize_config.rs,update_config.rs}`
- Test: `programs/will_escrow/tests/config.rs`, with the LiteSVM harness in
  `tests/common/mod.rs`

**Upgrade-authority check.** The ProgramData account address must equal
`find_program_address([program_id], BPFLoaderUpgradeab1e…)`. It must be owned by
the upgradeable loader, and have `data[0..4] == [3,0,0,0]`, `data[12] == 1`, and
`data[13..45] == signer`.

The LiteSVM harness deploys `will_escrow.so` as an upgradeable program, writing
the program and ProgramData accounts with `set_account` using the loader-v3
layout, so this check runs for real.

**Tests:**
- `init_by_upgrade_authority`
- `init_rejects_other_signer`
- `init_rejects_fake_programdata`
- `init_twice_rejected`
- `init_rejects_fee_over_max`
- `init_rejects_funding_account_wrong_mint`
- `update_config_admin_only`
- `pause_blocks_create_and_release_only`

- [ ] Tests first, then implement, then run.
- [ ] **Commit:** `feat(will_escrow): upgrade-authority-gated config`

### Task 4: create_job, cancel (customer, pre-approval), refund_expired (FUNDED/QUOTED)

**Accounts for `create_job`:** config, job (init), vault (init), customer
(signer), customer_token (writable), rent_payer (signer, writable), mint,
token program, system program.

**Arguments:** `job_id`, `budget`, `job_kind`, `adapter`, `mandate_cap`,
`mandate_expires_at`.

**Checks:**
- not paused;
- `budget > 0`;
- kinds < 16;
- the vault receives exactly `budget + fee_reserve`;
- `expires_at = now + job_timeout`;
- the mandate's expiry is no later than `expires_at`.

**Tests:**
- `create_job_funds_vault_exactly`
- `create_job_rejects_kind_16`
- `create_job_rejects_wrong_mint`
- `create_job_prefunded_pda_ok`
- `customer_cancel_before_approval_full_refund_and_close`
- `customer_cancel_after_approval_rejected`
- `refund_expired_by_stranger_after_timeout`
- `refund_expired_before_timeout_rejected`

- [ ] Tests, implement, run.
- [ ] **Commit:** `feat(will_escrow): create, cancel, timeout refund`

### Task 5: submit_quote, approve_quote, mandate

**`submit_quote`:**
- operator only; from FUNDED or QUOTED (re-quote allowed);
- the line items must sum to the total, and the total must not exceed `ceiling`;
- `release_cap ≤ budget`;
- `quote_expires_at > now`;
- the mandate auto-approves when `release_cap ≤ mandate_cap` and
  `now < mandate_expires_at`.

**`terms_hash`** is SHA-256 of:
- `"will-escrow:terms:v1"`, the program id and the job key;
- `quote_currency`, `quote_exponent`;
- the five line items, `ceiling`, `release_cap`, `quote_hash`;
- `quote_expires_at`, `fee_bps`.

**Tests:**
- `quote_sum_mismatch_rejected`
- `quote_over_ceiling_rejected`
- `release_cap_over_budget_rejected`
- `requote_before_approval_ok`
- `approve_requires_customer`
- `approve_rejects_wrong_terms_hash`
- `approve_rejects_expired_quote`
- `mandate_auto_approves_within_cap`
- `mandate_ignored_over_cap_or_expired`
- `terms_hash_matches_independent_vector`: the vector is computed in the test
  with the `sha2` crate, not the program's code.

- [ ] Tests, implement, run.
- [ ] **Commit:** `feat(will_escrow): quotes, customer approval, mandate`

### Task 6: release_for_purchase

**Accounts:** config, job, vault, funding token account (writable), operator
(signer), token program.

**Checks:**
- not paused; state APPROVED or RELEASED;
- the funding account is in `config.funding[..count]` and uses the USDC mint;
- `released + amount ≤ release_cap`;
- for the first release, `now ≤ quote_expires_at`.

**Tests:**
- `release_to_allowlisted_altitude`
- `release_to_other_account_rejected`
- `release_over_cap_rejected`
- `release_keeps_fee_reserve_locked`
- `second_release_tops_up_to_cap`
- `release_before_approval_rejected`
- `release_when_paused_rejected`

- [ ] Tests, implement, run.
- [ ] **Commit:** `feat(will_escrow): release_for_purchase to allowlisted funding`

### Task 7: record_purchase (with excess return)

**Arguments:** `order_ref_hash`, `charged`, `charged_quote_amount`.

**Behavior:**
- operator only; state RELEASED;
- `charged ≤ released`;
- `charged_quote_amount ≤ ceiling`;
- in the same instruction, transfers `released − charged` from the operator's
  token account into the vault;
- moves to PURCHASED.

**Tests:**
- `record_returns_excess_to_vault`
- `record_rejects_charge_over_released`
- `charge_above_release_needs_top_up`
- `record_rejects_zero_order_ref`

- [ ] Tests, implement, run.
- [ ] **Commit:** `feat(will_escrow): record_purchase with excess return`

### Task 8: submit_proof and dispute

**Tests:**
- `proof_starts_window`
- `proof_before_purchase_rejected`
- `dispute_within_window`
- `dispute_at_window_end_rejected`
- `dispute_by_non_customer_rejected`

- [ ] Tests, implement, run.
- [ ] **Commit:** `feat(will_escrow): proof and dispute window`

### Task 9: settle, resolve_dispute, account closing

**`settle`:**
- the fee goes to the treasury USDC account;
- the remainder goes to a customer-owned USDC account;
- `CloseAccount` CPI on the vault sends its rent to `rent_payer`;
- the job's lamports go to `rent_payer`, then Pinocchio `close`.

**`resolve_dispute(fee_to_operator ≤ fee)`:** admin only. It splits the vault
the same way and closes the accounts.

**Tests:**
- `settle_early_by_customer`
- `settle_by_stranger_after_window`
- `settle_by_stranger_during_window_rejected`
- `settle_at_window_end_allowed`
- `settle_refund_to_any_customer_owned_usdc_account`
- `settle_refund_to_foreign_account_rejected`
- `rent_returns_to_rent_payer`
- `closed_job_cannot_be_revived_in_same_tx`
- `recreate_after_close_is_fresh`
- `resolve_dispute_admin_only`
- `resolve_dispute_split_bounds`

- [ ] Tests, implement, run.
- [ ] **Commit:** `feat(will_escrow): settle, dispute resolution, closing`

### Task 10: Operator cancel (refund_after_booking) and complete timeout coverage

**Tests:**
- `operator_cancel_from_each_state` (FUNDED … PROVEN)
- `operator_cancel_from_released_with_return_refunds_all`
- `operator_cancel_in_dispute_rejected`
- `no_stuck_funds_every_state_has_stranger_exit`: for each state, advance the
  clock and confirm a random key can close the job, with the customer ending up
  with vault balance − (fee only when PROVEN).

- [ ] Tests, implement, run.
- [ ] **Commit:** `feat(will_escrow): refund after booking and timeout exits`

### Task 11: State-machine matrix and model-based fuzz

**Files:** `tests/matrix.rs`, `tests/model.rs` (a pure-Rust reference model),
`tests/fuzz.rs`

- **Matrix:** drive a job into each of the 7 states, then try all 13
  instructions with valid-looking arguments. Only the transitions in the spec
  table may succeed.
- **Fuzz:** proptest generates random sequences of instructions, signers
  (customer, operator, admin, stranger), amounts (0, 1, cap ± 1, `u64::MAX`)
  and clock jumps. After every step, the program's outcome, token balances
  and closed/open state must equal the model's.
  - `PROPTEST_CASES` defaults to 256; the release gate runs 5 000.

- [ ] Write the model, matrix and fuzz; run with `PROPTEST_CASES=5000`.
- [ ] **Commit:** `test(will_escrow): transition matrix and model fuzz`

### Task 12: SECURITY.md

**File:** `programs/will_escrow/SECURITY.md`. Contents:
- the trust model;
- every check from the spec's "Checks" list, each with its test names;
- `tests/security_map.rs`, which parses SECURITY.md and fails if a referenced
  test does not exist.

- [ ] **Commit:** `docs(will_escrow): SECURITY.md mapped to tests`

### Task 13: IDL and TypeScript client

**Files:**
- `programs/will_escrow/idl/will_escrow.json`
- `clients/will-escrow-ts/` (generated)
- `scripts/codegen.mjs`

**Test:** Rust tests write instruction-data vectors to
`tests/vectors/*.json`. A `node --test` suite encodes the same inputs with the
TS client and asserts byte equality, and decodes a Job account fixture.

- [ ] **Commit:** `feat: Codama IDL and TypeScript client`

### Task 14: Sizes, compute units, deploy tooling, devnet deploy, COSTS.md draft

**Files:**
- `scripts/deploy.sh`:
  - `--max-len` set to the binary size + 5%;
  - `--with-compute-unit-price`;
  - after the deploy, `solana program show --buffers` then
    `solana program close --buffers`.
- `COSTS.md`:
  - measured binary size against the Anchor build (425,568 B);
  - per-instruction compute units (Mollusk bencher), against the Anchor
    numbers already measured;
  - the rent-exempt SOL for the deploy and for its buffer;
  - 100-job fees plus peak rent float;
  - a SIMD-0437 sensitivity table.

**Devnet:** deploy and initialize, with the admin a devnet keypair for now.
Record the program ID. This is free, with no real money.

- [ ] **Commit:** `chore: deploy tooling, COSTS.md, devnet deployment`

---

## Phase 2–4 outline (each gets its own step-level plan)

**Phase 2: Devnet flow.**
- Orchestrator `agent/src/will/` built on the TS client.
- Solana Pay transaction-request endpoint for phone approval: the operator
  pre-signs `create_job + submit_quote + approve_quote`.
- Glovo quote from the existing adapter, then checkout run up to the payment
  step and stopped, since devnet USDC can't fund Altitude.
- Proof hash from a delivery artifact; settle.
- RentAHuman dry run of the sign-holding bounty (`create_bounty`,
  `dryRun: true`), with the key read from an env var.

**Phase 3: Mainnet.** Each numbered step needs your OK first:
1. create the Squads v4 multisig;
2. deploy with the hot deployer key;
3. `initialize_config`, signed by the upgrade authority, with the admin set to
   the Squads vault;
4. transfer the upgrade authority to the Squads vault, then verify;
5. $1 USDC `release_for_purchase` to Altitude, then confirm the credit and its
   latency;
6. one real job: "lunch under 60 zł in Warsaw" end to end.

**Phase 4: Judges.**
- `mcp/will`: stdio MCP server exposing `will.buy({ item, max_price, deliver_to })`,
  which returns a phone-approval link and a job id, and `will.status(job)`.
- `/jobs` in appliedwill-site: static page plus `tools/jobs-index.mjs`, which
  builds `jobs.json` from mainnet history. It uses the Lever/Monument tokens
  and ships after the redesign merges.
- Loom script under 3 minutes.
