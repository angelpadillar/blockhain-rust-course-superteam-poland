# Captions Camoufox compatibility candidate

An isolated signed-in browser with a bounded Captions AI Edit automation bridge. The bridge is tested against an owned offline fixture; a successful Captions AI Edit/export must be established separately. See [AUTOMATION.md](AUTOMATION.md) for its fixed-job API. The existing Chromium service is unchanged.

## Pinned upstream

- gomoufox release [v0.1.29](https://github.com/ehmo/gomoufox/releases/tag/v0.1.29), published September 9, 2026.
- Official image: `ghcr.io/ehmo/gomoufox:v0.1.29@sha256:9f147efac1c5f0684ddb1fda085124454d008cad3a1fc3dd5ebfb615ff02c99c`.
- Linux amd64 manifest: `sha256:2d24772188d6bc8d40ecd8a6462dc777e3c91a2886af48a8cd19f35c58a9d1b4`.
- Linux amd64 release archive SHA256: `5a667b034e99909046c4efd90e1b97f3a66989dce4eff2f839c08c0b79f05e35`.
- Release/archive/image digests verified against GitHub Releases API and GHCR on September 18, 2026. No runtime floating browser install is performed here; the official pinned image already contains its managed browser.

gomoufox manages its own Firefox/Camoufox and Playwright 1.57 stack. It is not a drop-in executable for the existing Node/Playwright Chromium controller. The candidate talks to its private newline-delimited stdio MCP server and checks `tools/list` before dispatch. No MCP/daemon TCP port is published, and JavaScript evaluation, cookie access/export, session import, proxies, HAR capture, and arbitrary fetch remain disabled. No browser fingerprint settings, CAPTCHA tooling, or proxy configuration are added. The user completed normal manual login; the authenticated profile survived graceful restarts. This proves sign-in compatibility, not editing/export completion.

## Isolation

- New service and state: `/data/captions-editor-camoufox`; no existing account/profile/state is mounted or copied.
- Persistent profile: `state/profiles/captions-trial`; exclusive service ownership plus upstream profile locking. Never remove a lock while an owner may still run. After a crash, inspect process/container ownership before clearing only this service's stale `.candidate-owner` file. Do not remove upstream browser locks.
- Nonroot UID/GID **1001** (`pwuser` in this pinned upstream image), `no-new-privileges`, namespace-capable seccomp profile copied from the existing reviewed Playwright profile, 2 CPUs, 4 GiB RAM, 1 GiB shared memory.
- Private desktop only: `100.121.5.10:6093` → noVNC. x11vnc itself binds loopback and requires a binary VNC password file. Keep this Tailscale-only; there is no public listener binding.
- Authenticated HTTP binds **container loopback** `127.0.0.1:8793`; no external port is exposed. Observation endpoints return status, snapshots without input values, screenshots and host-only diagnostics. The optional bridge executes only next steps in a local approved asset/job manifest; no arbitrary selectors, paths, scripts, URLs, account changes, purchases or publishing are accepted.
- Manual onboarding can interact with the allowed sites through the desktop. It is not a route-level payment firewall. The deployment initially navigates home and observes. Editor actions require a calibrated manifest and explicit bridge dispatch. The empty example manifest grants no actions.

## Prepare / build (operator)

1. Verify Tailscale port 6093 is free. Do not stop the current 6092 service.
2. Create separate `state`, `fixtures`, `config`, and `secrets` directories under `/data/captions-editor-camoufox`, owned by UID/GID 1001. State/secrets should be mode 0700. The pinned upstream image's `pwuser` is 1001, unlike the existing Chromium image.
3. Copy `config/editor.example.json` to `config/editor.json`. This includes the observed `api.workos.com`, `auth.mirage.app`, and `workos.imgix.net` login/resource hosts, plus `captions-cdn.xyz` for editor style/media assets. The user subsequently explicitly approved the shared `storage.googleapis.com` hostname for the Captions upload connection after approval review explained its scope. Only manifest-approved video files may be uploaded by the bridge. Datadog and Intercom telemetry remain outside the allowlist. Add only exact additional hosts observed for the chosen legitimate login flow. No wildcard identity-provider scope is present. Blocked-host/login errors require diagnosis, not automatic wildcard expansion.
4. Create a fresh mode-0600 `secrets/service_token` containing at least 32 random characters and a separate binary `secrets/vnc_password` with x11vnc `-storepasswd`. Do not reuse/expose existing account or API credentials. Both must be readable by UID 1001.
5. Create the read-only assets directory and `config/jobs.json` using the empty example, then `docker compose --profile selftest build selftest`. The build applies the narrow pinned [DOM metadata patch](patches/README.md), then runs upstream and application tests.
6. `docker compose --profile selftest run --rm selftest`
7. Inspect its `fixtures/fixture-*/report.json`. Only after actual success, start `docker compose --profile onboarding up -d onboarding` and visit `http://100.121.5.10:6093/vnc.html?autoconnect=1&resize=scale` privately.

The base image exposes 3741 as image metadata, but neither Compose service publishes it and neither runs the raw HTTP daemon.

## Observation / shutdown

Use `docker compose exec -T onboarding node scripts/observe.mjs status` (or `snapshot`, `screenshot`, `network`). Screenshot writes PNG to stdout; redirect to a private file. Do not share screenshots while passwords, codes, or personal account details are visible. Status is also written privately to `state/status.json`; runtime capabilities to `state/capabilities.json`.

Shutdown with Compose stop for a graceful browser/profile flush. The browser lifetime stays owned by the candidate Node process. No cookie state is exported.

## Verification scope

`npm test` checks launch gates, host/config constraints, ownership, authentication, and live-schema/protocol enforcement without browser/network access.

The container `selftest` runs with **network disabled**, creates its own loopback fixture and a one-second synthetic 9:16 MP4, launches a fresh headful profile, verifies DOM and PNG screenshot output, sets the local file input, downloads the fixture copy, then checks its exact SHA256, dimensions, duration, and full ffmpeg decode. It records every assertion and duration. This demonstrates file and browser capabilities; it does **not** count as an AI Edit export, caption test, or successful Captions login.

### Verified September 18, 2026

- Image `buena-captions-editor-camoufox:0.1.29-6` built on the VPS; **36 application tests** and upstream a11y/MCP tests passed.
- Real network-disabled guarded bridge fixture: **27/27 checks passed in 6.302 seconds**. It uploaded through an actually hidden file input, filled the prompt, disabled and verified a native checkbox and both labelled/unnamed ARIA switches, edited the owned test page, downloaded its MP4, and verified exact bytes, duration, 9:16 dimensions and full ffmpeg decode. VPS report: `/data/captions-editor-camoufox/fixtures/fixture-TxJxWW/report.json`.
- Private onboarding is healthy on Tailscale-only port 6093. Upstream 3741 remains unpublished. The same authenticated Captions profile survived graceful restarts; the owned page shows the Buena account and AI Edit controls at `/home`.
- The fixed 1440×900 owned viewport fits the maximized desktop. noVNC scales; fluid browser-window resizing and arbitrary tab adoption remain unsupported upstream.
- The live editor has two hidden file inputs. Exact observed `accept` and `multiple` fields distinguish the media input from the audio-oriented input. No upload is performed merely by observing these controls.
- Blockers resolved: image UID mismatch (1001 required); truncated structured MCP DOM payloads; manual-login second-tab ownership; hidden file inputs excluded from upstream snapshots; checkbox role/state absent; reference races; uncertain slow operations now have a read-only reconciliation path. Failed fixture reports are retained.
- Actual Captions AI Edit, render and export are **not claimed by this fixture**. Parent workflow performs and reports those separately.
- Local evidence: `artifacts/authenticated-input-snapshot.json`, `artifacts/authenticated-home.png`, `artifacts/authenticated-network.json`, `artifacts/patched-offline-report.json`.

## Upstream sources

- [MCP skill and contract](https://github.com/ehmo/gomoufox/blob/v0.1.29/skills/gomoufox-mcp/SKILL.md)
- [Upstream image build](https://github.com/ehmo/gomoufox/blob/v0.1.29/Dockerfile)
- [Actual tool schemas](https://github.com/ehmo/gomoufox/blob/v0.1.29/internal/mcp/mcp.go)
- [Camoufox Playwright usage](https://camoufox.com/python/usage/)
- [Captions current AI Edit workflow](https://captions.ai/help/docs/project/ai-edit#desktop)

Captions AI Edit is the multi-asset/prompt/style workflow. It is separate from the API's styled caption template endpoint. No claim is made that this candidate can clone all application features or replace a Captions subscription/trial entitlement.

### First live upload blocker

The first approved test selected its file successfully but Captions displayed “Failed to upload file”; network evidence showed blocked requests to `storage.googleapis.com`. The failed job was cancelled with its receipt retained. The initial host expansion was rejected by automatic approval review because the hostname is shared. After explicit user approval of that exact scope, the host was added and the same signed-in browser restarted. No retry was performed by this adapter task. Evidence: `artifacts/upload-failure-network.json`, `artifacts/upload-failure.png`, `artifacts/storage-approved-home.json`.

### Saved draft controls verified

The optional `resumeJobId` now reopens only a saved Captions project recorded by a verified navigation receipt in the same unchanged job. The deployed adapter resumed draft `mUalhOmXOSiSR51R0tBn`; the actual switch snapshot showed Voiceover Only=false, Trim filler and silences=false, Generate media=true. The parent workflow owns turning that last switch off before rendering. No render was started by the adapter task. Evidence: `artifacts/draft-switches-snapshot.json`.

### Repeated switch resolver correction

Revision `0.1.29-6` corrects upstream selectors truncated to six ancestor levels. Deep repeated settings rows could produce the same CSS selector even after semantic reference validation selected the right row. The fixed observer uses full ancestry and accepts an element ID only when unique. The regression fixture reproduces the old failure, then passes with the correction: only the middle of three unnamed, deeply nested switches changes. The saved Captions draft resumed healthy with Generate media still on; the parent owns the reviewed retry. No live switch or render was triggered by this adapter task. Evidence: `unique-switch-ready.json`; old failed fixture `/data/captions-editor-camoufox/fixtures/fixture-jNjkkI/report.json`.

### Copy and paste between devices

The bottom-right **Copy / Paste** panel transfers plain text through the existing authenticated noVNC connection. Paste into the first box and choose **Send to VPS**, then click the remote field and press **Ctrl+V**, including from a Mac. To copy out, use **Ctrl+C** inside the remote browser, choose **Copy to device**, then paste locally with **⌘V** on Mac or **Ctrl+V** on Windows. The copy button uses a user gesture and supports an HTTP-compatible selection/copy fallback; if browser permissions prevent copying, it selects the text and explains the manual shortcut. It never reads the local clipboard automatically or stores text.

The live panel was applied as an HTML/JS/CSS update, without restarting the signed-in browser. Refreshing the outer noVNC page loads the panel. The Dockerfile installs the same assets for future deployments. The isolated `scripts/clipboard-selftest.mjs` uses two separate X11 displays with synthetic URLs and no production volumes/secrets; its clipboard reader must never be run on the live desktop.

Clipboard verification: the real authenticated RFB fixture passed **5/5 checks in 30.015 seconds**, with distinct local/remote X11 clipboards and exact ASCII URLs. Report: `/data/captions-editor-camoufox/fixtures/clipboard-JlxG0r/report.json`. The fixture waits for x11vnc’s initial selection-monitoring delay. This verifies transfer both ways and the Copy button in the fixture browser; user-browser HTTP permission fallbacks and non-Latin text were not separately tested. Closing the panel returns focus to its launcher; click the remote browser field before using its shortcuts.
