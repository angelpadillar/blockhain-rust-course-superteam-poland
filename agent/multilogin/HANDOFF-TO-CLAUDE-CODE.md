# HANDOFF — AI UGC character publishing (to Claude Code)

Date: 2026-09-26 · Operator: Buena AI · Environment: macOS dev + VPS `100.121.5.10` (Tailscale)

This document describes the working system we already built for six AI UGC characters
(K01–K06), the data/registries that are the source of truth, the proven operational
patterns, and the recommended build: **generate → schedule → post videos/photos/text
through Upload-Post to each character's connected channels**, surfaced in the UGC Studio
dashboard (`http://100.121.5.10:8795/#library`).

Read this before writing any new code. Prefer extending the existing patterns over new
architecture.

---

## 1. Systems map

| System | What it is | Where |
|---|---|---|
| Upload-Post | unified social posting API (the publishing brain) | `https://api.upload-post.com` · key: `/opt/buena-multilogin/private/upload-post-api-key` |
| Multilogin X | cloud browser profiles (one per identity per platform) + proxies | launcher `https://launcher.mlx.yt:45001`; token `/opt/buena-multilogin/private/automation-token` |
| VPS worker | all browser/API operations run inside `docker compose run` on the VPS | `/opt/buena-multilogin` (compose), scripts at `/opt/buena-multilogin-orchestrator/scripts/` |
| VNC viewer | Xorg `:99` + x11vnc for human checkpoints | compose service `viewer`, VNC at `127.0.0.1:5901` on the VPS; password `/opt/buena-multilogin/private/vnc-password` |
| UGC Studio dashboard | review UI (characters, library) | `/opt/ugc-dashboard/server.py` bound `100.121.5.10:8795`; reads hypit-studio `http://100.121.5.10:5179`, `creator.sqlite`, workspace manifests under `/data/hypit/workspace` |
| openshorts (Coolify) | media generation pipeline where the Upload-Post key was added | service dir `/data/coolify/services/nvl32qb7uke6n3ko40c0uyd7` |
| Discord | operator alert channel for human checkpoints | webhook URL at `/opt/buena-multilogin/private/discord-webhook-url` (mode 600) |

Inside the worker container: `/data` = `/opt/buena-multilogin/private`; source is mounted at
`/app/work/src`.

## 2. Canonical data (source of truth)

- **Social account registry (canonical):** `/data/hypit/workspace/claude-six-20260918/accounts-and-voices.json`
  - `items[]` per character: `code` (K01…K06), `name`, `handle` (TikTok), `characterId`,
    `uploadPostProfile`, plus `instagram` and `youtube` objects with handles, Multilogin
    profile ids, proxy info, and connection state (`uploadPostConnected` etc.).
  - Platform state fields written by our tooling; keep them updated on every change.
- **TikTok ↔ Upload-Post map:** `/opt/buena-multilogin/private/tiktok-uploadpost-map.json`
- **Account pilot (identity registry):** `/opt/buena-multilogin/private/account-pilot/profiles.json`
  (Multilogin profile ids, proxy country, setup status) and `health.json` (YouTube health).
- **Credentials (mode 600, never print):** `/opt/buena-multilogin/private/accounts.json`
  (`platform`, `username`, `previousUsername`, `password`, `totp`; refs `K01…K06`, `yt-live-01…05`).
- **Proxies:** `/opt/buena-multilogin/private/proxies/` (`k0x.txt` + `assignments*.json`).
- **Evidence** (JSON + PNG per run): `/opt/buena-multilogin/private/{instagram,youtube,uploadpost,network}-evidence/` and `instagram-runs/*.log`.

**Rule:** every operational action ends by updating the registry and writing evidence.
Never report a state that isn't API- or evidence-verified.

## 3. Character → Upload-Post profile → connected channels (final, API-verified 2026-09-26)

