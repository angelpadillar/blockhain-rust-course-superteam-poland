# Multilogin + Jev login pilot

Login-only internal growth tooling, separate from the Colosseum shopping application. The worker imports up to six Instagram or YouTube accounts, creates one cloud Multilogin profile per account, uses an included premium proxy, and attempts login with locally generated authenticator codes. Jev chooses among observed actions; code enters credentials and verifies the expected signed-in identity. Posting belongs to upload-post.com and is outside this worker.

Live results, 19 September 2026: the first Instagram account completed login and restart verification in 30.6 seconds with one Jev call. A subsequent five-profile concurrent batch finished in 41.1 seconds: four accounts passed login and restart verification; one reached an Instagram verification checkpoint. The batch used zero model calls. See [observed results and limitations](VALIDATION.md). The one-shot supplied-account script disables merchant visits for the current login-only scope.

The current implementation was reviewed against the supplied `JEV-BROWSER-MULTILOGIN-HANDOFF.md`, the current `captions-editor-camoufox/src/jev.mjs`, `AutomationBridge`, and the video coordinator. It adapts their finite-choice validation, exact single-match shortcut, private durable receipts, exclusive ownership, fresh-target checks and independent verification. The login policy is separate from the editor policy. It uses Playwright's supported Multilogin attachment rather than assuming gomoufox compatibility. The Captions package/profile and frozen payment implementation were not changed. See `IMPLEMENTATION-NOTES.md` for source provenance and remaining differences.

## Current implementation

- Cloud Mimic profiles on the VPS, with durable account-to-profile mappings.
- Optional character binding: `characterId → platform → accountHandle → profileId → setupStatus`, stored in the same private state file. Credentials are excluded from that registry. Conflicting bindings stop before another profile is created.
- Instagram `Username;Password;2FA Live Key` imports and structured Instagram/Google account records.
- One fresh sticky premium proxy per new profile. The pilot defaults to Poland; `proxyCountry` overrides it per account. Multilogin requires a country even for accounts sold as global.
- At most one proxy replacement for a concrete network/proxy failure, retaining the same profile. Wrong passwords, verification challenges, restrictions, HTTP 403/429 and ambiguous page timeouts pause for inspection.
- Ordinary Amazon.pl and eBay homepage visits after a verified login. These are recorded as visits; site cookie consent or successful cookie creation is not assumed. No cookies are fabricated or imported.
- Stop/reopen and independent account verification before reporting a completed account.
- Private state, exclusive worker lock, lifecycle checkpoints and redacted reports. Unknown results do not silently create duplicate profiles.
- Up to five account workers run concurrently. A registry lock prevents competing batches, each account owns separate lifecycle records, and duplicate browser-control endpoints are rejected before credentials can cross profiles.
- Known username/password forms follow a fixed field order; Jev is a fallback for ambiguous permitted choices. A blocked account is recorded independently while other workers continue.

This is a bounded CLI/library pilot, not a universal browser agent or a public job API. Account-page variants need live validation. TikTok, Hotmail and fviainboxes.com mailbox-code retrieval are not yet implemented. Email/SMS, passkeys, CAPTCHA, account restrictions, registration and consent/setup screens request attention. The account record can retain a recovery-email address, but that alone does not grant mailbox access.

## VPS installation

Dedicated directory: `/opt/buena-multilogin` on `100.121.5.10`. Compose project: `buena-multilogin`. The official Multilogin launcher image is pinned by digest. The worker shares its private network namespace and attaches to the browser port returned by Multilogin. Launcher ports 45001 and 45003 bind to VPS loopback only. Existing services and account profiles are separate.

```sh
docker compose up -d launcher
docker compose build worker
docker compose run --rm -T worker doctor --config config.vps.json
```

Cloud profile data persists with Multilogin after a clean stop. Back up the entire private state directory, including `profiles.json` and `accounts/<account-id>/profiles.json`; losing mappings can cause a future import to create another profile. The launcher currently caches downloaded browser cores in its container filesystem. Recreating the container can require another core download. Its resource limit was increased in place to six CPUs and 12 GiB for the batch; the worker uses two CPUs and 1 GiB. Use `docker compose run --no-deps` with the already running launcher to avoid an unintended recreation. On a fresh install, wait for the core download to finish and reconcile any failed first launch before starting account jobs.

