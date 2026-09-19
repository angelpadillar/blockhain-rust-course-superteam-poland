# Off-chain fulfillment adapters

This directory is one supervised adapter runner for a Solana shipment protocol.
The Solana escrow is the authorization and settlement contract; these adapters
do the off-chain work. The exact lifecycle is additive, so the original course
demo remains available.

The Sunday wow path is `local_print`: find a Kraków print shop that can produce
one office-safe sticker, tote, tee, or similar object today. `pyszne` is the
preferred food dry-run and supports the dedicated AgentMail login flow; `glovo`
and legacy `wolt` remain fallbacks. `manual` creates a precise human handoff when
a merchant has no safe web checkout. `local_shop` currently routes to that same
conservative manual handoff until a merchant-specific adapter exists.

> Pyszne, Glovo, and Wolt are last-mile food. Local print is vibe-adjacent merch with a same-day
> SLA. The protocol does not care which adapter wins: lock, approve the exact
> quote/spec hash, make one purchase attempt, and prove delivery.

Nomu is a possible future manufacturing adapter with a multi-day SLA. It is not
appropriate for the same-day Kraków demo, and this repository contains no Nomu
API client.

## Safety model

- `ALLOW_PAY=false` and `ALLOW_3DS_SUBMIT=false` by default.
- A local checklist must match the current config and flags before any browser
  adapter runs. The artifact expires after 30 minutes.
- Venue/contact data requires an immediate terminal confirmation before it is
  typed into a merchant form.
- Automatic Wolt payment requires an immediate full-amount + last-four
  confirmation before Pay. Card fields are loaded only behind `ALLOW_PAY=true`.
- Exact escrow funding and sender approval must be visible on-chain before card
  fields are loaded. The payment-attempt hash is committed before Pay is
  clicked.
- A one-attempt marker is created before Pay. Success or hard failure blocks
  silent retries.
- Any amount above `max_pln`, non-Kraków destination, overseas/slow factory,
  non-food food-adapter job, or enabled/mandatory card storage aborts. A
  clearly optional save-card checkbox is allowed only while visibly unchecked.
- Local-print forms are never submitted automatically. Phone/WhatsApp-only
  shops produce `agent/out/manual_call.md` and stop.
- Card data, billing data, AgentMail credentials, OTPs, local venue data,
  browser profiles, and outputs are ignored by git. Logs show the last four
  only.
- Only currency codes, integer minor-unit amounts, timestamps, and artifact
  hashes reach Solana. OTPs, order IDs, addresses, and email bodies do not.

Revolut is a human-present fallback only. Keep automated payment disabled and
approve 3DS yourself in the Revolut app. The primary automated rail remains an
Altitude virtual Visa whose approximately $40 cap is managed outside this
repository; the agent does not issue or freeze cards.

## Setup

```bash
cd agent
npm install
cp config.example.json config.local.json
cp .env.example .env
```

The default example is `job_kind=merch`, `adapter=local_print`. Replace the
venue values locally, ensure `address_line` includes `Kraków`, and either create
the configured design file or set `design_file` to `null` to hash the spec JSON.
For food, prefer `config.pyszne.example.json`; the adapter can use the dedicated
AgentMail inbox for Pyszne's short-lived email login code. Glovo is available
through `config.glovo.example.json` as a persistent-profile fallback, and the
original Wolt path remains in `config.wolt.example.json`.
`config.pyszne-curated.example.json` demonstrates the supervised agent-curated
mode: the human approves the venue, participant count, dietary/product policy,
and hard cap first; the browser agent then chooses exact live products. The
final visible product names, quantities, destination-adjusted fees, and landed
total are hashed into the quote and require the normal exact on-chain approval
before payment. The current demo policy requires exactly 2 L of regular 3.2%
cow's milk, enough clearly labelled 100% juice or office-safe functional drinks
for every participant, at least one healthier snack, and no substitutions,
nectar, ordinary juice drinks, alcohol, or confectionery.
Never put card or billing
values in a JSON config. They belong only in the ignored `agent/.env`; the
corresponding fields in `.env.example` must remain blank.
The Wolt example keeps `contact_email=angel@buena.ai` for the existing Wolt
account and uses `three_ds_email=fulfillment-demo@mail.buena.ai` for the card
challenge. The AgentMail inbox must match `three_ds_email`; it does not need to
match the Wolt login identity.

