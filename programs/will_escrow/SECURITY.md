# will_escrow security

`will_escrow` is written in Pinocchio, which does none of Anchor's automatic
account validation. Every check below is done by hand, and every one is
mapped to the tests that prove it. `tests/security_map.rs` fails if a check
lists no tests or names a test that does not exist.

## Trust model

**Parties**

- **Customer.** Funds a job and approves the exact quote terms, or pre-approves
  within a mandate. Can dispute, and can sign off early. Needs only USDC; the
  operator can pay fees and rent.
- **Operator.** The agent's key. Quotes, releases funds for the purchase,
  records it, and submits proof. Can cancel with a full refund at any stage
  except a dispute.
- **Admin.** Resolves disputes and rotates configuration. On mainnet: a Squads
  2-of-3 multisig with one key on a hardware wallet.
- **Upgrade authority.** Initializes the config once, and can replace the
  program. On mainnet: the same Squads multisig.

**What the program enforces**

- USDC leaves the vault only three ways:
  - to a config-allowlisted funding account (the Altitude card deposit), up to
    the release cap the customer approved;
  - as a fee to the treasury;
  - back to a USDC account the customer owns.
- The fee is paid only after proof of delivery and either an unchallenged
  dispute window or the customer's early sign-off. It is `charged × fee_bps /
  10 000`, at the rate fixed when the job was created.
- The early sign-off must land in a later slot than the proof. It therefore
  cannot ride in the same operator-built transaction the customer signs.
- Every unfinished state has a permissionless exit. Timeouts pay the customer,
  the treasury (only an earned fee) and the rent payer, never the caller. The
  rent payer is credited directly, never through a CPI, so no recipient can
  make an exit fail.
- An operator cancel restores the customer's whole deposit.
- Config changes never alter an open job's fee rate or its running deadlines.
  The job timeout and fee rate are fixed at creation, the window end at the
  proof, and the dispute deadline when a dispute opens. The operator key,
  funding allowlist, treasury, and the lengths of windows not yet started come
  from the live config.

**What it cannot enforce**

- That the operator spends released funds on the approved order, reports the
  charge honestly, or submits a truthful proof. Hashes commit to the
  evidence; they do not verify it.
- A malicious operator can cost a customer at most the released amount, which
  is capped by the customer's approval. It can never take the fee without a
  proof and either an unchallenged window or a customer sign-off in a later
  transaction.
- What the customer signs. A customer who signs an operator-built transaction
  that contains `settle` has signed off. Wallets list the instructions, but
  few people read them.

## Checks

| Check | How | Tests |
| --- | --- | --- |
| Config initialized only by the upgrade authority, only once | The ProgramData account must be *this* program's (address pinned to the program id): owned by the upgradeable loader, variant 3, with an authority that signed. The config PDA can be created once. | `init_by_upgrade_authority`, `init_rejects_other_signer`, `init_rejects_fake_programdata`, `init_twice_rejected`, `program_data_constant_matches_derivation` |
| Config values validated | Fee ≤ 10%, non-zero timeouts and keys, 1–4 funding token accounts of the config mint; `update_config` shares the validation and is admin-only; the mint never changes. There is no upper bound on the timeouts yet (see residual risks). | `init_rejects_fee_over_max`, `init_rejects_zero_timeouts`, `init_rejects_funding_account_wrong_mint`, `init_requires_one_to_four_funding_accounts`, `update_config_admin_only`, `update_config_validates_like_initialize` |
| Owner checks | Config and job owned by the program; mints and token accounts by SPL Token; ProgramData by the loader | `load_rejects_wrong_owner`, `create_job_rejects_wrong_mint`, `init_rejects_fake_programdata`, `allowlisted_funding_recreated_with_other_mint_rejected` |
| Signer checks | Each instruction's authority must sign and match the recorded party | `missing_signature_rejected`, `submit_quote_by_non_operator_rejected`, `approve_requires_customer`, `release_by_non_operator_rejected`, `record_by_non_operator_rejected`, `proof_by_non_operator_rejected`, `dispute_by_non_customer_rejected`, `resolve_dispute_admin_only`, `cancel_by_stranger_rejected` |
| Writable checks | The job, vault, payout and source token accounts are checked. The config in `update_config` relies on the runtime rejecting writes to a read-only account. | `job_must_be_writable` |
| Account type tags | 1-byte tag plus minimum size; Config and Job cannot stand in for each other | `load_rejects_wrong_tag`, `load_rejects_short_data`, `config_account_cannot_be_used_as_job` |
| PDA derivation | Stored bump on every load; canonical bump at creation; vault bound to its job | `load_rejects_wrong_pda`, `create_job_at_non_canonical_address_rejected`, `vault_of_other_job_rejected`, `create_job_prefunded_pda_ok` |
| Program ids | SPL Token and System program addresses checked | `wrong_token_program_rejected`, `wrong_system_program_rejected` |
| Mint checks | Customer, vault, funding, operator and treasury token accounts all use the config mint | `create_job_rejects_wrong_mint`, `init_rejects_funding_account_wrong_mint`, `allowlisted_funding_recreated_with_other_mint_rejected` |
| Checked arithmetic | Checked add, sub and multiply everywhere; fee reserve rounds up, earned fee rounds down | `create_job_rejects_overflowing_budget`, `quote_sum_mismatch_rejected`, `release_over_cap_rejected`, `fee_reserve_rounds_up`, `program_matches_model` |
| State machine | Only the spec's transitions succeed, in every state | `only_spec_transitions_succeed`, `program_matches_model`, `customer_cancel_after_approval_rejected`, `quote_after_approval_rejected`, `settle_before_proof_rejected` |
| No reinitialization or revival | Existing accounts cannot be re-created; closed accounts are emptied and reassigned before the instruction ends | `init_twice_rejected`, `create_job_twice_rejected`, `closed_job_cannot_be_revived_in_same_tx`, `recreate_after_close_is_fresh` |
| Customer signs exact terms | Approval must carry the program-computed terms hash (items, ceiling, release cap, quote hash, expiry, fee rate) | `approve_rejects_wrong_terms_hash`, `terms_hash_matches_independent_vector`, `approve_rejects_expired_quote` |
| Mandate bounds | Auto-approval only within the cap and before the mandate expires; mandate cannot outlive the job | `mandate_auto_approves_within_cap`, `mandate_ignored_over_cap_or_expired`, `create_job_rejects_mandate_expiring_after_job` |
| Purchase funds: only the approved amount, only to the allowlist | Cumulative releases ≤ release cap; destination in the allowlist; fee reserve never released | `release_to_allowlisted_altitude`, `release_to_other_account_rejected`, `release_over_cap_rejected`, `release_keeps_fee_reserve_locked`, `second_release_tops_up_to_cap`, `first_release_requires_live_quote_but_top_up_does_not` |
| Charge bounded, unspent funds returned | `charged ≤ released`; the operator returns `released − charged` from its own account in the same instruction | `record_rejects_charge_over_released`, `record_returns_excess_to_vault`, `record_return_must_come_from_operator_account`, `charge_above_release_needs_top_up`, `record_rejects_quote_amount_over_ceiling` |
| Fee only after proof and window, at the job's rate | Settle needs PROVEN, and either the window's end or the customer's signature in a later slot than the proof | `settle_before_proof_rejected`, `settle_by_stranger_during_window_rejected`, `settle_at_window_end_allowed`, `settle_early_by_customer`, `settle_uses_fee_rate_fixed_at_creation`, `customer_sign_off_in_the_proof_transaction_rejected`, `customer_sign_off_needs_a_later_slot_than_the_proof` |
| Disputes | Customer only, strictly inside the window; admin awards at most the earned fee | `dispute_within_window`, `dispute_at_window_end_rejected`, `dispute_before_proof_rejected`, `resolve_dispute_split_bounds`, `resolve_requires_dispute`, `disputed_job_cannot_be_settled` |
| Payouts only to the recorded parties, never the caller | Refund to a customer-owned USDC account, fee to the treasury's, rent to the recorded rent payer | `refund_goes_only_to_customer_owned_account`, `settle_refund_to_foreign_account_rejected`, `settle_refund_to_any_customer_owned_usdc_account`, `timeout_pays_only_customer_or_earned_fee_never_caller`, `rent_returns_to_rent_payer` |
| No stuck funds | Every state has a permissionless exit after its deadline. The vault closes into the job, and the rent payer gets one direct credit, so an executable rent payer cannot unbalance an exit. | `no_stuck_funds_every_state_has_stranger_exit`, `refund_expired_per_state`, `refund_expired_before_timeout_rejected`, `settle_by_stranger_after_window`, `exits_work_when_the_rent_payer_is_executable` |
| Operator cancel makes the customer whole | The operator must return exactly what the vault is missing; no fee; not during a dispute | `operator_cancel_from_each_state`, `operator_cancel_from_released_with_return_refunds_all`, `operator_cancel_requires_exact_return`, `operator_cancel_return_from_foreign_account_rejected`, `operator_cancel_in_dispute_rejected`, `customer_cancel_cannot_return_funds` |
| Config changes never alter an open job's rate or running deadlines | The fee rate, job timeout, window end and dispute deadline are stored on the job | `settle_uses_fee_rate_fixed_at_creation`, `window_is_fixed_when_proof_is_submitted` |
| Pause blocks only new jobs and releases | Every exit keeps working while paused | `create_job_when_paused_rejected`, `release_when_paused_rejected`, `update_config_sets_and_clears_pause`, `exits_work_while_paused` |
| Rent returns to its payer; customers need no SOL | Job and vault rent paid by the rent payer and returned at close | `rent_returns_to_rent_payer`, `customer_needs_no_sol`, `customer_cancel_before_approval_full_refund_and_close` |
| Instruction framing | Empty data and unknown discriminators rejected before any account is read | `empty_instruction_data_is_rejected`, `unknown_discriminators_are_rejected`, `entrypoint_rejects_empty_and_unknown_instructions` |

## Evidence beyond the named tests

**Mutation testing.** Each task removed or weakened its own checks one at a
time and ran the suite against every mutant. Counts per area:

| Area | Mutants | Survived first |
| --- | --- | --- |
| Config init authority | 2 | 0 |
| Job creation, exits, pause | 7 | 0 |
| Quotes, approval, mandate | 12 | 0 |
| Release for purchase | 8 | 1 |
| Record purchase | 7 | 0 |
| Proof and dispute | 8 | 0 |
| Settle, resolve, closing | 8 | 0 |
| Timeouts and cancel | 8 | 0 |
| Fuzz-only (fee rounding, excess return) | 2 | 1 |
| Account checks (writable, program ids, vault PDA, pause scope) | 5 | 0 |

The transition matrix also kills mutants that widen any instruction's allowed
states. Both survivors were caught by new tests:
- The funding account's mint check. The token program also rejects a mint
  mismatch, so the program's own check was invisible;
  `allowlisted_funding_recreated_with_other_mint_rejected` now pins it.
- Fee rounding up instead of down. The fuzz used only round amounts; it now
  includes a charge whose fee has a remainder.

**Independent reviews.** A separate security-only review against this
document found two issues. Each now has a test that failed before its fix:
- A rent payer turned into a program could make every exit fail:
  `exits_work_when_the_rent_payer_is_executable`.
- The customer's early sign-off could be bundled with the proof in one
  transaction and skip the window:
  `customer_sign_off_in_the_proof_transaction_rejected`.

The review's other findings are listed under residual risks.

**Model-based fuzz.** `tests/fuzz.rs` runs random sequences of every
instruction, with random signers, edge amounts (`0`, `1`, cap ± 1,
`u64::MAX`, a charge with a fee remainder) and clock jumps. It runs each
sequence against the program and against an independent reference model
(`tests/model`). After every step it compares the outcome, every token
balance, and each job's existence and state. `initialize_config` runs in
setup; the other 12 instructions are fuzzed. The final run on the fixed build
used 5,000 sequences, with 50,236 successful instructions plus 11,155 clock
jumps, and no disagreement. Every instruction succeeded at least 278 times
(`resolve_dispute`) and up to 10,513 times (`create_job`).

**Unsafe code.** Account data is read through unchecked zero-copy views. That
is sound because every handler loads each account slot at most once, and
Config and Job carry distinct type tags. An account passed in two slots fails
the second typed load before two references exist. See `src/state.rs`.

## Residual risks

- **Operator key compromise.** The attacker can release and spend up to each
  approved cap, auto-approve quotes on jobs with a live mandate, and submit
  false proofs. Limits: the per-job caps, the dispute window, admin key
  rotation (`update_config`) and `paused`.
- **Admin compromise.** This is strictly worse than operator compromise.
  - In one transaction, `update_config` can make the attacker the operator,
    the treasury and the only funding account.
  - The attacker can then release the unreleased cap of every approved job to
    itself, and auto-approve and release every job with a live mandate.
  - It collects every fee settled afterwards.
  - It can set a 1-second dispute window for future proofs.

  The attacker cannot take a vault's balance beyond those caps and fees.
  Mitigation: the admin is a 2-of-3 Squads multisig with one hardware key.
  Binding the operator and allowlist to a job at approval would narrow this;
  it is not done.
- **Upgrade authority.** It can replace the program entirely. Same
  mitigation.
- **Config bounds.** Timeouts are only required to be non-zero. A wrong value
  is stamped onto every job created, proven or disputed while it is live.
- **The operator after the job timeout.** `expires_at` is not a deadline for
  the operator. Until someone calls `refund_expired`, the operator can still
  top up, record and prove, which moves the job out of the refund's reach.
  Loss is bounded by the approved cap plus the fee, and the customer can still
  dispute.
- **The customer after approval.** The customer cannot cancel once a quote is
  approved. If the operator stalls, the funds wait for the job timeout or an
  operator cancel.
- **Operator cancel can be front-run with dust.** The operator's cancel must
  return exactly what the vault is missing. A 1-unit donation to the vault in
  the same slot makes it fail. Recovery: transfer the shortfall into the vault
  directly, then cancel with `returned = 0`.
- **Disputes depend on the admin.** A disputed job is resolved by the
  multisig. If it never acts, the customer gets everything back after the
  dispute timeout and the operator forfeits the fee.
- **Off-chain rails.** Altitude custody, the card network and merchant refunds
  are outside the program.
- **Rent model.** The program reads the rent sysvar and supports exemption
  thresholds of 1.0 (live) and 2.0 (legacy). Any other value fails closed for
  account creation until the program is upgraded; exits never depend on it.
- **Token support.** Classic SPL Token only; Token-2022 mints are not
  supported. USDC is classic.
- **Freezing.** If Circle's USDC freeze authority freezes a vault, every exit
  of that job fails until it is thawed. A frozen customer account is
  harmless: the refund can go to any USDC account the customer owns.
- **Account limit.** The entrypoint reads at most 9 accounts, so
  `initialize_config` ignores a 5th funding account instead of rejecting it.
  `update_config` rejects it.
- **Reused job ids.** A job id reused after its job closed creates a fresh
  job. Indexers must key jobs by their creation transaction.

## Mainnet requirements

1. A separate, security-only review of the program against this document,
   before any mainnet step.
2. Deploy with the deployer key. Call `initialize_config` while that key is
   still the upgrade authority, with the admin set to the Squads vault.
3. Transfer the upgrade authority to the Squads vault (2-of-3, one hardware
   key) and verify it with `solana program show`.
4. Keep the operator key in an environment variable on the agent host only.
5. Before customer funds, run one full lifecycle on devnet against the
   deployed binary: create through settle, plus the cancel and refund paths.
   Account closing and growth through CPI depend on the runtime and are
   proven only in LiteSVM.
6. Run the 5,000-case fuzz (`PROPTEST_CASES=5000`, see Reproducing) on the
   exact commit being deployed.

## Reproducing

```bash
cargo build-sbf --manifest-path programs/will_escrow/Cargo.toml
cargo test -p will_escrow --features idl
PROPTEST_CASES=5000 cargo test -p will_escrow --test fuzz -- --nocapture
```
