# Validation — 16 September 2026

The service was first tested locally. On 16 September 2026 it was also built and tested in a Linux container on the Hetzner VPS, and the private browser onboarding service was started successfully.

## Real Jev API + Playwright smoke test

One fresh-browser run on a controlled local shop, with a product initially hidden until search. The complete task was search → add one exact item → open summary → independent verification → close browser. Jev additionally submitted the search with Enter. This uses the real Jev provider and real Playwright execution, with no live merchant or payment account.

| Measurement | Observed |
| --- | ---: |
| Result | Ready for review |
| End-to-end time, including browser launch/close | 5.792 seconds |
| Browser time | 4.385 seconds |
| Model time | 1.403 seconds |
| Jev calls / browser actions | 4 / 4 |
| Model returned | jev-1.13.0 |
| Input / output tokens | 2,156 / 196 |
| Estimated model cost | $0.000090552 |
| Orders submitted | 0 |

Price assumption: $0.042 per million input tokens, free output. This is an estimate from returned usage and published rates, not an invoice. Infrastructure cost is unmeasured. The compact action-based prompts here differ from the full-page inputs in the earlier Glovo benchmark, so costs and durations are not directly comparable.

## Automated checks

- 19 policy, provider, runner, HTTP API, persistence, account-lock and onboarding tests pass.
- Five real Playwright tests against the local shop pass: successful search/cart/summary completion, an over-budget total, an existing basket, wrong delivery address, and stale-control rejection.
- Docker Compose configuration validates. The full Docker image built successfully on the VPS; all five real Playwright browser tests passed there with Chromium sandboxing enabled, the pinned seccomp profile, 2 GB memory and a 2-CPU limit. The first test mount needed corrected directory permissions; the subsequent suite passed.
- Legacy evaluation code and previous benchmark reports are preserved.

The initial browser test fixture had a JavaScript quoting defect that rendered an empty page. The adapter correctly stopped with `cart_not_readable`. After repairing the fixture, the browser scenarios passed. Test fixtures are not evidence that all live Glovo markup is supported.

## Outstanding live checks

SSH to the user-supplied `root@100.117.208.119` was attempted both non-interactively and with the plain interactive SSH command. Both returned **Connection refused** on port 22 before authentication. No VPS changes were made during that attempt. A subsequent Tailscale device check established that this IP belonged to the laptop, not the VPS. The online VPS `buena-prod-01` is `100.121.5.10`; the deployment instructions have been corrected.

The read-only Glovo page-reader recheck initially required browser origin approval. The user explicitly approved it and the check then ran through the supported browser connector. The current Duży Ben view reports that the merchant is temporarily closed for the selected destination, with no product rows available. No account, address or basket was changed. This verified the closed-store state; it did not validate a new live cart or checkout. The adapter now reports `merchant_unavailable` for that state.

The new server profile still needs manual sign-in, exact destination setup and a live prepare-only run after deployment. The prior live Glovo benchmark remains in `../evaluation/REPORT.md` and used a different browser runtime.

Current VPS state: the isolated `jev-hackathon` Compose project is deployed under `/opt/jev-hackathon` on `buena-prod-01` (`100.121.5.10`). Its onboarding container completed account setup and exited cleanly. Both private Tailscale endpoints returned HTTP 200 from the Mac: port 6088 serves the browser desktop, and port 6089 serves setup confirmation. No public IP binding was added. Existing projects were not changed. This is currently a standalone Compose service on the Coolify host, not a resource registered in the Coolify dashboard.

Remaining gates: configure the API credentials and an available merchant, then start the prepare-only service with the saved account profile; run one exact three-drink task and inspect the final basket and metrics. Coolify dashboard registration and the live payment/Solana execution handoff remain separate steps.

## Home-address setup fix

The user completed sign-in but changed to a home delivery address and moved to a Glovo category page. The old finish flow still required the original office address and merchant page. With explicit read-only browser access approved by the user, the visible signed-in account and home address were verified. The private Jev configuration was updated; the legacy payment configuration was not changed.

Account onboarding now starts on the Glovo listings page when an expected visible account label is configured. It checks that name and the intended address, saves account setup separately from basket/store readiness, and shows specific error messages. The shopping runner retains its strict checks. The marker is bound to the configured address, account label, destination label and store by a digest. Browser signals are owned by the service during shutdown to close the persistent context cleanly.

The updated finish action returned HTTP 200 and saved the account configuration. Duży Ben was visibly unavailable for the selected home address; storeReady and basketVerifiedEmpty remain false. The final five Linux browser regression tests passed. No shopping action or purchase was performed during this fix.