The normalized adapter interface is:

```text
searchOrOpen()
buildCartOrOrderForm()
fillDestination()
attachNote()
quote()
stopAtPaywall()
pay()                 # optional, still gated
```

Run the fail-closed tests and browser-free approval checklist first:

```bash
npm test
npm run typecheck
npm run checklist
```

Then run the selected adapter:

```bash
npm run order:prepare
```

Pyszne and Glovo do not parse merchant DOM text for prices. At the final
checkout they pause at `MCP QUOTE READY`; the supervising AI/browser MCP reads
the rendered summary and writes `agent/out/mcp-browser-observation.json`.
Deterministic code then verifies the approved item list, destination, exact
note, source host, capture freshness, fee arithmetic, unopened payment method,
and `max_pln`. For agent-curated mode, that deterministic layer also verifies
the milk volume/fat, beverage serving count, and healthier-snack policy before
hashing the exact selected basket. `npm run quote:mcp` revalidates the same observation without
opening a browser. The AI extracts what the user sees; it does not decide
whether the quote is authorized.

Each browser adapter uses its own ignored persistent profile:
`agent/pyszne-profile`, `agent/glovo-profile`, or the legacy
`agent/chrome-profile` for Wolt. Pyszne can continue as a guest. Glovo logins
and CAPTCHAs remain a human task; the agent never reads a password or CAPTCHA.
When Pyszne creates its temporary guest identity at checkout,
`PYSZNE_LOGIN_MODE=agentmail` submits only the configured dedicated inbox after
the explicit `PYSZNE ACCEPT TERMS AND LOGIN` confirmation. The reader accepts
only a fresh Pyszne/Takeaway/Just Eat sender and either an allowlisted
`pyszne.pl` link or a contextual six-character alphanumeric login code. This is account login,
not payment 3DS, and no login message is persisted.
Local print tries these Kraków
searches in order and skips unavailable results:

1. `nadruk koszulek Kraków na już`
2. `drukarnia Kraków ekspres`
3. `naklejki Kraków`

It rejects overseas/POD marketplaces, prefers pickup-at-shop or courier to the
configured venue, and accepts only visible Kraków merch results. If the first
credible shop has only phone or WhatsApp, the manual handoff is the successful
adapter result. It does not keep clicking random sites.

## Payment and 3DS

All adapters stop before payment by default. Pyszne and Glovo provide the
complete safe dry-run path—address, approved food cart, exact note, final
destination-adjusted landed quote, screenshots, and STOP. The normal Pyszne
browser adapter still rejects `ALLOW_PAY=true`; live Pyszne payment is isolated
in the explicit `payment:pyszne` sidecar described below. Glovo payment remains
human-only.
For Pyszne, every minimum-order top-up must appear explicitly in `items` before
the checklist is confirmed. A visible “Spend another … for delivery” message
blocks checkout, and best-match substitutions must be disabled.
Wolt retains the previously rehearsed card
path behind both the current checklist artifact and `ALLOW_PAY=true`:

```bash
ALLOW_PAY=true npm run checklist
ALLOW_PAY=true npm run order:prepare
```

The Wolt path blocks card saving, prints only last four, confirms amount and
last four immediately before Pay, and creates `card-attempt.json` before its
single click. It also requires a sender-approved exact on-chain quote and
commits `payment-attempt.json` before that click. It never retries the card.
Dynamic local-print merchant payment is deliberately human-only even when
`ALLOW_PAY=true` because an unknown form cannot safely inherit Wolt selectors.

### Pyszne PayU payment handoff

