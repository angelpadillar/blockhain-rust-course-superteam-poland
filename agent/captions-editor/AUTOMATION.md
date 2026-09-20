# Bounded AI Edit bridge

## Deployed readiness update — 2026-09-19

Release `0.1.29-9` adds `POST /select-ready` with `{ "jobId": "...", "waitMs": 5000 }`. It observes and selects the next permitted control while owning the browser, allowing missing or disabled controls time to appear. `waitMs` is an observation-retry budget from 0 to 10,000 ms; an in-flight driver observation retains its existing transport timeout. The default is 5,000 ms. It returns the usual selection and observation tokens plus `observations` and `readinessMs`.

It does not execute actions, retry driver errors or model abstentions, navigate, or replay uncertain operations. Wrong origins/projects and changed job definitions stop immediately. Missing controls time out with `control_readiness_timeout`. Exact unique controls still use zero Jev calls; ambiguous permitted controls use the existing selector once. `/actions` keeps its fresh-target, receipt and postcondition checks. Existing `/snapshot` and `/select` callers remain compatible. The deployed workflow helper uses the new endpoint for new requests while preserving exact saved receipts. Deployment and benchmark evidence live in `tools/browser-readiness-20260919` in the project workspace.

Image revision `0.1.29-9` is deployed with the internal automation bridge and narrow upstream input-metadata patch. It preserves the same signed-in profile and private desktop. The previous active image was `0.1.29-7`; rollback files and a stopped-profile backup are in `/opt/captions-editor-bench/20260919-readiness/rollback` on the VPS.

## Assets and job policy

Host directory `/data/captions-editor-camoufox/assets` mounts **read-only** at `/app/assets`. The file picker exposes it through `/home/pwuser/Buena Uploads` and `/opt/gomoufox/Buena Uploads`. The currently staged video is `buena-original-drama3-14s.mp4`; use its actual SHA256 after any voice correction. Do not substitute older generated-audio versions.

Place `jobs.json` in the mounted config directory. Start from `config/jobs.example.json` (no authorized actions). The bridge rereads this policy for each operation. Example shape, with control names replaced by observations from the actual logged-in page:

```json
{
  "version": 1,
  "assets": [{"id":"buena-original-voice","file":"buena-original-drama3-14s.mp4","sha256":"ACTUAL_64_CHARACTER_SHA256"}],
  "jobs": [{
    "id":"buena-edit-proof",
    "assetId":"buena-original-voice",
    "prompt":"Keep the original voice and meaning. Add readable captions. Use supplied footage only.",
    "startUrl":"https://captions.ai/home",
    "steps":[{
      "id":"upload-source",
      "operation":"upload",
      "controls":[{"role":"OBSERVED_ROLE","name":"OBSERVED_EXACT_FILE_INPUT_NAME"}],
      "verifyText":"OBSERVED_UPLOAD_COMPLETION_TEXT"
    }]
  }]
}
```

Supported operations: `upload`, `fill_prompt`, `click`, `uncheck`, `export`. They execute the **next configured step**, never an operation supplied by an HTTP caller. `fill_prompt` uses only the saved job prompt. `uncheck` only sets a known checkbox to false. `export` uses the browser's observed download control and writes to `state/exports/<jobId>/export.mp4`; it does not publish anywhere. Other steps require an explicit visible-text postcondition. Mark a step `mayNavigate:true` only when its reviewed action legitimately opens the new test project.

Calibrate controls from actual DOM evidence. Future steps may be appended as new pages become visible, but completed steps and the job's asset/prompt/start URL cannot change. No raw selectors, file paths, JavaScript, credentials, or arbitrary navigation can be passed through the bridge. Labels for purchases, login/account changes, deletion, and publishing are rejected even if a policy accidentally includes them.

## HTTP contract (container loopback only)

All requests require `Authorization: Bearer <service_token>`. POST requires JSON and is limited to8KiB. This server remains at `127.0.0.1:8793` **inside the container**; no new port is published.

- `GET /status`, `GET /screenshot`: unchanged.
- `GET /snapshot`: previous snapshot fields plus `observationToken`, `observationAgeLimitMs`, `observeMs`.
- `GET /jobs`: permitted job IDs, status, and next calibrated step.
- `POST /select`: `{ "jobId":"...", "observationToken":"..." }`. An exact single match uses no model. Ambiguous permitted matches may use TypeSafe, if the private `TYPESAFE_KEY_FILE` exists. Returns observed `ref`, `selectionToken`, method, latency, confidence, or abstention.
- `POST /actions`: `{ "jobId":"...", "idempotencyKey":"unique-id", "observationToken":"...", "ref":"e12", "selectionToken":"optional-selection-token" }`.
- `POST /cancel`: `{ "jobId":"..." }`. Stops further steps; an already dispatched action is never silently undone.

Before dispatch, the bridge checks the approved asset's SHA256, saves an action receipt durably, then refreshes the DOM. Its semantic snapshot and unique target must remain unchanged. Only the refreshed target ref is dispatched. Another action or DOM snapshot cannot intervene through this bridge while it owns the browser. A human can still change the page; upstream ref validation is an additional check, not an absolute transactional guarantee.

Retries with the same idempotency key return the receipt. An uncertain browser outcome blocks new attempts until reviewed. Export receipts are **downloaded artifacts, not a verified AI Edit success**; the enclosing workflow must run ffmpeg/probe/caption checks and review the content.

## Metrics and limitations

Private `state/automation/events.jsonl` records job/step IDs, operation, outcome, selection method, retries, observation/model/action/postcondition/total time, and TypeSafe usage. It omits prompts, DOM labels, credentials, file bytes, and signed URLs. The0.8 model-confidence cutoff is an uncalibrated abstention heuristic; use the separate evaluation report for measured accuracy.

