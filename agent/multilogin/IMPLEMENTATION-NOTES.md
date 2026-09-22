# Current adapter provenance and integration boundaries

Source reviewed on 19 September 2026:

- `/Users/buena/.codex/.chatgpt-projects/g-p-6aa9333e75ec819191c885b0d61cc0e7/JEV-BROWSER-MULTILOGIN-HANDOFF.md`
- Current `captions-editor-camoufox/AUTOMATION.md`, `src/jev.mjs`, `src/automation.mjs`, `src/onboarding.mjs` and deployment configuration in that workspace.
- Sibling `buena-video-workflow/AUTOMATION.md` for coordinator/recovery behavior.
- `/Users/buena/Code/blockchain-rust-superteam-poland/agent/jev/src/jev.mjs` and its current working-tree status. Existing modified and untracked work was preserved.

This package stays separate under `internal-growth/multilogin` in the current task workspace. It does not modify the editor, its policy, the user's signed-in Captions profile, or the payment adapter. The older shopping mirror is not its runtime dependency on the VPS. The local development helper may resolve an already installed Playwright package from that workspace; the VPS installs its own pinned dependency.

## Adapted concepts

| Current editor concept | Social login implementation |
| --- | --- |
| Finite TypeSafe choices and an abstain option | `src/jev.mjs`: permitted observed actions plus `stop`; full probability distribution, selected-maximum, confidence and usage validation |
| Unique exact match avoids model latency | `createGuide`: a single permitted candidate uses zero model calls; real Jev handles multiple candidates |
| Private durable receipts | Atomic mode-600 state/report files, file/directory sync, before/after action events and profile lifecycle markers |
| Exclusive browser ownership | Batch registry lock, separate account-worker locks and lifecycle records, and unique browser-control endpoint ownership across up to five concurrent profiles |
| Fresh references | Observed element handles are checked again for visibility, enabled state, semantic signature, origin and form destination before execution |
| Independent postconditions | Exact account identity plus authenticated navigation/menu evidence; separate reopen verification |
| Coordinator account ownership | Stable account mapping and optional private character/platform registry; binding conflicts are not silently overwritten |

The model's 0.8 confidence threshold is inherited as a conservative heuristic, not a calibrated account-login success probability. No success rate or latency from the Captions editor is presented as Multilogin evidence.

## Deliberate pilot limits

Only login to supplied existing Instagram/Google accounts is implemented. New account registration, mailbox dependencies, TikTok and generalized goals remain outside this pilot. `recoveryEmail` is descriptive until a separately scoped mailbox adapter is implemented.

The pilot has CLI/library job submission and a private one-shot container worker. `batch-runner.mjs` (with `src/jobs.mjs`) adds a job layer over the existing account worker: one job owns one account, profile, browser attachment, profile lock and log directory, and several jobs run at once under one batch. A security checkpoint no longer ends the job immediately. The login flow can hand the checkpoint to a person and wait in the same live browser, because the provider's own pause is what a person resolves; the wait only observes, answers nothing, fills nothing, and its duration is added back to the login budget so a slow person does not fail the attempt. It does not yet expose the editor bridge's authenticated HTTP job/receipt protocol, a public API, browser takeover UI or production multi-tenant concurrency. Reports and lifecycle records support inspection and rerunning the same owned profile, but do not claim the full editor coordinator's action-ID replay/reconciliation protocol.

No screenshot evidence is captured during credential entry. Reports contain action types and verification outcomes; an attention event may include redacted visible text and control labels to diagnose an unfamiliar login screen. Input values, passwords, authenticator seeds and cookies are excluded. The test-marker cookie in the infrastructure smoke test is explicitly synthetic; it is not an imported merchant or account session.

The first actual Instagram login and same-profile restart verification passed on 19 September 2026. Live findings added bounded control readiness, cookie-choice priority, asynchronous form-transition checks, single submission per form stage, and a generic `Code` field rule restricted to explicit authenticator-app context. Request diagnostics keep only method, permitted origin, status and fixed network errors. See `VALIDATION.md` for exact run evidence and retained limitations.

The next five-account batch reached five simultaneous browser processes and independently completed four accounts; the remaining account reached an Instagram verification checkpoint. Known login fields now use a deterministic order, leaving Jev available for ambiguity. All 31 actions in that batch used fixed rules and zero model requests. This is bounded single-host concurrency with one exclusive registry owner; it is not a distributed job queue. Credential values still stay in memory.

The existing TypeSafe key is read only from the specifically approved Captions secret file into worker memory for live tests. This does not authorize using the Captions browser or its service token. A persistent Multilogin automation token has not been minted or stored.
