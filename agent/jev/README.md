# Jev browser adapter for the Superteam hackathon

A separate, prepare-only service for the existing fulfillment agent. Typesafe Jev chooses from a small set of validated actions; Playwright runs those actions in a dedicated persistent Chromium profile. The first merchant adapter supports the Polish Glovo storefront in Kraków. It searches exact products, builds a basket and opens the final order summary. It never calls the legacy payment, OTP, wallet or Solana transaction code.

The user-requested homepage-to-product evaluation measures navigation from the Kraków homepage to the configured Foczka product detail without adding anything. `npm run evaluate:navigation -- --runs=3` launches fresh browser contexts; `npm run evaluate:navigation:desktop` on the Linux server preserves the same live tab after manual confirmation. The preserved adapter completed the route in the [original comparison](benchmarks/method-comparison/REPORT.md). The [new speed-candidate benchmark](benchmarks/navigation-speed-v2/REPORT.md) retains all successes, prompt regressions and intermittent Glovo errors; it does not yet establish a candidate speedup. [NAVIGATION-REPORT.md](NAVIGATION-REPORT.md) retains the earlier setup history and launch instructions.

The saved [project direction](PROJECT-DIRECTION.md) defines prompt/task execution, instruction following and expansion beyond Glovo. Navigation now uses a validated task contract and separate merchant/product stages. Both evaluation modes save private per-run journals in `data/navigation/runs/` before browser actions, including requests, returned probabilities/confidence, timing and verification. Interrupted journals are retained and marked for inspection on the next locked run. The `instruction` field records the request; executable task fields control this Glovo adapter.

An isolated [continuous browser candidate](experimental/browser-runtime-v4/README.md) now adds an inexpensive OpenRouter goal planner and up to four native search/link-opening operations, with Jev for semantic choices. [V3 measurements](benchmarks/browser-runtime-v3/REPORT.md) retain the completed fixture comparison, screenshot experiment and provider timeout. This experimental work does not replace the deployed Glovo service or its configured task contract.

## What is implemented

- One configured merchant and delivery destination per service, with manual account onboarding.
- Authenticated HTTP jobs, an explicit spending cap, idempotency keys, cancellation and a bounded queue. A single account processes one job at a time.
- Exact-product additions, search and opening the summary. Checkout itself is read-only. Uploads and payment actions are not available to Jev.
- Independent checks of products, quantities, destination, merchant, visible total and budget before reporting `ready_for_review`.
- Per-job wall time, browser time, model time, token usage, model version and estimated model cost. Failed attempts remain in job records. Network failures make billing incomplete rather than reporting a known final cost.
- An expiring payment intent containing PLN minor units and a SHA-256 digest, for a later separately authorized payment integration.
- Docker Compose configuration for a separate Coolify service, plus optional private browser onboarding through an SSH tunnel.

This is a hackathon pilot, not a universal checkout agent. Merchant markup and locales are adapter-specific. CAPTCHA, expired login, unsupported product options, unreadable totals, an existing basket or changed destination stop the job for operator attention. The service leaves the prepared basket in the account. Clear it manually before starting another job; it never guesses whether existing items may be removed.

## Local setup

Use Node.js 22 or newer. This package is intentionally separate from the legacy agent's dependencies and payment environment.

```sh
cd agent/jev
npm ci
npx playwright-core install chromium
cp config.example.json config.local.json
```

Edit `config.local.json`: set the exact merchant URL, merchant name, expected visible delivery street and number, and a destination label. Match `destinationLabel` to the legacy config's `venue_label` if using the bridge command. The example address deliberately prevents startup until replaced. Do not commit the local config.

Sign in using this service's dedicated profile. This does not use or copy your everyday Chrome profile:

```sh
npm run onboard
```

Select the configured delivery address, then confirm in the terminal. Setup is checked against the rendered page. If private configuration includes `expectedAccountLabel` (the exact visible signed-in profile name), account setup can finish on a Glovo category page without requiring a particular store to be open. Otherwise, open the configured store and clear the basket for the original strict setup flow. Never run onboarding and the service simultaneously; they share an exclusive account lock.

Set secrets in your shell, secret manager or Coolify. `npm start` deliberately does not load `agent/.env`, which contains unrelated payment secrets. Compose reads its own `.env` file. Generate a service token with:

