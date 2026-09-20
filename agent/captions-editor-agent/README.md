# Captions editor agent

A separate, bounded adapter for the **Captions web editor** at `https://captions.ai/home`. This implements the existing Jev handoff design; it does not change the shopping service, frozen browser runtime, or payment adapter.

## Current truth

- Authenticated HTTP and a narrow MCP endpoint share one durable queue, policy and verifier.
- One isolated persistent profile has exclusive ownership. The user explicitly authorized their **own existing Captions trial account**, superseding the initial dedicated-test-account restriction; all editing remains scoped to a test project. Manual login and jobs cannot own the profile simultaneously. Existing Jev/Captions profiles are never imported.
- The adapter supports observed accessible buttons, file selection and numeric trim fields. Unknown selectors, timeline-only dragging, login/challenges, unclear credit entitlement and unverified saved copies stop with `needs_attention` plus evidence. It does not pretend a guessed selector succeeded.
- **Verified live editor exports: 0.** The workflow's live selectors still require calibration against the signed-in Captions UI. Passing local tests is not a live Captions export.
- No purchase, upgrade, subscription, payment, account-change, publishing, sharing or delete-original tool exists. No caller-controlled JavaScript, raw CDP, general navigation, arbitrary file upload or file read is exposed.
- TypeSafe/Jev is implemented but its key is **not configured**. It is optional for ambiguous **currently observed and permitted** controls. Known unique controls use code. Model calls are bounded, usage is recorded, and unknown price stays `null`, not “free”.
- Editor release 3 is deployed to both Chromium worker and onboarding containers in owner-authorized mode; the worker is healthy and the private desktop returned HTTP 200. It passed 20/20 VPS offline tests, including the ffmpeg/OCR fixture, without account use. The authentication repair was verified anonymously before deployment: the blocked `api.workos.com/user_management/authorize` route reaches `https://auth.mirage.app`. Reaching the login form is not a successful account login. A separate Camoufox candidate is still being developed and is not verified or deployed.

## Deployment contract

Use only the new `/data/captions-editor-agent` directory:

```
state/                      # profile, exclusive lock, jobs, journal, artifacts; uid1000 mode0700
assets/                     # only explicitly approved test media; mounted read-only
config/editor.json          # copied from config/editor.example.json and completed
secrets/service_token       # random32+char bearer token; mode0600 uid1000
secrets/vnc_password        # x11vnc-compatible password file; mode0600 uid1000
```

Compose binds **8792** (job API) and **6092** (private noVNC) solely to `100.121.5.10`. Two CPUs,4GiB RAM,1GiB shared memory; uid1000; Chromium sandbox enabled; copied reviewed Jev seccomp profile with namespace syscalls; `no-new-privileges`. No raw debugging port. Never weaken sandbox settings to make startup pass.

The parent task must confirm these ports remain available and preserve existing stacks. The Docker image pins Node22.19.0 and Playwright1.62.1. OS packages come from Debian Bookworm repositories; image digest reproducibility is not claimed.

1. Place config and secrets; initialize directories with owner1000. Add the approved source as a manifest entry with exact SHA-256:

```json
"assets": {
  "buena-test-20s": { "file": "buena-test-20s.mp4", "sha256": "ACTUAL_FILE_SHA256" }
}
```

2. Start only onboarding:

```
docker compose --profile onboarding up -d --build onboarding
```

Open `http://100.121.5.10:6092/vnc.html?autoconnect=1` over Tailscale, enter its separate VNC password, and manually sign into the owner's authorized existing Captions trial account using its original login method. Never copy another browser profile. Approved auth hosts can be added to `onboardingDomains`; `interactiveAuthDomains` permits reviewed manual authentication hosts only while onboarding owns the profile. These permissions do not apply to worker editing. All WebSockets are blocked. Other worker and onboarding mutations default to denied; add an exact reviewed `mutationRoutes` entry only for an observed required read, auth or editing endpoint. Each entry binds `host`, `path`, `methods`, `contentTypes`, and one `phase` (`read`, `onboarding`, `project`, `upload`, `trim`, `captions`, `copy`, `export`). Query/body payment and forbidden-operation intents remain blocked even for a listed endpoint. Failed requests are recorded with origin/path and method, without query strings or bodies, in `state/onboarding/journal.jsonl`. Review each blocked host before extending an exact-host resource allowlist; no `*`.

