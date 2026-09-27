# Browser runtime handoff — 2026-09-25

## Update — automated fresh installs completed (later on 2026-09-25)

**YT-04 and YT-05 are both GOOD_PERSISTED on brand-new profiles.** The whole
login ran automatically — YouTube consent dialog, "Sign in", Google email, Next,
password and authenticator (TOTP), plus the recovery-options interstitial — with
**one** human step per account: Google's own reCAPTCHA, cleared by the operator
and journaled as `VERIFIED_HUMAN_ESCALATION`. Both results:
`login ✓, reopen ✓, studio ✓, studioAfterRestart ✓, restartPersistence ✓`,
labels `YT-04 | GOOD | Studio verified` and `YT-05 | GOOD | Studio verified`,
new profiles `ab12927a-00af-4af1-8a35-1a060392a8fc` and
`65824833-49da-48ee-9eca-418df3ce3538` (fresh proxy/IP, zero cookies). YT-01/02/03
keep their proven sessions: the canonical table now reads **GOOD: 5**. The
BAD/UNKNOWN rows in the CLI are the archived pre-rotation profiles.

New operator tooling (all audited, backups + ndjson records; no secrets printed):

- `scripts/rotate-profile.mjs` — clean install: archives the old mapping in all
  three stores (account child, root state, profile-refs) and releases the ref;
  old profiles are preserved, never deleted.
- `scripts/reconcile-profile.mjs` — clears a stale `pending` marker only after
  the launcher proves the profile is stopped/`start_browser_error` and not in use.
- `scripts/label-profile.mjs` — readable profile label with fingerprint/proxy
  verification.
- `FRESH-ACCOUNT-RUNBOOK.md` — the exact commands and the security boundary.

Behaviour fixes required for unattended login:

- consent dialog detection/dismissal (its own reject/accept button);
- navigation fallback for covered "Sign in" anchors; bounded retry + keyboard
  submit for Google's "Next" (transient Loading overlay);
- two "Sign in" anchors collapse to one deterministic candidate;
- reasoning-model provider fix (`max_tokens` 2048, `provider_reasoning_only`);
- post-action patience: 15 s readiness window, settled account menu for identity
  verification, blank-page body read degrades to an empty observation;
- wrapper passthrough-flag fix (`--human-checkpoint-seconds` was silently
  dropped); mirror path fix; `src/config.headed.json` for VNC-visible runs;
- decision journal + flywheel ingester; live records now include the cleared
  checkpoint (`SECURITY_EXAMPLES=1`, snapshot `browser-decision-v002`).

Still external: the Discord webhook (`webhook_secret_missing`) and the
Multilogin label/health for the remaining accounts after YT-05.

## Priority update (later on 2026-09-25)

TikTok warmup is complete and out of scope. The live browser objective is now
**YouTube session triage + recovery**: keep 01/02/03 intact, recover 04 (human
checkpoint) and decide 05.

- **Discord replaces Telegram.** `src/discord-notifier.mjs` (webhook, no bot)
  sends job, profile label, state, reason, origin+path, timestamp, recovery
  steps, redacted visible-text summary, resume command, the canonical PNG and the
  focused region PNG. Retry policy: 429 honours `retry_after`, 5xx backs off, 4xx
  is final. Live channel status: **not provisioned yet** (`webhook_secret_missing`)
  — place the webhook at `private/discord-webhook-url` (mode 600) or set
  `DISCORD_WEBHOOK_URL`. The orchestrator's inbound command loop no longer starts
  (webhooks have no poll), so nothing depends on Telegram.
- **Multilogin labeling.** The metadata response has no note/tag field; the only
  label-like field is the profile name. `src/profile-labels.mjs` renames with the
  profile's own `parameters` sent back byte-identically and re-reads the profile;
  a moved fingerprint/proxy aborts. Applied live:
  `YT-01..03 | GOOD | Studio verified`, `YT-04 | HUMAN | security verification`,
  `YT-05 | BAD | cancelled / login incomplete`. All five proxies remain
  socks5/custom and no profile is in use.
