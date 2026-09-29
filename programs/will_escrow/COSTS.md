# will_escrow costs

Every figure below was measured or computed from measurements on 2026-09-30.
The rent rate was read from the Rent sysvar on both mainnet-beta and devnet
(`solana rent`): **5,080 lamports per byte** at an exemption threshold of 1.0,
which is SIMD-0437 step 2. The compute-unit table is checked by
`tests/costs.rs`, which fails if a measurement differs from it.

## Binary size

| Build | `.so` size | vs Anchor |
| --- | ---: | ---: |
| Anchor 1.1.2 (`gift_campaign`, v1) | 425,568 B | — |
| Pinocchio port of v1 (`gift_campaign_pinocchio`) | 43,032 B | −89.9% |
| **will_escrow (Pinocchio 0.11.2, `opt-level = "s"`)** | **32,136 B** | **−92.4%** (13.2× smaller) |

## Deploy rent

`scripts/deploy.sh` sets `--max-len` to the binary size plus 5% (33,743 B), so
a small fix can be deployed without extending the account first.

| Account | Bytes (incl. 128 overhead) | Lamports | SOL |
| --- | ---: | ---: | ---: |
| ProgramData (45 + 33,743) | 33,916 | 172,293,280 | 0.1723 |
| Program | 164 | 833,120 | 0.0008 |
| **Deploy total (locked while the program exists)** | | **173,126,400** | **0.1731** |
| Buffer during a deploy or upgrade (37 + 32,136) | 32,301 | 164,089,080 | 0.1641 |

- **Buffer.** The buffer is funded up front and refunded when the deploy
  lands, so the deployer needs about 0.34 SOL available at the peak.
- **Devnet check.** The devnet deploy cost the deployer 173,317,377 lamports:
  the rent above plus 190,977 lamports of transaction and priority fees
  (10,000 micro-lamports per CU). The ProgramData account holds exactly
  0.17229328 SOL. No buffers were left to close.
- **Anchor comparison.** The v1 Anchor binary under the same `--max-len` rule
  would lock **2.2717 SOL**, or 2.1636 SOL at its exact size.
- **Getting the rent back.** Deploy rent comes back only when the program is
  closed, and a closed program id can never be reused. Upgrades need only the
  temporary buffer and fees: a same-size upgrade through `scripts/deploy.sh`
  cost 185,974 lamports on devnet.

## Compute units

Each will_escrow figure is LiteSVM's `compute_units_consumed` for a
transaction holding only that instruction, CPIs included. The v1 figures are
per-instruction averages from the v1 parity suite, measured the same way
(`cargo test -p gift_campaign --test parity -- --nocapture`).

The instruction sets differ, so the v1 columns show the closest v1
instruction, not the same one. One cross-check on a real cluster:
`initialize_config` used 3,752 CU on devnet against 3,756 in LiteSVM.

| Instruction | CU | Closest v1 instruction | v1 Anchor | v1 Pinocchio |
| --- | ---: | --- | ---: | ---: |
| `initialize_config (1 funding account)` | 3,756 | `initialize` | 8,596 | 3,444 |
| `update_config` | 730 | — | | |
| `create_job (both bumps 255)` | 18,335 | `create_campaign` | 36,013 | 22,284 |
| `create_job (one extra bump attempt)` | 19,835 | | | |
| `submit_quote` | 944 | `submit_quote` | 8,239 | 1,379 |
| `approve_quote` | 778 | `approve_quote` | 5,325 | 750 |
| `release_for_purchase` | 7,140 | — | | |
| `record_purchase (returns excess)` | 6,951 | `record_purchase` (no token transfer) | 7,673 | 1,051 |
| `submit_proof` | 796 | — | | |
| `settle (fee + refund + close)` | 17,151 | `settle_fulfillment` | 36,853 | 19,393 |
| `submit_quote (mandate approves)` | 951 | `approve_quote_with_mandate` | 12,381 | 1,988 |
| `dispute` | 786 | — | | |
| `resolve_dispute` | 17,161 | — | | |
| `cancel (customer, before approval)` | 11,168 | `cancel` | 19,908 | 7,396 |
| `cancel (operator, returns release)` | 17,421 | — | | |
| `refund_expired` | 11,256 | — | | |

- **Token-moving instructions.** The instructions that move tokens are
  dominated by their SPL Token CPIs: `settle`, `resolve_dispute`, `cancel`
  and `refund_expired` each transfer and close the vault.
- **`create_job`.** It creates two accounts and derives both canonical bumps.
  Each failed bump attempt adds 1,500 CU. A bump search fails about once on
  average, so a typical `create_job` costs about 21,335 CU. That is the
  figure used below.
- **The rest.** Instructions that only change job state cost under 1,000 CU.

## Running 100 jobs

The operator pays all fees and rent; the customer needs only USDC.

**Happy path per job.** 55,196 CU on average (with `create_job` at 21,335),
in 5 transactions and 6 signatures:
1. `create_job` + `submit_quote` + `approve_quote` in one transaction signed
   by the operator and the customer;
2. `release_for_purchase`;
3. `record_purchase`;
4. `submit_proof`;
5. `settle`.

The priority fee is charged on the requested CU limit, so the agent should set
the limit to about the measured CU.

| Priority fee (micro-lamports/CU) | Fees per job | Fees for 100 jobs |
| ---: | ---: | ---: |
| 0 | 30,000 lamports | 0.0030 SOL |
| 10,000 | 30,552 lamports | 0.0031 SOL |
| 100,000 | 35,520 lamports | 0.0036 SOL |
| 1,000,000 | 85,196 lamports | 0.0085 SOL |

**Rent float.** An open job holds its Job account (326 B) and its vault token
account (165 B): 3,794,760 lamports (0.0038 SOL). Both return to the rent
payer when the job closes, in every exit path. With 100 jobs open at once the
peak float is **0.3795 SOL**, all of it recovered. The config account is a
one-time 2,047,240 lamports (0.0020 SOL).

**Total for 100 jobs.** About 0.003–0.009 SOL in fees that are spent, plus up
to 0.38 SOL of float that comes back.

## SIMD-0437 sensitivity

SIMD-0437 lowers the rent rate in five steps.
- Step 1 activated on mainnet on 2026-09-03.
- Step 2 is live: the Rent sysvar reads 5,080 on mainnet and devnet.
- Steps 3–5 are scheduled for Agave 4.4, expected November 2026.

| Rate (lamports/byte) | Step | Deploy | Buffer | Anchor v1 deploy | Rent per open job | 100 open jobs | Config |
| ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 6,960 | before | 0.2372 | 0.2248 | 3.1124 | 0.005199 | 0.5199 | 0.002805 |
| 6,333 | 1 | 0.2158 | 0.2046 | 2.8320 | 0.004731 | 0.4731 | 0.002552 |
| **5,080** | **2 (live)** | **0.1731** | **0.1641** | **2.2717** | **0.003795** | **0.3795** | **0.002047** |
| 2,575 | 3 | 0.0878 | 0.0832 | 1.1515 | 0.001924 | 0.1924 | 0.001038 |
| 1,322 | 4 | 0.0451 | 0.0427 | 0.5912 | 0.000988 | 0.0988 | 0.000533 |
| 696 | 5 | 0.0237 | 0.0225 | 0.3112 | 0.000520 | 0.0520 | 0.000280 |

All amounts are in SOL. Anchor figures use the same `--max-len` rule (size +
5%).

The program computes rent from the Rent sysvar at the threshold of 1.0, so it
follows each step without an upgrade. A threshold other than 1.0 or 2.0 fails
closed (see SECURITY.md).
