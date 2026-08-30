# Buena Gift Campaign PoC

A human-in-the-loop Solana escrow and supervised off-chain fulfillment runner
for physical goods. The sender locks SPL tokens and approves an exact final
quote. Only then may the fulfillment oracle make one card attempt, complete a
permitted email 3DS challenge, record a merchant-confirmed purchase, and settle
after proof of delivery.

This is deliberately the weekend-sized product:

- Rust/Anchor program with a PDA-owned SPL-token vault
- legacy `Funded -> Researched -> Approved -> Settled` course lifecycle
- exact `Funded -> Quoted -> Approved -> PaymentAttempted ->
PaymentAuthenticated -> Purchased -> Settled` fulfillment lifecycle
- mandatory sender signature at the gift approval gate
- research and delivery hashes on-chain, with no recipient PII
- LiteSVM integration tests
- a Surfpool demo plus an off-chain adapter runner in `agent/`

The agent never issues or funds cards and never uploads a delivery photo. Card
credentials, OTPs, email content, recipient details, addresses, and order IDs
remain off-chain. Solana receives exact typed amounts and SHA-256 commitments.

## Architecture

| Layer             | Responsibility                                               | Data location                       |
| ----------------- | ------------------------------------------------------------ | ----------------------------------- |
| Gift brief / AI   | Consented research and three office-safe options             | Off-chain JSON                      |
| Human sender      | Select and approve one gift                                  | Wallet signature                    |
| Fulfilment        | Supervised adapter; one card attempt after approval          | Off-chain                           |
| Solana program    | Lock funds, enforce state transitions, settle, emit receipts | Public chain                        |
| Proof of delivery | Photo or courier receipt                                     | Private file; SHA-256 only on-chain |

The contract stores no name, email, LinkedIn profile, street address, gift
description, or photo.

Currency is represented as a three-letter uppercase code, an explicit 0–4
decimal exponent, and integer minor units. The quote separately records the
settlement currency/amount and the actual card currency/amount, plus a fixed
conversion snapshot. Kraków/PLN is the current adapter policy, not a protocol
assumption; future regional adapters can use EUR, USD, JPY, KWD, and other ISO
currency codes without floating-point values on-chain.

## Prerequisites

The project is pinned to the toolchain installed on the course machine:

- Anchor CLI 1.1.2
- Solana CLI 3.1.x
- Surfpool 1.5.0
- Rust 1.89+ (the local stable toolchain is fine)
- Yarn 1.22

The installer asking for Surfpool 1.4.0 while 1.5.0 is installed is not a
blocker for this project. Do not run `solana-test-validator` and Surfpool at the
same time because both default to port 8899.

Install the TypeScript client dependencies once:

```bash
yarn install
```

## Build and test

```bash
anchor build
cargo test --workspace
yarn tsc --noEmit
yarn format:check
```

The nine LiteSVM integration tests cover:

- happy-path fee split and sender refund
- rejection of a non-sender gift approval
- rejection of delivery before approval
- rejection of zero hashes
- full sender cancellation refund and post-expiry oracle cancellation
- rejection of the wrong SPL-token mint
- the complete exact-quote/payment-auth/purchase/settlement path
- rejection of quote and card-auth amount mismatches
- recovery after an attempted payment only by the oracle after expiry (the
  sender cannot race an in-flight charge with an immediate escrow refund)

The agent tests additionally cover payment defaults, amount caps, secret-path
ignores, exact notes and fee parsing, Apata versus Altitude-login OTP
classification, multi-currency minor units, and redaction of OTPs from chain
artifacts.

## Run the Surfpool presentation

Use two terminals. The helper creates a repository-local demo wallet only when
one does not already exist; it never overwrites `~/.config/solana/id.json`.

Terminal A:

```bash
./scripts/start-surfpool.sh
```

On macOS Surfpool stays in the foreground. Keep that terminal open so the TUI
and Studio remain available.

Terminal B:

```bash
export ANCHOR_PROVIDER_URL=http://127.0.0.1:8899
export ANCHOR_WALLET="$PWD/.demo/payer.json"

anchor program deploy \
  --program-name gift_campaign \
  --provider.cluster "$ANCHOR_PROVIDER_URL" \
  --provider.wallet "$ANCHOR_WALLET" \
  --no-idl

yarn demo:surfpool
```