The offline fixture now exercises this actual bridge through upload → fill prompt → click → download, using real gomoufox refs. It records step timings and verifies the resulting synthetic MP4. It is not an account or paid editing test.

gomoufox v0.1.29 MCP has no tabs-list/select or native-window `NoViewport` option. The coordinated restart reopens the signed-in `/home` page in the MCP-owned page, using the same persistent profile. The owned viewport is1440×900 inside a maximized1440×1000 desktop. noVNC scales the desktop. Fully fluid manual browser-window resizing and adopting arbitrary manually opened tabs remain unsupported; no undocumented browser methods are claimed.

## Runtime additions validated for the real editor

The `observed-inputs-v3` patch is built from immutable upstream commit `98be4f2731d5be8922e83a59191d48358fedddcd` (v0.1.29). Archive SHA256: `95d53751b09af684217366e7b38b2d5a7fbf909c74759992d5a6bbba7b40eafa`. It changes only snapshot metadata and matching: associated labels; file input type, accept, hidden, multiple and disabled fields; native/custom checkbox checked state. Hidden file inputs appear only when the existing file-upload capability is enabled. Snapshot and reference resolution use the same script. No arbitrary evaluation or cookie capability is added.

Upload controls may include the exact observed `accept` string and `multiple` boolean to distinguish identically named inputs. TypeSafe receives that same metadata and the fixed asset filename/type when ambiguity remains. Upload steps must have `role: "file"` controls and must resolve to an observed `input_type: "file"`. A visible Add media button cannot be used as an upload target. The bridge checks checkbox state before dispatch and requires the unique configured checkbox to report `checked: false` afterward. Disabled controls are excluded.

Each step may set `verifyTimeoutMs` from 1,000 to 60,000. Slow asynchronous operations should verify an observed loading state, then poll read-only observations for completion. If a dispatched operation times out, `POST /reconcile` accepts `{ "jobId": "...", "idempotencyKey": "...", "reviewed": true }` and checks only that same immutable step's existing postcondition. It never repeats the action. Failed reconciliation leaves the job blocked; a successful one advances once. An export still remains `exported_unverified` until separate media validation.

`GET /network` returns only hostname, event kind, response status and count. Signed URL paths, queries, headers, bodies, and raw errors are omitted. A failed request is evidence for diagnosis, not proof by itself that the allowlist caused it. The observer, selector, action, cancel, reconciliation and network endpoints share one browser owner to prevent reference races.

Manual sign-in may create a tab outside gomoufox's owned page. This release has no MCP tab-adoption or fluid viewport feature. A graceful restart preserves the dedicated profile and opens one owned Captions home page at 1440×900 within the maximized desktop. noVNC uses scale mode; its window resize does not change the browser viewport.

### Saved draft resume and switch controls

Revision `0.1.29-4` recognizes actual ARIA `switch` roles and their `aria-checked` state. Standard associated labels remain preferred. If a switch has no accessible name, the snapshot reports `name: ""` plus `label_context`: observed text from the nearest small ancestor containing exactly one toggle. A policy for that control must include the exact observed `labelContext`; no guessed label or coordinate is accepted. `uncheck` accepts checkbox or switch and requires the matched control's observed checked state to become false.

The optional configuration field `resumeJobId` contains a permitted job ID, never a URL. The adapter resolves its destination only from that same job's durable `boundUrl`, verifies immutable job/step hashes and a verified navigation receipt, and requires a Captions `/projects/<id>` URL. This resumes an already saved draft after a graceful deployment without uploading again or opening unrelated projects.

### Reviewed recovery for an unchanged switch

Revision `0.1.29-5` uses one normal click for an ARIA switch only when its fresh observed state is `checked: true`, then verifies `checked: false`. An already-off switch is never clicked. Native checkboxes still use SetChecked. This avoids depending on the live editor's SetChecked compatibility.

`POST /recover-toggle` accepts `{ "jobId": "...", "idempotencyKey": "failed-toggle-action-id", "reviewed": true }`. It applies only to an uncertain `uncheck` receipt for the same unchanged next step and exact recorded project. A fresh snapshot must show one matching ARIA switch still on. The endpoint performs no mutation and does not advance the job. It preserves the failed receipt verbatim and records a separate `receiptRecoveries` observation authorizing a new action ID. It cannot recover clicks that create projects, renders, exports, purchases, or other operations.

New failed receipts retain only fixed upstream `browserFailure.tool`, `.code`, and `.reason` fields. Raw driver messages, selectors, page contents and signed URLs remain excluded. Historical errors whose details were discarded cannot be reconstructed.

Revision `0.1.29-6` also removes the upstream six-ancestor selector truncation. Full ancestry and unique IDs prevent repeated unnamed settings controls from resolving to multiple nodes. Ref resolution still requires the observed role, name, context, and checked metadata to match. A three-switch deep DOM regression fails against the previous image and passes against this revision, including unchanged neighboring switches.

### Delayed render navigation

`POST /reconcile-navigation` accepts only `{ "jobId": "...", "idempotencyKey": "verified-render-action-id", "reviewed": true }`. The receipt must belong to the latest completed immutable click step with `mayNavigate: true`. With no unresolved uncertain action, the endpoint takes a fresh snapshot and binds only an exact `/videos/<id>` child of the already owned Captions project. It accepts no caller URL, performs no browser mutation, preserves the original receipt, and does not advance the step count. A separate `navigationReconciliations` entry records the old/new URL and observation time. The recorded video URL is also a permitted persistent-profile resume target.