- **Canonical health store** (`<data>/health.json`, `npm run browser:profiles`):
  GOOD 3 | HUMAN 1 | BAD 1. A proxy outage never downgrades a proven session; the
  note column carries the failure. Registry/evidence replay is authoritative when
  the store has no record.
- **Human checkpoint flow**: detect → `challengeSettleMs` (1500 ms) → re-observe
  once → only a still-present security surface is captured, announced and
  WAITING_FOR_HUMAN; the operator clears it in the preserved browser and the same
  process resumes. A self-clearing surface never alerts (e2e-tested).
- **Bandwidth**: per-job CDP accounting plus video-endpoint blocking, and YouTube
  runs start at the home/auth surface. Live measurement for the YT-01 reopen:
  **6.597 MB**, 56 media requests blocked, media bytes 26.8 KB of the total;
  scripts/TLS dominate. No Google auth requests were touched.
- **Live YT-01 reopen (guarded, reuse mode)**: same profile `ab6f81fa…`,
  `BROWSER_ATTACHED` → `AUTH_CHECK` → **AUTHENTICATED** (signed-in identity
  verified, 3 deterministic actions, zero model calls, no credential submitted)
  → **STUDIO_VERIFIED** → restart start failed the launcher's proxy IP check
  (`proxy_connection_failed`, `rotations: 0`). A second attempt failed at start.
  The intermittent pass/fail is the same `PROXY_TRAFFIC_EXHAUSTED` condition: the
  check service occasionally validates, then refuses again. 01/02/03 were not
  reset; the profile is stopped.
- **Still external**: provision the Discord webhook and restore the Multilogin
  proxy traffic balance. Until then `--reuse-existing-proxy` keeps every run
  fail-closed with zero rotation.

## CURRENT_BRANCH
`browser/single-command-job` in the worktree
`/Users/buena/Code/blockchain-rust-superteam-poland-browser` (the original
worktree stays on `devin/browser-runtime-v5` with its uncommitted Delio and v6
bench work untouched).

## CURRENT_HEAD
`efc4ef5` (plus this handoff commit). Branch base: `54ae7a2`
(`browser/frontier-human-loop`, 6 commits ahead of `origin/main`).

## FILES_CHANGED (54ae7a2..HEAD)
Added: `job-runner.mjs`, `scripts/job.mjs`, `src/{lifecycle,orchestrator,recovery-memory,action-router,dialog-containment}.mjs`,
`test/{lifecycle,orchestrator,orchestrator.e2e,screenshot-bundle,recovery-memory,action-router,dialog-containment}*.mjs`,
`test/fixtures/fake-backend.mjs`, `PROXY-403-DIAGNOSIS.md`, `REAL-RUN-2026-09-25.md`,
`jobs/{youtube-live-01,youtube-live-05,youtube-live-batch}.example.json`.
Modified: `screenshots.mjs` (bundle + ported gates), `jobs.mjs`, `human-checkpoint.mjs`,
`login.mjs` (recovery memory, dialog guard, phase/step in chooser requests),
`recovery.mjs`, `runner.mjs` (degrated proxy mode), `multilogin.mjs` (`profileMeta`),
`batch-runner.mjs` (package-relative defaults), `Dockerfile`, `README.md`,
root `package.json` (`browser:job`, `browser:batch`, test scripts), `.gitignore`.

