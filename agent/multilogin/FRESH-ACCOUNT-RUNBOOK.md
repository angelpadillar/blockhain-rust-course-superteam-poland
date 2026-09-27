# Clean-install / rotation runbook (2026-09-25)

Operational procedure for rebuilding a browser identity for an existing account
without creating or deleting accounts, and for reconciling stale worker state.

## Security boundary

The automation does the whole login: consent dialog, username, password,
authenticator (TOTP), submit and verification. The **only** human step is a
genuine Google/YouTube security challenge (reCAPTCHA). Challenges are never
answered, solved, outsourced or deliberately triggered; the job captures the
evidence bundle, waits, and resumes only after its own re-observation shows the
challenge is gone. Nothing here fabricates cookies or imports sessions.

## Tools

| Tool | Purpose |
|---|---|
| `scripts/rotate-profile.mjs` | operator-approved clean install: archives the old profile mapping in **all three** stores and releases the ref; the old Multilogin profile is preserved |
| `scripts/reconcile-profile.mjs` | clears a stale `pending` lifecycle marker only after the launcher proves the profile is `stopped`/`start_browser_error` and not in use |
| `scripts/label-profile.mjs` | sets a readable profile name while proving fingerprint/proxy/parameters did not move |

All three write backups and an audit record (`rotations.ndjson`,
`reconciliations.ndjson`); none prints credentials or proxy data.

## Clean install, step by step

```sh
# 1. Rotate the browser identity (archives every mapping; new profileRef below).
docker compose run --rm --no-deps -T \
  -v /opt/buena-multilogin-orchestrator/scripts/rotate-profile.mjs:/app/scripts/rotate-profile.mjs:ro \
  --entrypoint node worker scripts/rotate-profile.mjs \
  --data /data/account-pilot --accounts /data/accounts.json \
  --account-ref yt-live-04 --confirm-rotate --reason "clean install"

# 2. Run the fresh job (headed so a challenge is visible on VNC; new profile and
#    a new premium proxy are created on first run).
npm run browser:job -- jobs/youtube-live-04-fresh.example.json --remote \
  --config src/config.headed.json --human-checkpoint-seconds 3600

# 3. If a stale pending marker blocks a later run (worker crashed mid-start):
docker compose run --rm --no-deps -T \
  -v /opt/buena-multilogin-orchestrator/src:/app/src:ro \
  -v /opt/buena-multilogin-orchestrator/scripts/reconcile-profile.mjs:/app/scripts/reconcile-profile.mjs:ro \
  --entrypoint node worker scripts/reconcile-profile.mjs \
  --data /data/account-pilot --accounts /data/accounts.json \
  --account-ref yt-live-04 --profile-id <profile-id> --confirm-reconcile

# 4. Label the profile for the operator.
docker compose run --rm --no-deps -T \
  -v /opt/buena-multilogin-orchestrator/src:/app/src:ro \
  -v /opt/buena-multilogin-orchestrator/scripts/label-profile.mjs:/app/scripts/label-profile.mjs:ro \
  --entrypoint node worker scripts/label-profile.mjs \
  --profile-id <profile-id> --name "YT-04 | HUMAN | security verification"
```

## Behaviour fixes that made the automated login possible

- **Consent dialog**: a fresh profile lands on YouTube's "Before you continue"
  interstitial. The login loop now detects it (`isConsentScreen`) and clicks the
  dialog's own reject/accept button (`dismissConsent`) before any credential
  step. It is not a security control, so it is not a human checkpoint.
- **Sign-in click**: YouTube's masthead "Sign in" anchor can be covered by an SPA
  overlay; `clickWithNavigationFallback` navigates to the anchor's own href when
  its origin is already an allowed credential origin.
- **Post-auth interstitials**: Google's optional onboarding surfaces
  (`myaccount.google.com/interstitials/*`, `gds.google.com/web/recoveryoptions`,
  `gds.google.com/web/landing`) are skipped by navigating to the site home.
  Recovery/account settings are never filled — account configuration is not ours
  to change.
- **Submit click**: Google's "Next" button can sit under a transient "Loading"
  overlay. A verified submit now gets actionability headroom and, if the pointer
  is still swallowed, presses Enter with the button focused (the keyboard path a
  person uses).
- **Duplicate links**: identical link destinations collapse to one candidate, so
  two "Sign in" anchors stay a deterministic single match instead of forcing an
  uncertain model call.
- **Provider**: `deepseek-v4p1-flash` is a reasoning model; `max_tokens` default
  raised to 2048 and an empty-reasoning-only response now raises
  `provider_reasoning_only` instead of a generic parse failure.
- **Headed runs**: `config.vps.json` sets `headless: true`; use
  `src/config.headed.json` when a human may need to see the browser over VNC.
- **Wrapper**: `--human-checkpoint-seconds` (and any passthrough flag following
  another flag) was silently dropped; fixed with a regression test.
- **Mirror**: remote job evidence now mirrors from the host path
  (`<deploy>/private/account-pilot`) instead of the container path.

## State stores touched by rotation

1. `accounts/<accountId>/profiles.json` — child mapping used by the batch resolver.
2. `profiles.json` (root) — sequential-flow state; consulted during resolution.
3. `profile-refs.json` — ref → profileId registry; released for the account.

Archiving only the child file is insufficient: the root state re-supplies the
old profile. Always rotate all three (the tool does).