3. Stop onboarding before confirming the account marker:

```
docker compose stop onboarding
docker compose --profile worker run --rm worker node scripts/confirm-test-account.mjs 'Owner-authorized Captions trial account' --owner-authorized
docker compose --profile worker up -d worker
```

The `--owner-authorized` flag records `accountScope:"owner-authorized"` and `testAccountOnly:false`; configure the worker with that same scope. The profile ID remains `captions-test` for isolation and does not mean the account must be a newly created test account. Without this flag, the script records the original dedicated-test-account scope. Record either marker only after the operator verifies the intended account is signed in. The marker does not prove login remains valid; each job checks observed login state. A stale lock is never auto-deleted: prove its owning process/container stopped before removing that specific lock manually.

4. The user has authorized this edit to consume **existing trial credits**. This does not authorize buying credits, upgrading, starting another trial or publishing. Observe and record the actual entitlement, amount and confirmation controls before starting a generation; do not infer them from login success. Leave `includedEditsConfirmed:false` until the existing entitlement is observed. A visible “free edit”, exactly “0 credits”, “no credits required”, or “included in your plan” in the selected action context can also establish entitlement. The current worker still stops on a nonzero credit/money quote: handling an authorized nonzero quote needs calibration before automation can proceed, not another blanket user approval. Ten/hundred credits must never match zero. Disable **Generate media** for the proof.

5. Enable optional Jev by placing its existing authorized key in a private file and setting `TYPESAFE_KEY_FILE` on **this** service. Do not borrow credentials from the frozen payment adapter or expose them to the browser. Maximum4 model calls by default; there are no provider calls during build or tests.

## API and narrow MCP

All routes except `/healthz` require `Authorization: Bearer …`. Requests with an `Origin` header are rejected to avoid a browser-based confused deputy. The service is scoped to one application, one authorized account and one credential. It is not a multi-tenant service.

- `GET /v1/status` — readiness, active/queued jobs, permitted asset IDs and styles.
- `POST /v1/jobs` with `Idempotency-Key` — enqueue a validated task. Same key+body returns the original job; different body conflicts. At most3 queued/running jobs.
- `GET /v1/jobs` / `GET /v1/jobs/:id` — status, checklist, metrics, blocker.
- `POST /v1/jobs/:id/cancel` — close browser and checkpoint cancellation.
- `GET /v1/jobs/:id/artifacts` / `GET /v1/jobs/:id/artifacts/:name` — authenticated evidence/export, restricted to the job.
- `POST /mcp` — JSON-RPC initialize, ping, tools/list, tools/call. Tools: `editor_status`, `editor_submit`, `editor_job`, `editor_cancel`, `editor_artifacts`. Stateless JSON transport; no unrestricted browser tools or session-transfer interface. MCP session streaming/resumable SSE is not implemented.

Example job body (20-second source, retain seconds0–20):

```json
{
  "assetId": "buena-test-20s",
  "trimStart": 0,
  "trimEnd": 20,
  "style": "Velocity",
  "expectedCaption": "Find leads with Buena",
  "requireSubtitleTrack": false
}
```

Use an exact phrase actually spoken inside the selected trim. `trimEnd` must not exceed media duration. Editing0–20 of a20-second clip verifies preservation, not a meaningful trim; for trim proof choose a real shorter range and expect that range's duration.

The corrected source `copper-drama3-voice/buena-ai-original-drama3-1080p.mp4` is **14.333 seconds at 1080 × 1920**, with the untouched original **13.839-second Fish Drama 3 voice** and retimed visuals; full decoding passed. Perfect lip sync is not guaranteed. The earlier 20-second version contains Seedance-recreated speech based on the Fish reference. Do not use the 20-second example's trim or asset identity for the corrected file; register its own hash and choose a valid interval.