## VPS_ONLY_UNCOMMITTED_FILES
`/opt/buena-multilogin-canary/src` (39 files, newer than any git branch):
`checkpoint-controller.mjs`, `checkpoint-visibility.mjs`,
`checkpoint-annotation.mjs`, `checkpoint-annotation-loop.mjs`,
`checkpoint-challenge.mjs`, `checkpoint-command-queue.mjs`,
`checkpoint-job.mjs`, `checkpoint-keyboard.mjs`, `annotation-record.mjs`,
`diagnostics.mjs`, `dialog-containment.mjs`, plus canary test files
(`checkpoint-*.test.mjs`). The canary's Telegram tile-selection controller was
deliberately NOT ported; its visibility/stability gates and the dialog guard were
ported into this branch with attribution.
Also present and untouched: `/opt/buena-multilogin` (older deployment + backups),
`/opt/buena-multilogin-takeover`, `/opt/buena-multilogin-orchestrator` (this
branch, bind-mounted over the running worker image; not a service).
The original macOS worktree still holds the uncommitted v6 kernel/benchmark
iteration (`agent/jev/bench/`, `agent/jev/experimental/browser-runtime-v6/`,
`agent/jev/tests/kernel-v6.test.mjs`, `benchmarks/browser-runtime-v6/REPORT.md`).

## YT_LIVE_01_STATUS / _02 / _03
success (verified login, verified reopen, authenticated Studio, Studio verified
after restart), profiles `ab6f81fa-…f77f`, `6b70961b-…a4df`, `8ecd7ee4-…722c`.
Currently stopped; 01 and 02 carry a `validate_proxy_error` marker from the
2026-09-25 start attempts (no browser was launched).

## YT_LIVE_04_STATUS
`waiting_for_human`, reason `human_checkpoint_timeout`, checkpoint expired
2026-09-23T20:18Z. Login not verified; the challenge was never answered
automatically. Profile `9888f708-…a4c9` preserved, stopped. Needs a human
clearance once proxy validation works again.

## YT_LIVE_05_STATUS
`cancelled` by the operator (not failed, not replaced). Profile `e86dc95e-…8256`
preserved, stopped.

## PROXY_403_ROOT_CAUSE
`PLAN_OR_QUOTA`. The exact response from
`GET /proxynm/connection_url?country=pl&protocol=socks5&session_type=sticky&count=1`
is HTTP 403 with `error_code=PROXY_TRAFFIC_EXHAUSTED`,
`message="proxy traffic balance exhausted"`. Read endpoints
(`/workspace/folders`, `/profile/metas`, launcher version/status) work with the
same token, and the endpoint shape is current (missing `country` returns
`BAD_REQUEST_VALUES`). The launcher's own proxy IP check
(`socks … ->proxy.multilogin.com:443: connection not allowed by ruleset`) fails
for every profile as a consequence, so profile start returns 400
`validate_proxy_error`. No profile was modified and no proxy was rotated. Full
evidence: `PROXY-403-DIAGNOSIS.md`.

## PROXY_REUSE_MODE_STATUS
Implemented and live-exercised: `--reuse-existing-proxy` (or
`reuseExistingProxy: true` in config) proves from read-only `/profile/metas` that
the profile carries a proxy (`proxy_masking: custom`), then refuses every
provisioning/rotation path. On the real run for youtube-live-01 (2026-09-25) it
verified the attachment (`verifiedAttached: true`), the launcher refused with
`proxy_connection_failed`, and the run failed closed with `rotations: 0`,
no browser started, no credential submitted. Never falls back to no proxy.
Tests cover: no `premiumProxy`/`changeProxy` calls, fail-closed reason, refusal to
create a profile, and metadata refusals (missing proxy / disabled masking).

## SCREENSHOT_PIPELINE_STATUS
One canonical pipeline: canonical native viewport PNG (bytes untouched) +
`-full.png` + focused `-region.png` + `-context.json` (origin+path URL, title,
redacted visible text, viewport, devicePixelRatio, timestamp, job/profile
identity). Telegram receives a `sendPhoto` preview plus the byte-identical PNG as
a `sendDocument`; the announce path selects the canonical frame only (bundle
sidecars excluded). Ported from the canary: `isRectVisibleInViewport`
(offscreen ≤ -1000 and panels < 100x100 are not panels) and a two-observation
stability gate (moving frames produce no crop), plus the stale-dialog guard
installed on the live login path. The canary's grid annotation/tile-selection
controller remains VPS-only; its `capture-check-original.png` crop is superseded
by `-region.png`. Integrity tests verify PNG signatures, 1280x720 canonical
dimensions, full-page height, offscreen/unstable/tiny rejection and redaction.