## Account import

Keep real account files under `private/` with mode 600. On the VPS, the directory is mode 700 and owned by worker UID 1000. Keep passwords and authenticator seeds out of shell arguments, source control and reports.

For Instagram, each line contains exactly three fields:

```text
USERNAME;PASSWORD;BASE32_AUTHENTICATOR_SECRET
```

Double-quote a field containing a semicolon; double any literal quote within a quoted field. Password whitespace is preserved. A blank third field means no authenticator seed is available. A raw Base32 secret or `otpauth://totp/...` URI is accepted; third-party code-generation URLs are not used. Google/YouTube usernames must be the Google account email, not a channel handle. JSON imports support `platform`, `username`, `password`, optional `characterId`, `totp`, `recoveryEmail`, and `proxyCountry`. See `accounts.example.json` for the shape; replace its placeholders before use. Delimited accounts remain unassigned to a character until their explicit binding is supplied in JSON; the worker does not invent character IDs.

Validate without network calls or printing account credentials:

```sh
docker compose run --rm -T worker plan --config config.vps.json --accounts /data/accounts.txt --platform instagram
```

## Run a pilot

`scripts/run-private.mjs` takes a single JSON line from a trusted caller or secret manager on stdin: `multiloginToken`, `typesafeKey`, and optional `concurrency` (1–5). Credentials stay in worker memory and are not written to Docker environment metadata. Account credentials come from the private import file. `scripts/login-memory.mjs` instead accepts an `accounts` array on the same stdin line, avoiding an account file; it disables merchant visits and checks that the token has at least eight minutes remaining before it changes profiles.

```sh
docker compose run --rm --no-deps -T --entrypoint node worker scripts/run-private.mjs /data/accounts.txt instagram /data/state
```

Pipe the secret JSON into that command; do not paste it into an echo command or shell history. The script prints account hashes, profile IDs, outcomes and private report paths. Its programmatic entrypoint is `runConcurrentBatch` in `src/batch.mjs`, which uses the existing `runBatch` lifecycle for each account. The CLI supports `--concurrency 5`. Reuse the same state directory and account identity on later runs. Existing sequential mappings migrate on use; account-worker records are authoritative after an interrupted run and the old direct sequential entrypoint is blocked against a migrated root registry.

The local CLI also accepts keys already present in `MULTILOGIN_TOKEN` (or `MULTILOGIN_AUTOMATION_TOKEN`) and `TYPESAFE_API_KEY`, for `node cli.mjs run --config ... --accounts ... --platform instagram`. No keys are included in this deployment. A short-lived sign-in token can perform initial API tests; unattended operation needs an operator-configured automation token. Creating or saving that persistent credential was not performed in this task.

## Several accounts as independent jobs

`batch-runner.mjs` runs a job file instead of one platform import. Each job names a platform and references an account and a profile (`accountRef`, `profileRef`); credentials stay in the existing private store and are never passed as arguments. Up to six jobs are accepted and `--concurrency` bounds the workers.

```sh
docker compose run --rm --no-deps -T worker node batch-runner.mjs /data/jobs.json --config config.vps.json \
  --accounts /data/accounts.json --data /data/state --concurrency 2
```

```json
{"jobs": [{"id": "youtube-01", "platform": "youtube", "accountRef": "yt-account-01", "profileRef": "yt-profile-01"}]}
```

Check the plan before touching a profile. A dry run reads the job file, the private accounts and the existing profile references, prints the resolved profiles and conflicts, and takes no lock, creates no directory and starts no browser. It exits 2 when the plan is blocked:

```sh
node batch-runner.mjs jobs.json --dry-run --accounts private/accounts.json --data private/state
```

Each job owns one profile, one browser, one profile lock and one log directory (`<data>/jobs/<job-id>/`), so two jobs cannot share a profile or mix their evidence. A job that reaches a security checkpoint is reported as `waiting_for_human`: the browser is held open for a person, the wait is logged as a transition, the time spent waiting does not consume the login budget, and other workers keep running. The automation only observes and waits; it never answers a challenge, fills a challenge field or changes proxy or browser identity. Without `--preserve-on-checkpoint` the profile is still stopped and reconciled when the wait times out, so the mapping can be rerun.

