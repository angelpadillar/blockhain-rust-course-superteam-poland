# Local milk MCP demo

This path keeps shopping and quote extraction in the supervised Codex session.
Payment remains disabled unless the separate local PayU sidecar is explicitly
started for one approved run.

## Recorded terminal

From `agent/` run:

```bash
npm run demo:milk
```

The configured product is exactly 3.2% regular cow's milk in 1 L units. Review
the complete checklist and type `CONFIRM ONE ORDER`. The command creates
only the local approval artifact and prints the prompt to paste into Codex. It
does not open a browser.

## Codex MCP browser

Paste the printed prompt into the active Codex task. Codex uses the connected
Chrome MCP to compare visible grocery results, handle minimum-order rules, fill
the configured venue checkout, and stop before the payment method. Every
minimum-order top-up must be proposed and approved as a named item first. The
current Blumiś demo configuration explicitly includes two milk cartons, two
Sante coconut bars, three Mars bars, and three Twix bars.

Do not run `npm run order:prepare` for this path. That command is the legacy
scripted browser adapter; the milk demo intentionally uses semantic MCP browser
control.

After Codex captures and validates the final quote, record the exact Surfpool
approval from the repository root:

```bash
ANCHOR_PROVIDER_URL=http://127.0.0.1:8899 \
ANCHOR_WALLET="$PWD/.demo/payer.json" \
yarn fulfillment:chain bootstrap
```

Type the exact amount-specific phrase printed by that command. This records the
quote and approval on local Surfpool; it does not pay the merchant.

## Clean recorded run

From `agent/`, archive the earlier unfinished run:

```bash
npm run demo:reset
```

Type `ARCHIVE AND RESET DEMO`, empty the visible Pyszne cart, and run the normal
MCP shopping/quote flow. Once the exact quote is approved on Surfpool, create a
fresh payment-enabled checklist and start the local sidecar:

```bash
ALLOW_PAY=true ALLOW_3DS_SUBMIT=true npm run checklist
ALLOW_PAY=true ALLOW_3DS_SUBMIT=true npm run payment:pyszne
```

The default payment command preserves the supervised Chrome/Comet checkout. It
verifies the quote and on-chain approval, requires `PAY amount ####`, commits
the one-attempt preflight, and tells you to return to Codex with `EXECUTE
APPROVED PYSZNE PAYMENT`. Codex then fills the Altitude card only on
Pyszne/PayU and monitors the dedicated AgentMail inbox if Apata presents 3DS.
OTP submission still requires `SUBMIT OTP`. Both flags remain false by default.