## JEV_RECOVERY_STATUS
Working and unchanged: `maxRecoverySteps = 8`, stall after 2 unchanged attempts,
confidence floor 0.8, typed capabilities executed through the single kernel with
receipts; Google/YouTube origins expanded while credentials stay restricted to
the Google auth origin.

## ACTION_ROUTER_OBSERVATION_STATUS
Observation mode is live: every chooser decision is wrapped
(`wrapGuideForObservation`) and written to
`<job>/router-observations.ndjson` with state class, candidate tool names (never
descriptions/page text), deterministic-first top candidate, agreement,
chosen method/confidence, source (deterministic/jev) and outcome
(dispatched/stale/failed). `executionChanged: false` is recorded on every
decision; the executor remains authoritative. No model call is added and the
router does not control any live action yet.

## MEMORY_OBSERVATION_STATUS
Telemetry only: `calls`, `considered`, `recalled`, `bytes`, `retrievalMs`,
`corrections`, `matched` and `lastRecallAt` on the memory store, surfaced in
`result.json`. `observeCorrection()` answers whether the correction that
eventually worked matched a recalled episode; matching episodes carry
`memoryMatched: true`. Injection is unchanged (max 2 compact hints, no
transcripts, no page text).

## TEST_COUNTS
- agent/multilogin unit: **217 pass / 0 fail**
- agent/multilogin browser (real headless Chrome fixtures): **29 pass / 0 fail**
- v6 kernel (original worktree, unchanged): **19 pass / 0 fail**
- fake-mode full lifecycle command (offline): `COMPLETE`, 0 model calls

## SAFE_NEXT_COMMAND
After the Multilogin proxy traffic balance is restored (operator-side):
```sh
npm run browser:job -- jobs/youtube-live-01.example.json --remote --build
```
This reopens the same authenticated profile, verifies auth, opens Studio,
restarts the profile, verifies persistence and completes. Keep
`--reuse-existing-proxy` available as the guarded fallback; never add
proxy-provisioning retries while the balance is exhausted. For youtube-live-04:
same command with a bounded `--human-checkpoint-seconds` and a person clearing
the challenge in the VNC browser.

## KNOWN_EXTERNAL_BLOCKERS
1. `PROXY_TRAFFIC_EXHAUSTED` (403) on premium-proxy provisioning + launcher
   proxy validation failure — blocks every live profile start. Operator action:
   top up the Multilogin proxy traffic balance or approve a replacement proxy
   entitlement. No code workaround exists or should be invented.
2. VPS canary checkpoint controller remains uncommitted and unreconciled; it must
   be diffed and merged deliberately (its gates and dialog guard are already
   ported, its Telegram tile flow is not).
3. Existing profiles 01/02 show a `validate_proxy_error` status marker from the
   safe attempts; it clears on the next successful launch and is not a profile
   defect.

## UPLOAD-POST TIKTOK CONNECT — K01–K06 (later on 2026-09-25)

**All six warmed TikTok accounts are connected to Upload-Post and verified
server-side** (`GET /api/uploadposts/users`, plan `professional`, `reauth: false`
on every account, 10 TikTok capabilities each):

| Code | TikTok handle | Upload-Post profile | Status |
| --- | --- | --- | --- |
| K01 | saleswithsophia | `default` (legacy link; second link refused) | connected |
| K02 | rubyfindsai | `rubyfindsai` | connected |
| K03 | lenatalkssales | `lenatalkssales` | connected |
| K04 | mayagrowthtips | `mayagrowthtips` | connected |
| K05 | b2bwithnina | `b2bwithnina` | connected |
| K06 | chloesalestips | `chloesalestips` | connected |