| Code | Character | Upload-Post profile | TikTok | Instagram | YouTube |
|---|---|---|---|---|---|
| K01 | Sophia Reed | `default` | ✅ `saleswithsophia` | ✅ `sales.with.sophia` | ✅ Sophia Reed |
| K02 | Ruby Hayes | `rubyfindsai` | ✅ `rubyfindsai` | ✅ `rubyfindsai` | ✅ Ruby Hayes |
| K03 | Lena Cole | `lenatalkssales` | ✅ `lenatalkssales` | ✅ `lenatalkssales` | ✅ Lena Cole |
| K04 | Maya Bell | `mayagrowthtips` | ✅ `mayagrowthtips` | ⛔ burned (IG SMS never arrives) | ⏳ name blocked (YouTube 2-changes/14-days) |
| K05 | Nina Brooks | `b2bwithnina` | ✅ `b2bwithnina` | ✅ `b2bwithnina` | ✅ Nina Brooks |
| K06 | Chloe Quinn | `chloesalestips` | ✅ `chloesalestips` | ✅ `chloesalestips` | — no 6th YT account exists |

`saleswithsophia` profile is reserved (K01's TikTok lives on `default`; Upload-Post refuses
a second link: `ACCOUNT_ALREADY_LINKED`).

**Fully posting-ready characters:** K01, K02, K03, K05 (all three platforms). K06 has two.

## 4. Upload-Post API recipes (this is how posting should work)

Auth header on every call: `Authorization: Apikey <key>`.

### 4.1 Post a video (one multimodal call)
```sh
curl -X POST https://api.upload-post.com/api/upload \
  -H "Authorization: Apikey $KEY" \
  -F "user=default" \
  -F "platform[]=tiktok" -F "platform[]=instagram" -F "platform[]=youtube" \
  -F "title=Small habits compound. #b2b #growth" \
  -F "description=Full description (YouTube/LinkedIn/Facebook/Pinterest only)" \
  -F "video=@/path/to/video.mp4" \
  -F "scheduled_date=2026-09-27T18:30:00Z" -F "timezone=Europe/Warsaw" \
  -F "external_id=char-K01-post-0001"
```
- Required: `user`, `platform[]`, media file, `title` (YouTube/Reddit require it).
- `scheduled_date` (ISO-8601, future ≤365d) → **202 Accepted + `job_id`**. Omit to post now.
- `add_to_queue=true` schedules to the next free queue slot (cannot mix with `scheduled_date`).
- `external_id` (or `X-External-Id` header) is echoed by schedule/status/history — use your own
  record id. Add `Idempotency-Key` when retries must not duplicate.
- Per-platform overrides exist: `tiktok_title`, `instagram_title`, `youtube_title`, etc.
- Photos/carousels: `POST /api/upload_photos`; text/threads: `POST /api/upload_text`.

### 4.2 Track / manage
| Purpose | Endpoint |
|---|---|
| Poll async or scheduled job | `GET /api/uploadposts/status?job_id=…` (or `request_id`) |
| Upload history (per-platform results) | `GET /api/uploadposts/history` |
| List scheduled jobs | `GET /api/uploadposts/schedule?profile_username=…&from=…&to=…&limit=…` |
| Cancel/edit a scheduled job | see `docs.upload-post.com/api/schedule-posts` |
| Retry failed upload (no re-upload) | `POST /api/uploadposts/posts/retry` |
| Edit live post (not IG) / unpublish (not IG/TikTok) | `/posts/edit`, `/posts/unpublish` |
| Remaining Instagram quota | `GET /api/uploadposts/instagram/publishing_limit` |
| Accounts per profile | `GET /api/uploadposts/users[/<profile>]` |
| Real-time results | Webhooks (`/api/webhooks` docs) — best for the scheduler |

Platform caps to respect: Instagram **50 posts/account/24h**, TikTok daily caps, YouTube
default quotas. Poll quota endpoints before batch scheduling.

### 4.3 Scheduling model to use
- One queue per character (Upload-Post profile) is the natural unit.
- Prefer **`scheduled_date` + `timezone=Europe/Warsaw`** when a human approves exact times;
  prefer **`add_to_queue=true`** for steady drip campaigns.
