# Payment 3DS mail adapters

The agent supports the default fixture stub and a narrowly scoped AgentMail
reader. It does not call Nango, sign in to a human mailbox, send mail, or dump
an inbox. Both sources use the ignored `agent/out/otp.json` as the only handoff
to the browser flow.

## AgentMail

The implementation reuses the `AgentMailClient` pattern from the existing local
project at `/Users/buena/Code/omar-project/src/lib/agentmail.ts`. It is
hard-scoped to `fulfillment-demo@mail.buena.ai`; an arbitrary inbox address is
rejected. Add the API key only to the ignored `agent/.env`:

```dotenv
MAIL_SOURCE=agentmail
AGENTMAIL_API_KEY=local-secret-value
AGENTMAIL_INBOX=fulfillment-demo@mail.buena.ai
```

Verify the connection without a browser or payment:

```bash
npm run mail:check
```

This one-shot check fetches message metadata and prints at most five subject
lines. It does not fetch bodies, extract codes, or change mailbox state.

During a future 3DS challenge it lists fresh messages for at most 120 seconds,
loads full content only for the Apata and Altitude sender addresses, and parses
the content in memory. It never marks, deletes, forwards, or replies to mail.
The full body is never logged or persisted. A valid Apata message is reduced to
the minimal validated `otp.json`; an Altitude login OTP fails closed.

Other mail, including ordinary Wolt order updates, is ignored by the payment
OTP reader. A future order-status adapter may record sender, subject, timestamp,
and normalized status, but it must remain separate from the 3DS handoff and
must never persist whole email bodies.

Wolt account login is a separate in-memory path. When the configured Wolt
contact email is the dedicated AgentMail inbox, the browser may request a fresh
magic link. The reader accepts mail only from a `wolt.com` subdomain and opens
only an HTTPS URL whose host is `wolt.com` or a `wolt.com` subdomain. The link
and message body are never logged, written to `otp.json`, or persisted elsewhere.
The default wait is five minutes and can be set from 120–900 seconds with
`WOLT_LOGIN_TIMEOUT_SECONDS`. “Welcome to Wolt” is accepted as a login-mail
subject because Wolt uses it for some new-account magic links. If the wait ends,
the dedicated browser stays open so the human can paste a fresh link or finish
phone login in that same window; it is not closed automatically.
Set `WOLT_LOGIN_MODE=manual` when Wolt acknowledges a magic-link request but
does not deliver it. This changes only account login; `MAIL_SOURCE=agentmail`
continues to monitor Apata 3DS independently.

Pyszne temporary-account login is also separate from payment 3DS. With
`PYSZNE_LOGIN_MODE=agentmail`, the browser asks for the explicit
`PYSZNE ACCEPT TERMS AND LOGIN` confirmation before submitting the dedicated
inbox to `auth.pyszne.pl`. It snapshots old Pyszne/Takeaway/Just Eat messages,
then accepts only a fresh allowlisted sender containing either a `pyszne.pl`
HTTPS login link or a contextual six-character alphanumeric login code. The challenge stays in
memory and is never written to `otp.json`. Unknown senders, non-Pyszne links,
and ambiguous codes fail closed.

## Classification

Only these classes exist:

- `altitude_login_otp`: sender is
  `notifications@altitude.squads.xyz` and the message says “continue in
  Altitude.” This is an account-login code and is **never** submitted as payment
  3DS.
- `payment_3ds`: sender is `no-reply@apata.io` and the message says “confirm
  your payment.”
- `unknown`: every other sender or message shape. This fails closed.

An Apata payment fixture is parsed into:

```json
{
  "kind": "payment_3ds",
  "provider": "apata",
  "currency": "EUR",
  "amount": 24.9,
  "merchant": "WOLT",
  "otp": "123456",
  "from": "no-reply@apata.io",
  "ts": "2026-08-29T12:00:00.000Z"
}
```

The OTP must be exactly six digits. Before any future submission, the validator
also requires:

- the merchant to normalize to `WOLT`, `WOLTPL`, or the local config’s
  `merchant_descriptor`;
- currency and amount to match the explicit card charge in `quote.json` within
  half of one configured minor unit;
- the converted amount to remain under both `max_pln` values;
- the converted amount to remain within a 2.00 PLN buffer of `landed_pln`;
- a timestamp no older than the current payment attempt.

Generated Kraków quotes currently bind PLN directly. Any different card
currency fails closed unless the quote explicitly supplies its three-letter
code, decimal exponent, exact charge amount, and
`settlement_units_per_charge_unit`; the parser never guesses an exchange rate. The artifact shape is currency-neutral
for future regional adapters, including zero- and three-decimal currencies.

## Manual fixture simulation

With no payment and no browser required, run the parser tests:

```bash
cd agent
npm test
```

To simulate a future handoff, copy the synthetic Apata fixture into the only
handoff path by hand:

```bash
mkdir -p out
cp fixtures/apata-3ds.txt out/otp.json
npm run otp:dry-run
```

Copy it after the simulated attempt starts so the file modification time is
fresh. The stub reader accepts raw fixture text, validates it against the local
config and `out/quote.json`, then rewrites `out/otp.json` as the minimal JSON
object above. It never persists a full live email body.

The dry-run command only classifies and prints the synthetic parsed fields. It
requires both payment flags to be false and never opens a browser. A hand-written
JSON object without `from` cannot authenticate the sender, so it correctly
classifies as `unknown`; copying the raw fixture is the supported simulation.

If no valid handoff appears within 120 seconds, either source fails closed and
tells the human to complete 3DS manually on the phone.

Even a valid payment OTP is typed only when all of these remain true:

- `ALLOW_PAY=true`
- `ALLOW_3DS_SUBMIT=true`
- the human confirms the immediate `SUBMIT OTP` prompt

Both flags remain `false` in `.env.example`. The documented dry run executes
`npm run checklist` and `npm run order:prepare`, and stops before payment.