Structure: **one Upload-Post user profile per character** (profile username =
TikTok handle) because `social_accounts` stores exactly one account per platform.
The mapping and note live in `agent/multilogin/tiktok-uploadpost-map.json`
(VPS: `/opt/buena-multilogin/private/tiktok-uploadpost-map.json`,
`/data/tiktok-uploadpost-map.json`). The Hypit registry
`accounts-and-voices.json` now carries `accountsConnectedViaUploadPost: true`
plus `uploadPostProfile` per item (backup `…json.bak-20260925-uploadpost`).

Tooling (all in `agent/multilogin/scripts/`; VPS copies under
`/opt/buena-multilogin-orchestrator/scripts/`):

- `uploadpost-connect.mjs` — `check`/`authorize` modes; per-stage JSON logs, hard
  timeouts, real-mouse consent click with keyboard/DOM fallbacks, callback
  evidence (screenshot + JSON, mode 600) in
  `/opt/buena-multilogin/private/uploadpost-evidence/`. It never types
  credentials, never prints the authorize URL, and reports `human_required`
  instead of touching a CAPTCHA.
- `run-uploadpost-account.sh` — mints a single-use connect URL for one profile
  (via `POST /api/uploadposts/oauth/tiktok/start`), runs the connector, and
  re-verifies the same profile through the API; log per code in
  `/opt/buena-multilogin/private/uploadpost-runs/K0x.log`.

Operational facts worth keeping:

1. Upload-Post links each social account to **one** user profile; a second link
   returns `ACCOUNT_ALREADY_LINKED`. That is why K01 stays on `default` (its
   original link) and why the empty `saleswithsophia` profile is retained only
   as a destination if support ever moves the link.
2. Some account proxies cannot reach `app.upload-post.com` (Chrome
   `ERR_TIMED_OUT`). The connector relays the OAuth callback GET through the
   worker container, which can (the state authenticates it; no browser session
   is needed). Without that relay those accounts strand after consent.
3. A consent click can complete TikTok-side while the same attempt still fails
   to link (the code exchange needs a second pass). Re-running the same account
   once — which lands on TikTok's auto-redirect — has linked every account so
   far; do not change identity or re-warm anything to force it.
4. The Upload-Post API key is stored at
   `/opt/buena-multilogin/private/upload-post-api-key` (mode 600, worker path
   `/data/upload-post-api-key`) and was added to the Coolify `openshorts`
   service (`/data/coolify/services/nvl32qb7uke6n3ko40c0uyd7`, backend and
   renderer recreated, both healthy).

Next: Instagram K01–K06 (usernames + profile pictures are already set up), same
per-character profile pattern with `POST /api/uploadposts/oauth/instagram/start`.

## INSTAGRAM SETUP — FOUND THE SIX ACCOUNTS, BLOCKED ON PROXY BALANCE (2026-09-25 ~20:15Z)

The six warmed Instagram accounts exist in the account-pilot registry
(`/opt/buena-multilogin/private/account-pilot/profiles.json`, `platform:
instagram`, all on PL premium proxies, all stopped, one flagged
`needs_attention` = `hinakiyo3496`):

| Proposed code | Current IG handle | Multilogin profile |
| --- | --- | --- |
| K01 | rinayuki6153 | d4c3ac13-ffc8-43c0-af5d-2523e4f70274 |
| K02 | yumihana7634 | a04d004b-14a6-44e2-80b5-d25c99541dcc |
| K03 | sakuhana5179 | f7cae3d4-52f8-4a61-b1fc-bf4f62b7fe4d |
| K04 | hinakiyo3496 | 5a9caf38-b961-45f0-8ba5-910614ae6eba |
| K05 | rinayume4682 | d97923dd-56db-432f-b640-b3381bc5efaf |
| K06 | kaito_3449 | a51b5e8d-6103-410e-8f8f-25b95fbc5617 |

(No character mapping exists in the registry; the pairing above is by registry
order and can be re-paired freely since the handles/names will be replaced.)

Staged and ready:

