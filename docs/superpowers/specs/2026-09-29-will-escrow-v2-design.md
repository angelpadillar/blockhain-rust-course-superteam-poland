# will_escrow v2 — design

Status: draft for review (2026-09-29). Replaces `gift_campaign` for Applied Will
("Will") at Colosseum. Nothing here is implemented yet.

## Goal

An AI agent buys something in the real world while the customer's money sits
in escrow on Solana. Each purchase is paid from the customer's escrow at the
moment it happens (we never front money), and our fee is released only after
proof of delivery and a dispute window.

## Money flow

```
customer USDC ──create_job──▶ job vault (budget + fee reserve)
                                 │
                 release_for_purchase (≤ customer-approved cap)
                                 ▼
                     Altitude USDC deposit address ──▶ Altitude card ──▶ merchant (Glovo, Wolt, Pyszne, …)
                                 │
          record_purchase (operator returns released − charged into the vault)
                                 │
     submit_proof ─▶ dispute window ─▶ settle: fee → treasury, remainder → customer,
                                        job + vault closed, rent → whoever paid it
```

## Trust model (goes into SECURITY.md)

The contract enforces:
- how much can leave escrow: at most the customer-approved `release_cap`;
- where it can go: only config-allowlisted funding token accounts (Altitude);
- when the fee is paid: only after proof and an unchallenged dispute window;
- that funds always have an exit: every non-terminal state has a
  permissionless timeout.

It does not enforce, and cannot, that:
- the operator spends released funds on the approved order;
- the operator reports the charged amount honestly;
- the proof is truthful.

These rest on the operator key, the evidence hashes, the customer's dispute
right and the admin (a Squads multisig on mainnet). Worst case for a customer
facing a malicious operator: losing the released amount, which is at most the
approved cap. The fee is never paid without proof plus the window.

## Accounts

Zero-copy, alignment-1 byte layouts with 1-byte type tags. Hashes are stored,
never strings.

**Config** — PDA `["config"]`, 275 bytes, permanent (≈0.0020 SOL rent):
- tag, version, bump, `paused`
- `fee_bps: u16`
- `dispute_window: u32` (seconds, e.g. 86 400)
- `job_timeout: u32`
- `dispute_timeout: u32`
- `admin`, `operator`, `treasury` (owner of the fee token account)
- `mint` (USDC)
- `funding_count: u8`, `funding: [Address; 4]` (allowlisted USDC token accounts)

**Job** — PDA `["job", customer, job_id: u64]`, 324 bytes, closed at the end.
Fields in layout order:
- tag, version, `status`, `bump`, `vault_bump`
- `job_kind`, `adapter` (u8 each; the program accepts codes 0–15)
- `quote_exponent`, `quote_currency[3]`, `flags`
- `customer`, `rent_payer`, `job_id`
- `budget` (USDC for purchases), `fee_reserve`
- `mandate_cap`, `mandate_expires_at`, `expires_at`
- quote line items in quote-currency minor units: `item`, `service_fee`,
  `delivery_fee`, `tip`, `other`, plus `ceiling`
- `release_cap` (USDC), `quote_expires_at`, `quote_hash`
- `released`, `charged` (USDC), `charged_quote_amount`
- `order_ref_hash`, `proof_hash`, `proof_at`, `disputed_at`

**Vault** — SPL token account, PDA `["vault", job]`, owned by the job PDA.
165 bytes, closed at the end.

Code tables:

| | 0 | 1 | 2 | 3 | 4 | 5 | 6 |
|---|---|---|---|---|---|---|---|
| `job_kind` | food | merch | handmade | generic | service | human_task | — |
| `adapter` | wolt | glovo | pyszne | local_print | local_shop | manual | rentahuman |

Codes 7–15 are reserved; raising the bound needs a program upgrade.

Open-job rent (job + vault) is ≈0.0038 SOL at today's 5,080 lamports/byte, or
≈0.0005 SOL at SIMD-0437's final 696. It is returned when the job closes, so a
job's net cost is its transaction fees.

### Per-job vault versus one shared vault

Recommendation: **one vault per job**.
- **Blast radius.** A shared vault puts every customer's funds behind one
  authority and one accounting invariant (vault balance ≥ Σ job balances). Any
  bug in that ledger, or a dust or donation edge case, puts all funds at risk.
  With per-job vaults, the token balance *is* the ledger, and a bug reaches one
  job.
- **Throughput.** A shared vault is written by every job, so the runtime's
  write lock serializes all concurrent jobs. Per-job vaults run in parallel.
- **What the shared vault saves.** About 0.0015 SOL of *temporary* rent per job
  (refunded anyway) and about 2 CPIs (initialize and close token account),
  roughly 6–8k CU. That is not worth the risk.

## State machine

The terminal state is "account closed". Accounts are zeroed and reassigned, so
they cannot be revived.