Pyszne's [official terms](https://www.pyszne.pl/en/terms-and-conditions)
identify PayU as the payment operator for payment-card orders. For an MCP-built
basket, `payment:pyszne` now prepares the existing supervised Chrome/Comet
checkout instead of opening a second browser profile. It validates the fresh
quote and checklist, requires the exact amount plus last four, commits the
one-attempt hash on-chain, and writes `mcp-payment-preflight.json`. Codex then
continues the exact tab only after the user says `EXECUTE APPROVED PYSZNE
PAYMENT`. An optional PayU/Click to Pay storage checkbox is accepted only when
it is visibly unchecked; checked, mandatory, or unverifiable storage fails
closed.

Card values are loaded from the ignored `.env` inside the local preflight and
supervised browser runtime; their values are never printed, passed as tool
arguments, or written to output files. Both flags remain false in
`.env.example`. Enable them only for the one command:

```bash
ALLOW_PAY=true ALLOW_3DS_SUBMIT=true npm run payment:pyszne
```

The handoff requires the payment-enabled checklist and `PAY amount ####`.
Codex confirms the card transmission at action time and—if Apata challenges the
card—requires `SUBMIT OTP`. The preflight creates the one-attempt marker and
commits its hash on Surfpool before Codex clicks Pyszne's `Order and pay`
button. A failure after that point is terminal; do not rerun the command with
the same order. The older separate-profile implementation remains available as
`npm run payment:pyszne:profile` only for a checkout that was built in that
same ignored Playwright profile.

### Clean demo reset

`npm run demo:reset` never deletes the previous run. After the exact
`ARCHIVE AND RESET DEMO` confirmation, it moves active artifacts into
`agent/out/archive/<timestamp>/`, then recreates an empty active screenshots
directory. Browser profiles, `.env`, local config, and the Anchor program are
unchanged. A `started`, `auth_pending`, or unreconciled `hard_fail` card attempt
blocks reset. After checking both Altitude card activity and Pyszne order
history, record an observed no-charge outcome with both payment flags false:

```bash
npm run payment:reconcile
```

This requires the amount-specific `CONFIRM NO CHARGE amount last4` phrase. It
does not retry the card or erase the failed attempt; the subsequent reset
archives it before a new order may begin.

For 3DS, see [mail.md](./mail.md). The default fixture stub reads
`agent/out/otp.json`; the optional AgentMail source reads only
`fulfillment-demo@mail.buena.ai`. Neither source accesses Nango. They accept
only an Apata payment email from `no-reply@apata.io`, an exact six-digit OTP, an allowed
merchant descriptor, and an amount/currency bound to `quote.json`. An Altitude
“continue in Altitude” login OTP is always rejected. Submission remains behind
`ALLOW_3DS_SUBMIT=false` and the immediate `SUBMIT OTP` confirmation.

For an MCP payment, keep the existing 3DS challenge visible and run the
confirmation in a separate terminal while Codex remains in the same active
turn:

```bash
ALLOW_PAY=true ALLOW_3DS_SUBMIT=true npm run 3ds:approve
```

The command validates the fresh Apata handoff against the quote and active card
attempt, then writes a two-minute approval containing only the OTP's SHA-256.
Codex waits for that local artifact and submits the matching OTP before ending
the browser turn. It must not end a turn to request the confirmation in chat,
because an MCP-created payment tab may close between turns.

Enable the inbox reader locally only after setting its secret in `agent/.env`:

```dotenv
MAIL_SOURCE=agentmail
AGENTMAIL_API_KEY=local-secret-value
AGENTMAIL_INBOX=fulfillment-demo@mail.buena.ai
```

With both payment flags still false, verify mailbox access using
`npm run mail:check`. It prints at most five subject lines and fetches no bodies.

The reader polls fresh messages for up to 120 seconds after a 3DS attempt and
writes only the minimal validated `agent/out/otp.json`. It never logs or stores
the complete email body and never changes inbox state.

The payment email’s currency and amount must equal the exact approved card
charge. Currency values use a three-letter uppercase code, an explicit decimal
exponent, and integer minor units in the chain artifact. This keeps the
protocol globally usable for two-decimal currencies as well as JPY-style
zero-decimal and KWD-style three-decimal currencies. Kraków and `max_pln` remain
the current PoC adapter policy only.