- Character photos (the avatars already used on TikTok) are downloaded to
  `/opt/buena-multilogin/private/instagram-photos/K0x.jpg`.
- `scripts/instagram-profile.mjs` — `check` / `inspect` / `update` modes; update
  sets photo, display name and username, reads back the fields and writes
  screenshot + JSON evidence to `/opt/buena-multilogin/private/instagram-evidence/`.
- `scripts/run-instagram-account.sh` — one account per run with an ordered list
  of candidate usernames (falls through on `username_taken`).

IG1 (`rinayuki6153`) was verified logged in with the edit form reachable at
18:13Z; minutes later every profile start began failing.

**Blocker (same external item as KNOWN_EXTERNAL_BLOCKERS #1):**
`GET /proxynm/connection_url` returns 403
`PROXY_TRAFFIC_EXHAUSTED` ("proxy traffic balance exhausted"), and the launcher
now refuses every profile start with `validate_proxy_error` ("couldn't get proxy
connection ip data"). Verified at ~18:47Z against all six IG profiles **and** a
known-good TikTok profile (K02), so this is global, not profile-specific. No
alternative proxy provider credentials exist in the workspace. Remediation is
operator-side: restore the Multilogin proxy traffic balance; then the staged
runbook can complete all six Instagram profiles without further changes.

Planned update per account once unblocked: display name = the TikTok display
name (`Sophia Reed B2B`, `Ruby Hayes`, `Lena Cole | Sales`, `Maya Bell`,
`Nina Brooks | B2B with Nina`, `Chloe Quinn`), username = the TikTok handle or a
close dotted variant if taken.

## SESSION UPDATE — 2026-09-25 ~19:45Z (production UGC ops session)

- **AER v1 active in this session.** The ops session was moved to this worktree;
  telemetry `ses_f25f6274fffegrg6J92temSYlO` records build `jev-aer-v1-20260925`,
  preset `safe` (resultAdmission deterministic, shortlist soft, toolExposure off,
  router observe) with result projections applied. AER was not modified.
- **YouTube table unchanged and healthy:** YT-04 (`ab12927a-…`) and YT-05
  (`65824833-…`) GOOD_PERSISTED (login/reopen/Studio/restart persistence, human
  checkpoint resumed); YT-01/02/03 sessions preserved (last verified 2026-09-22,
  Studio verified). YT-01 keeps only the cosmetic `validate_proxy_error` marker —
  no browser launched, 0 MB, clears on the next successful launch.
- **TikTok re-verified live through the Upload-Post API at 19:38:40Z:** all six
  linked (`reauth_required:false`, 10 capabilities each), K01 on legacy `default`.
  Evidence `uploadpost-evidence/tiktok-verification-2026-09-25T19-38-40Z.summary.json`
  (repo copy added); Hypit registry `accountsConnectedViaUploadPost:true` +
  `uploadPostVerification`; map `lastVerifiedAt` updated. No feed browsing.
- **Instagram still proxy-blocked:** K01–K06 mapping pinned in the Hypit registry
  (`instagram` objects + `instagramStaging`); K01 staged update attempted 19:40:07Z →
  launcher `proxy_connection_failed` in 158 ms, no browser, no profile change.
  `PROXY_TRAFFIC_EXHAUSTED` remains the single external gate for IG names/handles/
  avatars and IG Upload-Post OAuth.
- **Discord webhook still absent** (`webhook_secret_missing`); human checkpoints can
  only be cleared via VNC.
- **Proxy MB (post-instrumentation runs):** youtube-live-04-fresh 3.918,
  youtube-live-05-fresh 6.557, youtube-live-04 (cancelled) 0.647; failed starts 0.
  Older runs and the Upload-Post OAuth connectors predate/omit bandwidth accounting.
- **Next action:** operator restores the Multilogin proxy traffic balance, then run
  `run-instagram-account.sh` for K01–K06 and connect Instagram via Upload-Post;
  optionally clear the YT-01 marker with the guarded reopen job.