```sh
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Export `TYPESAFE_API_KEY` and `JEV_SERVICE_TOKEN`, then run:

```sh
npm start
```

The API listens on `127.0.0.1:8787` by default. `JEV_CONFIG`, `JEV_DATA_DIR`, `JEV_HOST`, `JEV_PORT`, and optional `JEV_BROWSER_CHANNEL=chrome` are runtime overrides. Chromium's sandbox is enabled; do not disable it on the VPS.

## Connect the existing fulfillment agent

From `agent/`, with the service token set and an exact-item Glovo config:

```sh
npm run order:prepare:jev
```

`JEV_SERVICE_URL` defaults to `http://127.0.0.1:8787`. Use an SSH tunnel for the VPS. The command sends only approved item names, quantities and the budget, then saves the returned job to `agent/out/jev/<job-id>.json`. It never overwrites the legacy quote or paid artifacts. Set `JEV_IDEMPOTENCY_KEY` to reuse a submission safely after an interrupted client session. A pending or failed job exits nonzero.

For the three-drink sample without the legacy config, use `npm run demo` inside this package.

## API

All `/v1/*` routes require `Authorization: Bearer <JEV_SERVICE_TOKEN>`. No cross-origin browser access is enabled. `GET /healthz` is a minimal liveness check; authenticated `/v1/status` reports whether onboarding has been recorded. Browser/account readiness is verified again at the start of each job.

| Route | Purpose |
| --- | --- |
| `GET /v1/status` | Merchant, destination label, policy cap, onboarding and queue status |
| `POST /v1/jobs` | Submit exact items and budget; `Idempotency-Key` is required |
| `GET /v1/jobs` | Last 50 persisted jobs |
| `GET /v1/jobs/<id>` | Result, verification checks, metrics and payment intent |
| `POST /v1/jobs/<id>/cancel` | Cancel a queued or active job |

Example submission body:

```json
{
  "items": [{ "query": "Tymbark Napój owocowy jabłko mięta 1 l", "qty": 1 }],
  "maxPln": 26
}
```

There is deliberately no purchase endpoint or `allowPay` option. Model confidence is not used as proof of a correct checkout. The model cannot send arbitrary selectors, JavaScript, URLs, addresses, credentials or payment data to the browser. Full page snapshots, cookies and account details are not sent to Jev; it receives approved shopping data and candidate action descriptions.

## Coolify / Hetzner deployment

Deploy `agent/jev` as a separate Docker Compose application on the existing VPS. It does not require replacing the other projects or changing their ports. Resource limits are 2 CPUs and 2 GB RAM for this pilot. The container runs as a non-root user, with Chromium sandboxing and the official Playwright seccomp profile pinned to version 1.62.1.

1. Upload this directory or select it as the build/base directory in Coolify. Keep the package lock and seccomp profile with the Compose file.
2. Create the private `config.local.json` on the server at the Compose bind-mount path. Store `TYPESAFE_API_KEY` and a strong `JEV_SERVICE_TOKEN` as Coolify secrets.
3. Keep `jev-data` as persistent storage. It holds the dedicated signed-in profile and private job results; do not share it with another replica. Do not expose Chromium debugging ports.
4. Before the first shopping run, stop `jev-browser` and start the optional onboarding service using the same project/volume. Both use the same profile lock.

For a standalone Compose checkout, those commands are:

```sh
docker compose stop jev-browser
docker compose --profile onboarding up -d onboarding
```

For a Coolify-managed checkout, run the equivalent commands in its generated Compose project so the named volume is the same. Coolify may generate project names; do not accidentally create a second empty volume with an unrelated manual project.

The default binding is loopback. For direct access over Tailscale, set `JEV_BIND_IP` to the VPS's verified Tailscale IP in the Compose environment (for this server, `100.121.5.10`). Then open `http://100.121.5.10:6088/vnc.html?autoconnect=1` and `http://100.121.5.10:6089/` from a device on your tailnet. Do not set this to `0.0.0.0` or the public server IP: the onboarding desktop has no separate login. The API still requires its bearer token. The onboarding service can run before API credentials are supplied; starting the API without credentials fails.

For the default loopback binding, use an SSH tunnel. From your computer, forward the private onboarding ports:

```sh
ssh -L 6088:127.0.0.1:6088 -L 6089:127.0.0.1:6089 root@100.121.5.10
```

Open `http://127.0.0.1:6088/vnc.html?autoconnect=1` to sign into Glovo on the server. Set the configured destination and merchant and empty the basket. Open `http://127.0.0.1:6089/` on your computer and click **Verify setup and close browser**. It verifies the selected address and visible signed-in account before saving account setup. Store and basket readiness are recorded separately. Each shopping job still independently requires the configured store, matching address and an empty basket. These unauthenticated desktop ports must remain on VPS loopback or the private Tailscale interface; no public Coolify domain should route to them.

Then stop onboarding and start the API:

```sh
docker compose --profile onboarding stop onboarding
docker compose up -d jev-browser
```