To simulate receipt without paying or polling a mailbox, copy the synthetic
fixture by hand:

```bash
mkdir -p out
cp fixtures/apata-3ds.txt out/otp.json
npm run otp:dry-run
```

The future stub reader can normalize that raw fixture in place. Copy it only
after a simulated attempt begins; its file timestamp is part of the stale-code
check. `npm test` exercises the same classifier, parser, login-code rejection,
and quote amount validation without opening a browser.

## Outputs

All outputs are local and gitignored:

```text
agent/out/quote.json
agent/out/manual_call.md
agent/out/fulfillment.json
agent/out/paid.json
agent/out/otp.json
agent/out/card-attempt.json
agent/out/chain-job.json
agent/out/payment-attempt.json
agent/out/payment-auth.json
agent/out/purchase.json
agent/out/screenshots/cart.png
agent/out/screenshots/address.png
agent/out/screenshots/paywall.png
agent/out/screenshots/confirmation.png
```

`quote.json` always records `job_kind`, `adapter`, `landed_pln`, `max_pln`,
`note`, `spec_hash`, `venue_label`, and `sla`. An unknown landed price is `null`
with `sla=manual`; it is never treated as permission to pay.

For a live payment experiment, keep both flags false in `.env`. Enable them only
on the payment-enabled checklist and payment-sidecar commands. The adapter
pauses after the final dynamic quote for an amount-specific sender approval; a
stale or mismatched `chain-job.json` fails closed.

After a human payment, create or verify `agent/out/paid.json`, then run:

```bash
npm run finalize
```

When `PROOF_FILE` points to a local proof photo, fulfillment contains the SHA-256
of the file bytes. The photo is not uploaded and no PII is sent to Solana.

Resume the existing Solana demo from the repository root with:

```bash
LIVE_DEMO=1 PROOF_FILE=/absolute/path/to/proof-photo.jpg yarn demo:surfpool
```

For the additive exact lifecycle, the confirmed browser order automatically
records redacted authentication and purchase hashes. After delivery, settle
using the private proof file from the repository root:

```bash
cd agent
PROOF_FILE="/absolute/path/to/proof-photo.jpg" npm run finalize
cd ..
ANCHOR_PROVIDER_URL=http://127.0.0.1:8899 \
FULFILLMENT_ORACLE_WALLET="$PWD/.demo/fulfillment-oracle.json" \
yarn fulfillment:chain settle "/absolute/path/to/proof-photo.jpg"
```

## Altitude session daemon

`npm run altitude:session -- open|enroll|attest|forget` is the supervised
harness: enroll registers a harness-owned passkey on a CDP virtual
authenticator and stores it in the gitignored `agent/out/altitude-passkey.json`,
attest re-injects it so a WebAuthn ceremony resolves with no human prompt.

`npm run altitude:server` keeps that session open behind a loopback daemon so
callers issue commands instead of driving the dashboard:

```bash
ALTITUDE_SERVER_TOKEN=... ALTITUDE_MAX_CARD_USD=200 npm run altitude:server
curl -H "Authorization: Bearer $ALTITUDE_SERVER_TOKEN" -X POST http://127.0.0.1:8787/session/attach
curl -H "Authorization: Bearer $ALTITUDE_SERVER_TOKEN" http://127.0.0.1:8787/balance
curl -H "Authorization: Bearer $ALTITUDE_SERVER_TOKEN" -H 'content-type: application/json' \
  -d '{"reference":"order-1042","amount_usd":50,"currency":"USDC"}' \
  -X POST http://127.0.0.1:8787/card/create
```

`/balance` and `/card/create|fund|freeze|close` validate the request against the
funding policy, screenshot the dashboard and return `status: "stub"` with the
recon each command still needs. Nothing mutates the Altitude account until those
selectors are known. Set `ALTITUDE_BROWSER_EXECUTABLE` when Chrome is not at the
channel's default path, as on a VPS.