- Persist for every post: `external_id`, Upload-Post `job_id`/`request_id`, profile, platforms,
  media path, caption, `scheduled_date`, and last-known status from `/status` or webhooks.
- Titles/captions per character voice (see registry `name` + TikTok handle; keep them distinct
  per character — no cross-posting of the same caption unless intended).

## 5. Browser automation — ONLY for auth/maintenance (never posting)

Posting must go through the API. The Multilogin browser patterns exist for:
account login/auth verification, OAuth connects, profile maintenance, genuine human checkpoints.

Run pattern (always from the VPS, sequential, never two profiles of the same character at once):
```sh
ssh root@100.121.5.10
cd /opt/buena-multilogin
docker compose run --rm --no-deps -T \
  -v /opt/buena-multilogin-orchestrator/src:/app/work/src:ro \
  -v /opt/buena-multilogin-orchestrator/scripts/<tool>.mjs:/app/work/scripts/<tool>.mjs:ro \
  --entrypoint node worker work/scripts/<tool>.mjs <args> </dev/null
```
Key scripts (all in `agent/multilogin/scripts/`, synced to the VPS):
- `instagram-professional.mjs` — `check|probe|switch` account type; delegates login to the connector's proven routine.
- `uploadpost-instagram-connect.mjs` / `uploadpost-youtube-connect.mjs` — OAuth connectors
  (login: saved-profile picker → password → TOTP; consent; callback relay).
- `finish-ig-oauth.mjs` — side-attaches to a parked browser and **signs in + clicks Allow**
  (password + TOTP from the store) → callback. This is what completed IG for K01/02/03/05/06.
- `park-oauth.mjs` — parks a profile on an authorize URL and Discord-notifies with a screenshot.
- `approve-consent.mjs` — side-attach that clicks Select all + Continue/Allow (no login).
- `read-page.mjs` — diagnostic read of the newest page in a running profile.
- `youtube-studio-branding.mjs` — rename/avatar with `--auto-verify` (password+TOTP) and a human window.
- `send-yt-code.mjs` — current+next TOTP for any account ref, sent to Discord (`--ref K02` works for IG too).
- `set-custom-proxy.mjs`, `apply-proxy-assignments.mjs`, `provision-premium-proxy.mjs`,
  `profile-net-check.mjs`, `stop-profile.mjs` — proxy/profile tooling.
- `human-notify.mjs` (`src/`) — Discord alert with screenshot; fail-open.

**Human-in-the-loop pattern:** park the browser → Discord alert with screenshot → operator
clicks in VNC (`ssh -L 5901:127.0.0.1:5901 root@100.121.5.10`; password at
`private/vnc-password`) → resume/verify. **Never solve CAPTCHAs automatically**; for text
codes ask for/generate TOTP. Keep tab hygiene (the shared `connect()` prunes stale tabs).

## 6. Proxy pattern (per character, one identity)

- One proxy per character, used by that character's IG + YouTube + TikTok profiles, sequential.
- **Instagram works on Korbank (AS35179) IPRoyal ranges; UPC/Glide ranges get HTTP 429.**
  K02/K05 currently run on Multilogin premium proxies (works). K01/K03/K06 on Korbank.
- Tools: `apply-proxy-assignments.mjs` (batch attach, confirm), `profile-net-check.mjs`
  (verify browser exit IP), `provision-premium-proxy.mjs` (premium, PL).
- For new IPRoyal orders: ask for Korbank-located IPs or test each with
  `curl --config <proxy>.curlrc https://www.instagram.com/accounts/login/` (200 = usable, 429 = no).

## 7. Guardrails (non-negotiable)