## UI workflow and evidence

The official AI Edit entry path is **Home → Edit → upload → editing prompt → AI Edit style → Create my video → review settings → Create project**. Clone is not a step in that guide. This path, its credit confirmation, and its actual upload, trim, save-copy and export controls still require calibration in the signed-in account. The bounded stages below describe the adapter's intended proof, not a completed live run.

1. Navigate to the fixed Captions home URL and observe source state.
2. Use the observed unique upload input on the empty home page, or open a **new** test project using a fresh permitted control.
3. Upload the manifest-authorized MP4 (hash checked immediately beforehand); require loaded video metadata.
4. Set numeric Start/End fields and confirm the retained field values; never guess a timeline drag.
5. Enter AI captions/edit, select the observed authorized style, and require expected caption words in the editor. Unrecognized Generate/Render confirmation controls currently require adapter calibration; they are not clicked blindly.
6. Save a copy; require a distinct observed project/editor/video URL.
7. Capture an actual MP4 download, not a toast.
8. Verify independently with ffprobe, full ffmpeg decode, sampled Tesseract OCR, and SHA-256.

Every action has an `action_pending` durable event before dispatch and an observed postcondition. Job restart never replays an uncertain UI side effect. Each observation includes a fresh version/owner; a changed page invalidates an action. Screenshots are mandatory at source/upload/trim/captions/copy/export and failure boundaries; accessibility snapshots and blocked network events stay in private job artifacts. Avoid logging secret browser values or authentication forms.

## Verification and reporting

`verification.json` records:

- Expected trim duration within two frames or90ms (larger tolerance wins).
- Exact preservation of original dimensions and9:16 aspect.
- Audio present if expected, successful full video decode, output size and hash.
- `captionTrackPresent` from actual ffprobe subtitle streams.
- `sampledCaptionWordsPresent` from expected OCR words appearing in output but not the clean source at deterministic sample times. This does not establish transcript order or timing; `captionTranscriptVerified` remains false.
- `frameRateAcceptable` requires at least 23.976 fps. Duration tolerance never exceeds 0.1 seconds, including for rejected low-frame-rate output.

Most stylized captions are burned into pixels. **Do not claim an embedded subtitle track** when `captionTrackPresent:false`. `requireSubtitleTrack:true` enforces a real track in addition to visual OCR. No track is synthesized merely to make the checklist green. The verifier reports `sourceVisualIdentityVerified:false`: frame similarity/source identity is not inferred from matching metadata. OCR verifies expected word presence, not order or full transcript accuracy. All expected words, including negations, must appear. OCR is deterministic evidence, not perfect perception: errors/fancy animations can produce a false negative, and a failed check needs visual review.

`report.json` includes every stage's wall time, total wall time, model calls/tokens, attention interventions and blockers. Costs stay unknown unless measured. A successful fixture export does not count as a Captions success. Report `verified live exports / attempts`, not test pass count. Zero successes has no finite cost-per-success.

## Tests

```
npm ci --ignore-scripts
npm test
```

The suite checks concurrent idempotency, authentication/origin handling, cancellation, profile ownership, restart safety, URL/payment/file policies, dimensions, caption evidence, and a synthetic ffmpeg/OCR fixture. No live provider requests, purchases or Captions accounts are used.

## Source references

- Original brief read first: `/Users/buena/Documents/ChatGPT/typesafe-ai-experiment/hackathon/jev/BROWSER-SERVICE-HANDOFF.md`.
- Queue/profile/Jev patterns adapted from the separate read-only source `/Users/buena/Code/blockchain-rust-superteam-poland/agent/jev/src/`.
- TypeSafe contract verified2026-09-18: https://docs.typesafe.ai/api , https://docs.typesafe.ai/primitives/choice , https://docs.typesafe.ai/cookbooks/function_calling .
- Editor selected by user: https://captions.ai/home ; feature guide https://captions.ai/help/docs/project/ai-edit#desktop .