Access the API over a private tunnel:

```sh
ssh -L 8787:127.0.0.1:8787 root@100.121.5.10
```

For any later public API exposure, use Coolify HTTPS and preserve the bearer-token requirement. The Compose default publishes only on localhost.

After a clean shutdown the profile lock is released. After a hard crash, the service intentionally stops on a stale `data/profile.lock`. Confirm both containers and their Chromium processes are stopped, then remove only that lock directory inside the persistent volume before restarting. Incomplete jobs are marked `needs_attention` after restart and are never replayed automatically. Account session expiry requires onboarding again.

## Solana handoff

`intent` is a proposal, not a payment authorization, signature, receipt or on-chain proof. Its digest binds the proposed contents for review but does not authenticate the service. It expires after five minutes and the browser closes after preparing it. A payment executor must reopen and revalidate the merchant basket, price and destination, obtain the separately authorized spending approval, and then use the existing payment/settlement flow. This service cannot sign transactions and contains no wallet keys or currency conversion assumption. That execution handoff remains a separate implementation step after the server browser pilot is verified.

## Validation and cost

```sh
npm test
npm run test:browser
node scripts/live-smoke.mjs
```

The last command uses real Jev requests against a controlled local shop and requires the Typesafe key. It does not visit a live merchant. Tests create fresh temporary browser profiles and delete them afterward. For installed Chrome, prefix browser test commands with `JEV_BROWSER_CHANNEL=chrome`.

See [VALIDATION.md](VALIDATION.md) for measured results and remaining deployment checks. Published Jev rates are configurable; the default is $0.042 per million input tokens with free output. The cost limit is a stop condition after a response, not a provider-enforced billing ceiling. An in-flight request can cross it. Infrastructure, failures with unknown usage, account setup and operator work are additional costs.

The earlier three-drink live Glovo pilot is preserved in [the evaluation report](../evaluation/REPORT.md). Its approximately 10.6 seconds / $0.00135 average is a different task and runtime from this service's local smoke test. Neither result establishes reliability across most websites.

The separate homepage-to-product navigation case completed **3/3 live attempts on 17 September 2026**, with a median of **13.589 seconds** and **$0.00031479 estimated Jev cost per attempt**. It opens the exact product without changing the basket or purchasing. See the [browser-method comparison and saved results](benchmarks/method-comparison/REPORT.md) for source revisions, failed attempts, the product-view request correction, timing scope and limitations. The stock Ultrafast text-helper comparison remains a separate unfinished experiment.

Primary references: [Typesafe quickstart](https://docs.typesafe.ai/introduction/quickstart), [Jev launch and pricing](https://typesafe.ai/blog/introducing-system-one-models-and-jev), [Playwright persistent contexts](https://playwright.dev/docs/api/class-browsertype#browser-type-launch-persistent-context), [Playwright Docker guidance](https://playwright.dev/docs/docker). `seccomp_profile.json` is from the [Playwright v1.62.1 source](https://github.com/microsoft/playwright/blob/v1.62.1/utils/docker/seccomp_profile.json), Apache-2.0 licensed.

## Changing the test destination

The private Jev configuration is independent of the legacy payment configuration. Update `expectedAddress`, `destinationLabel`, and, when using account-only onboarding, `expectedAccountLabel` in `config.local.json`. The finish page shows the expected settings and reloads approved configuration changes without requiring another sign-in. A changed address invalidates an earlier onboarding marker until verified again. Detailed errors distinguish a wrong address, missing account, wrong page, existing basket and unavailable store.

The current private deployment uses the user-approved **Home test** destination. Account setup is saved. Duży Ben was unavailable there during verification; choose an available merchant before the next shopping evaluation. Shopping actions remain restricted to the configured store. The legacy bridge continues to enforce its destination-label match, so do not run it against a different destination without explicitly aligning the test configuration.

## Experimental navigation speed comparison

The default adapter is unchanged. `node scripts/navigation-compare-v2.mjs --key-stdin --repeat-confirmed-age` runs the separate baseline/candidate protocol using the configured private profile; supply the API key through hidden stdin. It is scoped to the existing authorized navigation case. Candidate v2 retains real element identities, bounded pre-dispatch stale recovery and faster readiness conditions while reusing the exact baseline model prompt. V1 remains available for reproducing its recorded decision regression. See the [report and complete attempt accounting](benchmarks/navigation-speed-v2/REPORT.md).

Use `node --test tests/navigation-candidate*.e2e.mjs` for candidate browser fixtures; prefix with `JEV_BROWSER_CHANNEL=chrome` to use installed Chrome. The standard `npm test` includes all candidate unit tests.