1. Posting = API only; browser only for auth/maintenance/checkpoints.
2. Never cross-login identities between profiles; one profile = one account.
3. Never print/export secrets; files are mode 600; screenshots/evidence are redacted.
4. Never automate CAPTCHA solving or any security control.
5. Registry-first: update `accounts-and-voices.json` (+ evidence) after every action.
6. Sequential profile runs per character; never start GOOD profiles just to reconfirm.
7. Respect platform caps and anti-spam: no identical captions across characters; ramp up volume.
8. K04 Instagram is burned; do not attempt it. K04 YouTube name retry after 2026-10-10.
9. Keep `external_id`/`Idempotency-Key` so retries cannot double-post.

## 8. Recommended build for Claude Code (publishing + scheduling + generation)

Deliver a **Publishing module** with four pieces and a dashboard tab:

1. **Resolver** — read `accounts-and-voices.json`, resolve `character → uploadPostProfile →
   connected platforms`; expose helper `getTargets(code, platforms?)`. Fail if a platform isn't
   connected (or mark SKIP with reason), never attempt a browser fallback for posting.
2. **Content generator** — per character:
   - captions: LLM with character voice (name, handle, niche); distinct per character; store
     as `caption` + per-platform `description` where relevant (YouTube/LinkedIn).
   - media: videos from the openshorts pipeline (Coolify service `nvl32qb7uke6n3ko40c0uyd7`)
     or files in the UGC library (`/opt/ugc-dashboard` thumbs / workspace manifests); photos via
     `POST /api/upload_photos`. Reuse the staged avatars at
     `/opt/buena-multilogin/private/instagram-photos/K0x.jpg` only for profiles, not posts.
3. **Scheduler/Publisher** — writes post records with `external_id`, then:
   - schedule: `POST /api/upload` with `scheduled_date` (+`timezone=Europe/Warsaw`) **or**
     `add_to_queue=true` for drip;
   - immediate: same call without scheduling once approved;
   - persist `job_id`/`request_id`; poll `GET /api/uploadposts/status` or consume webhooks;
   - reconcile with `GET /api/uploadposts/schedule` and `GET /api/uploadposts/history`;
   - retry failures with `/posts/retry`; never re-upload the media.
4. **Publishing tab in the UGC dashboard** (`/opt/ugc-dashboard/server.py`, index.html):
   - per character: connected channels (from Upload-Post API), queued/scheduled list,
     published history with per-platform status, remaining IG quota;
   - actions: approve, reschedule (edit/cancel job), retry failed.
   Dashboard is currently read/review-only; the minimal change is one server-side module
   backed by the four pieces above — **no architecture change**, same workspace data.

Suggested post record:
```json
{ "external_id":"char-K01-post-0001","character":"K01","profile":"default",
  "platforms":["tiktok","instagram","youtube"],"media":"/data/media/k01-0001.mp4",
  "caption":"…","description":"…","scheduled_date":"2026-09-27T18:30:00Z",
  "job_id":null,"status":"scheduled","created_at":"…","results":{} }
```

## 9. Known gaps / current blockers

- **K04**: Instagram retired (SMS never arrives); YouTube rename blocked until the 14-day
  name-change window resets (retry after 2026-10-10), avatar already set.
- **K06**: no YouTube account exists (5 total).
- Instagram OAuth can bounce on stale state: always mint **fresh** authorize URLs and finish
  promptly (the `park → fresh-finish` sequence handles it; one retry may be needed).
- IPRoyal flagged IPs (UPC/Glide) → ask support to swap for Korbank, or order new and test.
- Premium proxy launcher validation is occasionally flaky; retry the same run.

## 10. First test post (prepared, not published)

- Character: **K01 Sophia Reed** (profile `default`; TikTok + IG + YouTube all connected).
- Asset: `/Users/buena/Documents/Demos UGC/UGC Demo Vid.m4v` (or a generated clip).
- Caption: `Small habits compound. #b2b #growth` · Description: character bio line.
- Call: §4.1 with `platform[]=tiktok`, `platform[]=instagram`, `platform[]=youtube`,
  `user=default`, `external_id=char-K01-post-0001`.