| Instruction | Signer | From | To |
|---|---|---|---|
| `create_job` | customer (+ rent payer) | — | FUNDED |
| `submit_quote` | operator | FUNDED, QUOTED | QUOTED, or APPROVED if the mandate covers it |
| `approve_quote(terms_hash)` | customer | QUOTED | APPROVED |
| `release_for_purchase(amount)` | operator | APPROVED, RELEASED | RELEASED (cumulative ≤ `release_cap`) |
| `record_purchase` | operator | RELEASED | PURCHASED (returns `released − charged` into the vault) |
| `submit_proof` | operator | PURCHASED | PROVEN (`proof_at = now`) |
| `settle` | customer anytime, or anyone once `now ≥ proof_at + window` | PROVEN | closed: fee → treasury, rest → customer |
| `dispute` | customer, while `now < proof_at + window` | PROVEN | DISPUTED |
| `resolve_dispute(fee_to_operator)` | admin | DISPUTED | closed: split |
| `cancel` | customer (before approval) or operator (any state except DISPUTED) | FUNDED … PROVEN | closed: everything → customer, no fee; the operator may return merchant-refunded funds in the same instruction (`refund_after_booking`) |
| `refund_expired` | anyone | FUNDED … PURCHASED after `expires_at`; DISPUTED after `disputed_at + dispute_timeout` | closed: vault → customer |
| `initialize_config` | program upgrade authority, once | — | config |
| `update_config` | admin | config | config (rotate keys and funding addresses, pause) |

No stuck funds:
- FUNDED … PURCHASED exit through `refund_expired` after the job timeout.
- PROVEN exits through a permissionless `settle` after the window.
- DISPUTED exits through `refund_expired` after the dispute timeout.

A test proves every one of these exits works, called by an unrelated key.

## Amounts

All in USDC base units (6 decimals); checked arithmetic throughout.
- `fee_reserve = ceil(budget × fee_bps / 10 000)`. The customer deposits
  `budget + fee_reserve`.
- `release_cap ≤ budget`, fixed by the quote.
- `approve_quote` takes the program-computed `terms_hash`, the SHA-256 over the
  job key, line items, ceiling, `release_cap`, `fee_bps` and expiries. The
  customer's signature therefore binds exact amounts. This fixes audit
  finding B4.
- `fee = floor(charged × fee_bps / 10 000) ≤ fee_reserve`.
- `refund = vault balance − fee`.
- A charge above the quote, from FX drift or a tip change, is covered by a
  further `release_for_purchase` up to `release_cap` before `record_purchase`.
  Anything above the cap is a new quote or a cancel.

## Checks (preview of SECURITY.md; each maps to a test)

- **Accounts:** owner (program, SPL Token, system), signer and writable on
  every account.
- **Type tags:** a Job cannot be passed as Config, and vice versa.
- **PDAs:** config, job and vault derivations checked with the stored bump; the
  canonical bump is used at init.
- **Mint:** vault, customer, funding and treasury token accounts all use
  `config.mint`. The token program and system program IDs are checked.
- **Funding destination:** must be in `config.funding[..funding_count]`.
- **Arithmetic:** checked everywhere; tests cover overflow at `u64::MAX`.
- **State machine:** every instruction × state pair outside the table is
  rejected. This is a generated matrix test.
- **Initialization:** config only once, and only by the upgrade authority,
  read from the ProgramData account (fixes audit B1). A job cannot be
  re-initialized while it exists.
- **Closing:** lamports moved first, then owner, lamports and length zeroed
  (Pinocchio `close`). Revival within the same transaction is tested.
- **Duplicate accounts:** a vault may not also fill a customer, treasury or
  funding slot.
- **Rent return:** rent goes only to the stored `rent_payer`.
- **Pause:** blocks `create_job` and `release_for_purchase`. Exits keep working.

## Costs (numbers measured later, into COSTS.md)

- **Binary target:** ≤ 40 KB. That is ≈0.21 SOL of program rent now, or ≈0.03
  SOL after SIMD-0437 step 5. The Anchor v1 build is 425,568 bytes (2.16 SOL).
- **Deploy:** `--max-len` set explicitly to the binary size plus about 5%;
  `solana program extend` if a later upgrade needs more. A temporary buffer of
  the same size needs about 2× the rent in liquid SOL during the deploy. Failed
  deploys leave buffers behind, so `solana program close --buffers` runs as a
  cleanup step.
- **Per job:**
  - transaction fees: about 5 transactions and 6 signatures ≈ 30 000 lamports,
    plus priority fees;
  - temporary rent: ≈0.0038 SOL, refunded at close.
  - For 100 jobs: ≈0.003–0.005 SOL in fees, plus up to ≈0.38 SOL of rent
    float if all 100 are open at once.

## Off-chain pieces

- **Customer approval on the phone:** a Solana Pay transaction request. The
  operator pre-signs `create_job + submit_quote + approve_quote` as one
  transaction, and the customer signs once. This needs a public HTTPS endpoint.
- **Altitude funding:** `release_for_purchase` sends USDC to the Altitude
  deposit token account. The agent polls the Altitude daemon's `/balance`
  until the credit appears, then checks out with the existing executor and
  3DS flow.
- **Client:** Codama macros behind an `idl` cargo feature (no on-chain size
  cost) produce `idl.json`. `@codama/renderers-js` turns it into a
  `@solana/kit` TypeScript client used by the agent, the scripts, the MCP
  server and the `/jobs` indexer.
- **RentAHuman:** a dry run only, through the MCP (`create_bounty` with
  `dryRun: true`).
- **Indexer and `/jobs`:** built from mainnet transaction history (program
  signatures decoded with the client), plus a private metadata file with each
  job's description whose hash is committed on-chain. The page shows real,
  settled jobs only.