## ONE command per job

`job-runner.mjs` owns a single job end to end: it resolves or creates the intended
profile, verifies its proxy, starts the profile, takes the launcher-returned CDP
endpoint, attaches Playwright, inspects the authenticated state, resumes instead
of re-logging-in when the session persisted, runs the deterministic flow with
bounded JEV recovery for ambiguous states, detects a verification checkpoint,
announces it on Telegram, waits for the person, resumes after the challenge is
genuinely gone, verifies YouTube Studio, restarts the profile, proves restart
persistence and writes a structured `result.json`. From the repository root:

```sh
npm run browser:job -- jobs/yt-live-05.json                # run beside the launcher / worker image
npm run browser:job -- jobs/yt-live-05.json --remote       # run on the VPS over SSH, mirror evidence
npm run browser:job -- jobs/yt-live-05.json --remote root@host
npm run browser:job -- jobs/yt-live-05.json --fake         # offline lifecycle proof, no account, no model spend
npm run browser:job -- jobs/yt-live-05.json --dry-run      # plan + resume inspection, no browser
npm run browser:batch -- jobs/youtube-live-batch.json --concurrency 2
```

Remote mode copies the job file to `/opt/buena-multilogin/private/jobs/`, runs
`job-runner.mjs` in the existing `worker` service (the one that shares the
launcher's network namespace), streams the NDJSON lifecycle, and mirrors
`private/state/jobs/<job-id>/` back to `.browser-jobs/<job-id>/`. After a change
to the worker sources, build once with `--build` (or
`docker compose build worker`). Live runs resolve secrets in this order:
`--stdin-secrets` JSON line, `MULTILOGIN_AUTOMATION_TOKEN` / `MULTILOGIN_TOKEN`
(and `TYPESAFE_API_KEY` / `FIREWORKS_API_KEY`), then the mode-600 files
`private/multilogin-token` and `private/typesafe-key`. Secret values are never
printed and never enter a job file, log or report.

The run is governed by the formal lifecycle (`PENDING`, `PROFILE_READY`,
`BROWSER_ATTACHED`, `AUTH_CHECK`, `LOGIN_IN_PROGRESS`, `WAITING_FOR_HUMAN`,
`AUTHENTICATED`, `STUDIO_VERIFIED`, `PERSISTENCE_CHECK`, `COMPLETE`, `FAILED`,
`CANCELLED`). Every transition and action is durable in
`<data>/jobs/<job-id>/lifecycle.json` + `lifecycle.ndjson` with the observation,
selected action, action source (`deterministic`, `jev`, `frontier`, `operator`,
`human`), result, verification, elapsed time and recovery counters. On a
security checkpoint the same process announces the job's own frame on Telegram,
accepts `/status`, `/done` and `/cancel` while it waits, and resumes the live
flow only after its own re-observation shows the challenge is gone; `/done` alone
never resumes anything. A timed-out checkpoint ends in `WAITING_FOR_HUMAN` with
the profile mapping and session preserved; rerunning the same command reopens the
same profile (`resumedFrom` in `result.json`) rather than creating anything.

At a checkpoint the capture is a bundle, not one frame: the canonical native
viewport PNG (unchanged bytes), a full-page PNG, a focused challenge-region PNG
when one is detectable, and a `-context.json` sidecar with URL (origin+path),
title, visible-text summary (through the account redactor), viewport, device
pixel ratio, timestamp and job/profile identity. Telegram receives the canonical
PNG as a photo preview plus the byte-identical PNG as a document, so the fine
detail survives Telegram's own recompression. The focused crop is gated by the
visibility and stability rules ported from the VPS canary checkpoint work: a
challenge frame parked off-screen (reCAPTCHA bframes sit at y=-9999) or smaller
than a real panel is never cropped, and a frame that moves between two bounded
measurements is skipped rather than captured half-painted. The dialog guard from
the same work contains Playwright's stale-dialog race so it cannot kill a job.

## Existing-proxy (degraded) mode

When Multilogin's premium-proxy provisioning is unavailable but a profile already
carries its assigned proxy, the safe path is:

```sh
npm run browser:job -- jobs/youtube-live-01.json --reuse-existing-proxy
```

In this mode the orchestrator proves from read-only profile metadata that a proxy
is attached (`proxy_masking: custom`), and then refuses every provisioning and
rotation path: no `premiumProxy`, no `changeProxy`, no profile modification, and
no silent fallback to a proxy-less browser. If the launcher refuses to start
because it cannot validate the assigned proxy, the run fails closed with the
launcher's own reason and stops; the profile mapping and session are preserved.
The result records `proxy.reuseExistingProxy`, `proxy.verifiedAttached` and
`proxy.rotations: 0`. See `PROXY-403-DIAGNOSIS.md` for the live diagnosis this
mode was built from.

Decision evidence is recorded in **observation mode**: every live decision writes
a `router-observations.ndjson` line with the state class, candidate capabilities,
the deterministic-first choice, the executed decision, the source
(`deterministic` / `jev`) and the outcome, while the router never alters
execution (`executionChanged: false`). Recovery memory adds telemetry only
(recalls, considered episodes, bytes, retrieval latency, and whether the recalled
correction matched the one that eventually worked); the injected count stays at
most two compact episodes and no transcripts or page text are ever stored.

`--fake` runs the real orchestrator, login adapter, recovery layer, checkpoint
hook, Studio verification and restart persistence against an offline provider
fixture and a local headless browser. It simulates the person clearing the
challenge, creates no account, makes no network call and spends no provider
budget. Recovery episodes can be remembered in a compact causal store under
`<data>/memory/`: state, failed action, correction and verification only, with at
most a couple of relevant episodes recalled into a model request; page text,
credentials and query strings never are.

## Recovery and evidence

Reports distinguish authentication failure, unsupported screens, transport failures, Jev uncertainty, account-identity mismatch and lifecycle reconciliation. A `pending` lifecycle marker or stale `run.lock` requires inspecting the actual profile/process state before clearing it. Never delete the mapping to retry a failed login. The dedicated smoke-profile reconciliation command is operator tooling and does not reset purchased-account state.

Step/time limits bound each login attempt, with separate finite network timeouts. They are not an exact total job wall-clock deadline. Concurrency defaults to one and can be set to five. The batch never asks interactive user questions: unsupported or unresolved accounts retain a result for later handling while other jobs finish. Browser takeover and a general checkpoint-solving service remain separate work. Identity heuristics are intentionally strict and may report attention on legitimate unfamiliar layouts.

```sh
npm test
npm run test:browser
```

`test/human-checkpoint.e2e.mjs` drives the checkpoint hook and the job runner against a real headless browser and a local provider fixture: a person clears the challenge in the browser the job is holding, the run resumes, and a second job finishes while its sibling waits. `test/orchestrator.e2e.mjs` runs the whole `browser:job` lifecycle in fake mode: checkpoint and Telegram announce, human clearance, Studio verification, restart persistence, a timed-out checkpoint that resumes on the same profile, and an authenticated session that resumes without resubmitting credentials. `test/lifecycle.test.mjs`, `test/orchestrator.test.mjs`, `test/screenshot-bundle.test.mjs`, `test/recovery-memory.test.mjs` and `test/action-router.test.mjs` cover the state machine, the restart/resume inspection, the Telegram command loop, screenshot dimensions/integrity and the tool-routing boundary. Nothing in the suite reaches a live account.

Browser tests use isolated local fixtures and a deterministic decision function, not live Jev or social accounts. The infrastructure smoke script uses the actual Multilogin browser and can call real Jev when its key is supplied. See `VALIDATION.md` for observed results and remaining gaps.

Verified vendor references: [Multilogin API collection](https://documenter.getpostman.com/view/28533318/2s946h9Cv9), [Docker launcher](https://multilogin.com/help/en_US/getting-started-with-multilogin-x-automation/run-in-docker), [Playwright integration](https://multilogin.com/help/en_US/puppeteer-selenium-and-playwright/playwright-automation-example), [TypeSafe API](https://docs.typesafe.ai/api).