Surfpool Studio is at [http://127.0.0.1:18488](http://127.0.0.1:18488).
The script prints every transaction signature, the campaign/vault PDAs, the
three hashes, and the final decoded campaign account.

The Config PDA is intentionally initialized only once. To replay the full demo,
stop Surfpool with Ctrl-C, start a fresh in-memory Surfnet, deploy again, and
rerun the script.

## Run the exact supervised fulfillment lifecycle

Use a fresh Surfpool instance and deploy the program as above. Configure and
test the off-chain runner in `agent/` first. With both payment flags false,
`npm run order:prepare` is a safe browser dry run: it saves the final delivered
quote and stops without loading a card, clicking Pay, or submitting an OTP.

For a later, explicitly funded one-order experiment, set `ALLOW_PAY=true` only
in the ignored `agent/.env`, leave `ALLOW_3DS_SUBMIT=false` for a human-typed
challenge, and run:

```bash
cd agent
npm run checklist
npm run order:prepare
```

After the browser calculates the exact final amount, the same process creates
and funds the Surfpool escrow and asks the sender to type an amount-specific
approval phrase. The agent verifies that exact approval on-chain before it
loads card fields. Immediately before its single Pay click it writes the local
preflight artifact and commits its hash on-chain. It never retries.

If Apata presents 3DS, the agent always chooses email when the challenge offers
a channel. AgentMail may read only the dedicated inbox and only a fresh Apata
payment message. `ALLOW_3DS_SUBMIT=false` leaves code entry to the human;
setting it true still requires an immediate `SUBMIT OTP` terminal confirmation.
The OTP itself is never committed to Solana. Payment authentication is recorded
only after the challenge has closed and the merchant confirmation page is
visible; the order ID is hashed before it reaches Solana.

After delivery, hash the private proof file and settle the exact escrow amount:

```bash
cd agent
PROOF_FILE="/absolute/path/to/proof-photo.jpg" npm run finalize
cd ..
ANCHOR_PROVIDER_URL=http://127.0.0.1:8899 \
FULFILLMENT_ORACLE_WALLET="$PWD/.demo/fulfillment-oracle.json" \
yarn fulfillment:chain settle "/absolute/path/to/proof-photo.jpg"
```

The complete chain audit is `QuoteSubmitted`, `QuoteApproved`,
`PaymentAttempted`, `PaymentAuthenticated`, `PurchaseConfirmed`, and
`FulfillmentSettled`. Authentication here means the challenge completed and a
merchant-confirmed order followed; it is not inferred merely from receiving an
email.

## Use a real delivery photo in the live demo

The default rehearsal uses a clearly labelled simulated proof. For the course
presentation, pause at both human checkpoints and hash a real photo without
uploading it:

```bash
LIVE_DEMO=1 \
PROOF_FILE="/absolute/path/to/delivery-photo.jpg" \
yarn demo:surfpool
```

The bytes remain on the laptop. Only the 32-byte SHA-256 digest is sent to the
program.

## Three-minute talk track

1. Show `scripts/brief.example.json`: a consented, office-only brief with three
   pastry choices. Explain that this file is private and off-chain.
2. Run the demo and show the funded campaign transaction in Surfpool Studio.
3. At `HUMAN GATE`, explain that neither an AI nor an admin can approve the
   gift—the sender wallet must sign.
4. When the pastry arrives, set `PROOF_FILE`, continue, and show the delivery
   hash plus the `Settled` campaign state.
5. Close with: “Solana is the settlement and audit rail; the AI is the research
   brain; the local bakery and courier are the hands.”

## Move to devnet after the course

Use a funded devnet wallet and the same compiled program. The demo script will
automatically print Solana Explorer links when the provider URL contains
`devnet`.

```bash
export ANCHOR_PROVIDER_URL=https://api.devnet.solana.com
export ANCHOR_WALLET=/absolute/path/to/devnet-wallet.json

anchor program deploy \
  --program-name gift_campaign \
  --provider.cluster devnet \
  --provider.wallet "$ANCHOR_WALLET" \
  --no-idl

yarn demo:surfpool
```

To record the completed supervised Surfpool run on devnet, replay the exact
quote, payment-attempt, authentication, purchase, delivery-proof, and
fulfillment artifact hashes after deploying the program. The command uploads
only hashes and typed amounts; the order ID, delivery address, card details,
OTP, and proof image remain local.

```bash
solana transfer --url devnet \
  --keypair /absolute/path/to/funded-devnet-wallet.json \
  62tsZ62NiRK8uVZzq6A9Z2fa45QvrYrxcnhLw9jg8oos 0.1

ANCHOR_PROVIDER_URL=https://api.devnet.solana.com \
DEVNET_REPLAY_CONFIRM=RECORD_SURFPOOL_EVIDENCE \
yarn replay:devnet
```

The replay writes its public addresses, evidence hashes, transaction
signatures, and Explorer links to the ignored private file
`.demo/devnet-replay.json`. Re-running the command returns the existing settled
campaign instead of duplicating it.

The PoC uses a local dummy SPL token. Before mainnet, switch the Config mint to
the canonical USDC mint, add vendor purchase payouts or a capped card-funded
off-chain purchase step, use durable oracle key management, and define a real
dispute/refund policy.

## Program layout

```text
programs/gift_campaign/src/
  instructions/
    initialize.rs
    create_campaign.rs
    submit_research.rs
    approve_gift.rs
    confirm_delivery.rs
    cancel.rs
  constants.rs
  errors.rs
  events.rs
  state.rs
  lib.rs
programs/gift_campaign/tests/gift_campaign.rs
scripts/demo.ts
scripts/brief.example.json
scripts/start-surfpool.sh
```
