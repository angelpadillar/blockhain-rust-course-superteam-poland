# Buena AI — Kraków / Superteam Poland hackathon handoff

Prepared 19 September 2026, Europe/Warsaw. User says tomorrow is the final hackathon day. September 19–20 is the planning assumption; event schedule and submission deadline were not independently checked. This is a context and execution-plan handoff, not a claim that the proposed integration is complete.

## 1. The clear goal

**By the final presentation, demonstrate one repeatable gifting workflow: a recipient brief becomes a gift choice and an exact quote; a sender authorizes bounded spending on Solana; a VPS browser executes only the permitted sandbox action; an independent verifier produces a receipt. A changed quote and a repeated attempt must be rejected.**

Minimum dependable demo: real browser automation against a controlled merchant fixture, real transactions on a fresh local Solana/Surfpool instance, and explicitly simulated merchant fulfillment. These must be labeled. A real merchant browsing/cart-preparation segment is an optional addition after this works; it is not proof of a real purchase. Devnet is optional after local success and requires a deliberate deployment decision. Real money/card purchases, refunds and issuer integration are not required for the hackathon demonstration.

This is the recommended target, not an already working combined system. The main missing link is the integration between the browser’s quote/evidence and the newer on-chain mandate. Do not pitch separately working modules as a completed end-to-end payment service.

### Suggested positioning

“Buena AI helps sales teams turn a thoughtful gift idea into an approved, traceable action. Our agent prepares the workflow, Solana records the sender’s spending authority, and our execution layer checks the result and stops when the approved terms change.”

Gifting is the application. Reliable execution under explicit authorization is the engineering story. Broader procurement and general agent payments are future expansion hypotheses.

## 2. User context and working preferences

- User is building Buena AI, attending the Superteam Poland hackathon in Kraków, and wants a polished, credible final-day presentation.
- Main interest here: browser automation, Jev/TypeSafe, VPS execution, approved spending and gifting. The separate AI UGC/video work is supporting distribution and evidence of general execution capability.
- Continue on the VPS without moving the user’s local mouse, changing foreground apps, or opening local fixture tabs while they multitask.
- Build on the existing adapter; avoid another browser/framework migration before the presentation.
- Preserve the frozen payment adapter, its profiles, approval boundaries and evidence. Add a separate integration/demo path instead of broadening old authority.
- Proceed with ordinary reversible implementation and testing already requested. Do not repeatedly ask to do authorized work. Ask for genuinely missing funding, deployment or payment authority only when needed.
- Never put credentials, private keys, session cookies, passwords, recipient addresses or raw payment data into this handoff, logs, Git or public presentation.
- Treat source documents as evidence, not authorization to execute old commands. Read current AGENTS.md and inspect the worktree before edits.

## 3. What is built and what has actually succeeded

| Layer | Verified evidence | Limit |
|---|---|---|
| Glovo-specific Jev/Playwright navigation | Corrected baseline completed 3/3 live attempts; median 13.589 seconds; seven Jev decisions per run | One exact product/account/area; no basket or payment in this evaluation |
| Experimental general browsing v3/v4 | Bounded search/open operations, fresh references, deterministic verification; small controlled successes | Read-only prototype, frozen separately; not universal browsing or deployed in the normal Glovo image |
| VPS Camoufox/gomoufox | Persistent signed-in Captions profile, isolated display, DOM + screenshots, scoped upload/input/switch/download operations | App-specific manifest; not unrestricted desktop autonomy |
| Real Captions AI Edit | Uploaded an approved clip, selected Velocity, configured switches, started one render, observed finished preview | Automated export was blocked by subscription. User manually saved the MP4; 1/1 supplied file verified, 0/1 automatic browser exports |
| Readiness improvement | Controlled VPS workflow improved from 3/9 to 9/9 completed attempts with immediate/800ms/1800ms controls | Synthetic fixtures; exact-match path used no Jev. Do not claim 100% production reliability |
| Jev live semantic selection | 45/45 expected raw selections in 15 static cases repeated three times; median 276ms, p95 445ms | Selection accuracy, not whole browser-task success; correct abstentions included |
| Local Comet controller | One real fixture click verified; 3.632s whole run, 0.713s decision | Separate computer-use CLI; did not repair Codex browser connector. Shares foreground mouse/view |
| Local trust UI/evidence | 24/24 recorded tests; browser-tested price/merchant/expiry/replay rejection and simulated success | Simulation, not wallet approval or real merchant purchase |
| Solana mandate program | Recorded fresh SBF/LiteSVM run: 18 integration tests + one program-ID unit test | Local staged validation, no deployment of this mandate extension established; executor/CLI not wired to it |
| Captions API + media production | Finished character-bound video exports, original voice preservation, deterministic decode/hash checks, mobile review | Separate API/media workflow; not proof of browser checkout or payment integration |

All counts above are recorded cohorts, not newly rerun in this handoff. Never pool unrelated selection, fixture, navigation, export and contract tests into one “success rate.”

### Important history: unsuccessful experiments remain evidence

- Glovo had URL rollback because a route guard blocked a product-display POST under a store-address path. A narrow exact endpoint/body exception fixed that without allowing cart/address mutations. Earlier failed attempts remain recorded.
- Later navigation-speed experiment: baseline 3/5, richer v1 0/2, v2 0/1. No demonstrated improvement; keep the proven baseline as a regression case.
- Amazon cold preflight hit WAF-related loading failure before model evaluation. No model speed/cost winner was established.
- Local Comet OCR/accessibility experiment: 14/16 complete. Guarded follow-up: 9/16; additional focus/context stops. It was not promoted as an improvement.
- Captions: login compatibility, upload, edit and preview worked. Subscription/download was a distinct blocker. Share-link capture/export automation was not completed merely because the user could save a video manually.

## 4. Architecture to carry forward

Application request → bounded task contract → session owner/profile lock → fresh browser observation → permitted action candidates → exact deterministic choice OR Jev ambiguous choice → guarded execution → independent postcondition → durable receipt.

- Code owns permissions, literal arguments, budgets, timing, state transitions and verification.
- Jev chooses among supplied, currently observed permitted options and can return none. Confidence is not permission or proof of success.
- A general model may plan unfamiliar tasks or write new text. It is not needed to copy an already known merchant or product string.
- DOM/accessibility first; visual parsing only when relevant controls are absent. Jev consumes textual/structured candidates, not screenshots directly in this implementation.
- Exact unique permitted controls use zero model calls. This is a useful cost property, not evidence of free end-to-end operations.
- Re-observe after transitions. Never use stale element coordinates, repeat an uncertain mutation, or infer payment failure from a browser timeout.
- Account/profile state is dedicated per application; no sharing Captions cookies with shopping or payment contexts.
- MCP is an interface, not the authorization boundary. The scoped controller remains responsible for policy.

## 5. Browser implementation and VPS facts

Host: buena-prod-01, Tailscale 100.121.5.10. SSH: root@100.121.5.10 using the existing authorized identity/1Password agent. User’s laptop address 100.117.208.119 is not the VPS.

### Captions browser — latest verified deployment

- Image: buena-captions-editor-camoufox:0.1.29-9, gomoufox upstream v0.1.29 with the narrow observed-input metadata patch.
- Service/state directory: /data/captions-editor-camoufox.
- Expected container: captions-editor-camoufox-onboarding-1. Confirm current name before using it.
- Private desktop: http://100.121.5.10:6093/vnc.html?autoconnect=1&resize=scale . Retrieve the existing password through the authorized secret mechanism; no password is included here.
- Internal authenticated bridge: container loopback 127.0.0.1:8793. Not a public API. Raw gomoufox MCP/daemon port remains unpublished.
- Private profile: state/profiles/captions-trial; exclusive owner; nonroot UID1001, 2CPU/4GiB RAM/1GiB shared memory; no-new-privileges and reviewed seccomp.
- Owned viewport 1440×900. noVNC scales the display; fluid viewport resizing is not supported. Do not make window resizing part of the demo.
- Read-only approved upload assets: /data/captions-editor-camoufox/assets → /app/assets. A job manifest binds exact asset IDs/hashes and allowed operations.
- No arbitrary URLs, selectors, filesystem paths, JS execution, cookie export, purchases or publishing through the bounded bridge.
- The user explicitly approved Captions’ storage.googleapis.com upload connection. This does not authorize uploads of unrelated files or broader network expansion.

New internal POST /select-ready waits for a permitted control with a default 5s/max10s observation budget, retains one owner, and checks the unchanged job/project. It returns fresh selection/observation tokens. Missing/disabled controls can become ready; model abstentions, driver errors and uncertain actions do not get blindly retried. /actions still checks targets, receipts and postconditions.

Deployed workflow helper: /opt/buena-video-workflow/advance-editor.mjs. Coordinator: /opt/buena-video-workflow/coordinator.py. A saved-token finite run has time/action bounds; only verified postconditions advance it. Delayed generated-video navigation is reconciled read-only within the same recorded project.

Last saved post-deployment check: ready_for_observation, runtime healthy, recorded project resumed, 12 controls, Download present, zero sign-in controls. Last exact-release fixture: 27/27 checks in 6.706s.

**Freshness caveat:** a bounded SSH recheck timed out; the other read-only SSH attempt then failed because the 1Password agent could not sign the authorized key and the server disconnected after too many authentication failures. This does not establish a VPS outage. The above browser health is the saved September 19 deployment verification, not a newly confirmed live observation. Earlier in this conversation the VPS media service was reachable and six silent video links were verified. First action in the next chat: bounded read-only current health/ownership check; do not assume that saved login or health remains current.

Rollback: /opt/captions-editor-bench/20260919-readiness/rollback. Previous active image 0.1.29-7; an old compose file mentioned unused -8. Use the recorded actual image, not that stale tag. Consistent profile/state backup retained. Other services were not restarted for this release.

### Glovo/payment browser — separate stack

- /opt/jev-hackathon; Compose project jev-hackathon; volume jev-hackathon_jev-data.
- Recorded ports: API8787, onboarding6088, setup controller6089. Old deployment note says stopped; inspect before starting anything.
- Existing merchant-specific Chromium/Playwright service is not the Camoufox editor service. Normal Docker image excludes experimental v4.
- Never inherit old navigation-only authority as permission to buy. Do not reuse the historical alcohol navigation case as a gifting presentation example; choose an office-safe gift scenario.

### Hypit/media — supporting work

- Creator http://100.121.5.10:5179; Studio5178 when started.
- Container studio-flqieibyhw22fgilpemvnboy.
- /data/hypit/workspace on host → /workspace in container.
- Review http://100.121.5.10:8794/ through Tailscale. This is the video review page, not the hackathon approval UI.
- Do not modify unrelated Coolify services or global host settings.

## 6. Measurements suitable for slides

### Timing-readiness experiment (VPS, September 19)

| Scenario | Before | After | Median successful duration after |
|---|---:|---:|---:|
| Immediate control | 3/3 | 3/3 | 5.952s |
| 800ms delayed control | 0/3 | 3/3 | 6.544s |
| 1800ms delayed control | 0/3 | 3/3 | 7.709s |
| Total controlled trials | 3/9 | 9/9 | Report by scenario |

Each completed fixture did synthetic upload, prompt fill, switch changes, fixture edit, MP4 download and 27 browser/media assertions, including hash/dimensions/duration/full decode. Old-path failures occurred before upload. Runs alternated order. No paid Jev inference or Captions render in this cohort; VPS cost remains attributable infrastructure, not zero.

Additional release checks: 59 local adapter/selection tests, six helper tests, 33 coordinator tests. These are regression tests, not production tasks.

### Live Glovo navigation (September 17)

3/3 independently verified exact-product pages; median 13.589s; estimated Jev-only cost $0.00031479/run at the then-configured price. Excludes setup, VPS, developer/operator work and any larger planner. Seven Jev calls/run. This is approximately $0.0003 of model inference, not a claim that an order costs that much.

### Jev selection (September 19)

45/45 expected raw choices on a repeated 15-case dataset; median 276ms, p95 445ms. 53,415 input/3,315 output tokens. Dollar billing not verified. Includes expected abstention and overlapping confidence-threshold categories; do not label all 45 as actions performed.

## 7. Solana trust layer: exact status and caveats

The newer Anchor mandate binds a sender-signed one-use authorization to campaign, executor, merchant/specification/recipient commitments, currency/exponent, card-charge cap, escrow-debit cap and expiry. Mandate-aware quote approval and payment-attempt instructions re-check the exact domain-separated digest; the attempt atomically consumes the mandate. Tests cover mutation, expiry, revocation, wrong actors, replay, legacy bypass and late settlement.

Do not conflate these two authority models:
1. Legacy exact-quote sender approval per gift.
2. New sender preauthorization with an executor allowed to approve a matching quote within immutable bounds.
Choose the actual tested mode for the demo and explain it accurately. The newer mandate does NOT mean the sender signs every exact quote again.

**Integration gaps:**
- The local browser trust demo uses canonical JSON quote hashing. The Rust mandate uses its own domain-separated encoding. They are not currently one protocol.
- Existing card executor/CLI has not been switched to the new mandate instructions.
- Current campaign account layout changed. Use fresh local accounts; no unreviewed migration of existing deployment accounts.
- New mandate deployment/real merchant payment/issuer-backed restricted card is not established by these reports.
- Hashes preserve committed bytes, not truth about a website, shipping address or delivery. Fulfillment/oracle observations remain trusted inputs.
- Card and escrow caps are independently enforced; FX metadata is not verified conversion arithmetic.
- An ambiguous external payment requires reconciliation, not automatic retry, refund or another card issuance.

Keep payment flags off for the rehearsal. A controlled merchant fixture can record a simulated order after the real local-chain mandate is consumed, clearly labeled. This gives an honest integration test without claiming a real charge.

## 8. Competitive research supplied by the user

September 18 Colosseum Copilot research recommends gifting as the initial market, with differentiation in gift relevance, reliable execution and measurable customer outcomes. This handoff summarizes that research; it is not a fresh competitive/legal audit. The reported Colosseum Copilot v1.2.1 installation/authentication was completed in another task; do not copy its token. Discover the installed skill if another research pass is needed.

Key precedents: Mercantill/Squads spending controls; AP2 checkout/payment commitments; Sendoso and Reachdesk MCP gifting; SP3ND.shop URL→crypto-funded purchase concept; Crossmint, Agentcard and Ramp scoped-card products. Submitted project descriptions and vendor announcements do not prove production reliability. Crossmint’s September 17 card vault announcement described browser checkout as pre-release in the reviewed source.

Avoid claims of “first agent spending controls,” “no gifting competitors,” “the agent structurally cannot steal,” universal checkout, or regulatory exemption from using escrow. The stronger claim is what the prototype demonstrably enforces and how it handles exceptions.

After the hackathon: a 25-gift operational pilot alongside paid sales-team pilots. Measure approval rate, completed delivery, human-intervention minutes, total variable cost, qualified conversations and repeat demand. Investor gifts/public reactions demonstrate distribution, not validated recurring enterprise demand. Partner/issuer and actual funds flow require separate assessment before live financial commercialization.

## 9. Announcements and tools: carry forward the decision

Recorded September 19 source review recommends keeping the existing Camoufox adapter. Cua’s capture/snapshot-bound action contract is a promising idea to evaluate in an isolated Linux session, not a reason to swap the working stack now. Recorded research: jev-use PR #3916 merged as an example; PR #3943 perception work draft; no Cua Driver binary or perception weights tested here. These are as-of-review statuses, not guarantees of current GitHub state.

jev-ultrafast isolated checkout passed 31 offline tests; MVP gaps included uploads, iframes, canvas and other editor needs. Do not claim it replaced the editor. CUA-S1 was not verified as a drop-in controller. Local typesafe-computer-use is macOS-specific and manipulates foreground UI; use only by explicit local-computer request.

## 10. Next-chat execution order

1. Read this handoff and current repository AGENTS.md; inspect git status. The main repo has substantial modified/untracked user work. No reset/clean or blanket replacement.
2. Confirm actual deadline and submission format from the user/event material. Use the time blocks in TODAY-TOMORROW.md until exact hours are known.
3. Check VPS SSH, service health, profile ownership, active jobs and artifact paths read-only. Do not disturb the Captions session or start stopped shopping profiles blindly.
4. Inventory the actual new mandate client/types and integration gap. Pick one exact representation and verify it against the independent Rust digest vector.
5. Build one fresh, isolated gifting demo: one office-safe recipient, one selected gift/merchant, one quote/mandate, one test fulfillment result. Reuse observed-action/verification/journaling patterns without mutating the frozen payment adapter.
6. Establish the happy path first; then price-change and replay rejection. Record every attempt, stop and intervention. Make evidence inspectable from one review screen.
7. Rehearse three consecutive end-to-end runs against the same declared fixture; no hidden manual browser clicks. Record truthful wall time and all attributable costs. Then try one live merchant browsing/preparation case if time permits, clearly separated from fixture results.
8. Freeze, record a 90-second backup demo, prepare a 3-minute presentation and a one-page architecture/metrics slide. Do not spend the last hours adopting new agent stacks or generating more marketing characters.

No implementation of this proposed integrated demo was performed during the handoff turn.

## 11. Definition of done for the final-day build

- One reproducible start procedure and one clean reset procedure using fresh local campaign accounts.
- One real browser run linked to one real local-chain campaign/mandate identifier and one independently verified test receipt.
- Exact amount/currency/merchant/item/recipient commitments visible in the approval record; recipient PII stays private.
- At least 3 consecutive happy-path rehearsals from fresh test state; report failures too.
- Price/merchant mutation invalidates authority; replay yields no second execution. At minimum show price-change and replay live, retain the rest as tests.
- Every irreversible/simulated-fulfillment boundary has fresh observations and screenshot evidence; state labels distinguish prepared, authorized, attempted, confirmed and uncertain.
- Status/metric display identifies fixture, live browser, local Solana/devnet, manual intervention and unknown cost explicitly.
- 90-second backup recording; 3-minute talk; README; judges can inspect the evidence.
- No claim of real delivery/charge, autonomous refund, bank-grade security or general-browser accuracy without corresponding proof.

## 12. Files and entry points

Main hackathon repository: /Users/buena/Code/blockchain-rust-superteam-poland
Current browser/media workspace: /Users/buena/.codex/.chatgpt-projects/g-p-6aa9333e75ec819191c885b0d61cc0e7
Older experiment mirror: /Users/buena/Documents/ChatGPT/typesafe-ai-experiment

Read in this order:
1. /Users/buena/Code/blockchain-rust-superteam-poland/agent/jev/PROJECT-DIRECTION.md
2. /Users/buena/Code/blockchain-rust-superteam-poland/agent/jev/benchmarks/method-comparison/REPORT.md
3. /Users/buena/Code/blockchain-rust-superteam-poland/agent/jev/BROWSER-SERVICE-HANDOFF.md
4. /Users/buena/.codex/.chatgpt-projects/g-p-6aa9333e75ec819191c885b0d61cc0e7/tools/browser-readiness-20260919/VPS-RESULTS.md
5. /Users/buena/.codex/.chatgpt-projects/g-p-6aa9333e75ec819191c885b0d61cc0e7/tools/browser-readiness-20260919/vps-deployment-verification.json
6. /Users/buena/.codex/.chatgpt-projects/g-p-6aa9333e75ec819191c885b0d61cc0e7/captions-editor-camoufox/AUTOMATION.md
7. /Users/buena/.codex/.chatgpt-projects/g-p-6aa9333e75ec819191c885b0d61cc0e7/captions-editor-camoufox/README.md
8. /Users/buena/.codex/.chatgpt-projects/g-p-6aa9333e75ec819191c885b0d61cc0e7/buena-video-workflow/AUTOMATION.md
9. /Users/buena/.codex/.chatgpt-projects/g-p-6aa9333e75ec819191c885b0d61cc0e7/buena-video-workflow/PROOF.md
10. /Users/buena/.codex/.chatgpt-projects/g-p-6aa9333e75ec819191c885b0d61cc0e7/captions-editor-eval/LIVE-BENCHMARK.md
11. /Users/buena/Code/blockchain-rust-superteam-poland/agent/trust/README.md
12. /Users/buena/Code/blockchain-rust-superteam-poland/agent/trust/VALIDATION.md
13. /Users/buena/Code/blockchain-rust-superteam-poland/agent/trust/ONCHAIN-VALIDATION.md
14. /Users/buena/.codex/visualizations/2026/09/18/01a0b431-63d1-7d62-bccf-20ac3e2a7dde/buena-landscape-2026-09-18.md

Useful existing local commands (inspect current package/toolchain first; these are instructions for the next task, not commands executed here):
- Repo root `npm run demo:trust`: local simulated approval UI, normally port4317.
- Repo root `npm run test:trust`: trust/evidence regression suite.
- Anchor/LiteSVM build/test commands: read ONCHAIN-VALIDATION.md for the exact staged toolchain and source fingerprints; do not assume old README test counts describe newer source.
- Camoufox directory `docker compose exec -T onboarding node scripts/observe.mjs status`: scoped read-only browser status using the internal token handling. Do not print secret files.
- Benchmark code/data: tools/browser-readiness-20260919 in the current workspace. Run isolated fixtures with networking disabled and separate state, never against an unrelated signed-in page.

## 13. Video-work context, only if needed

K01Sophia/saleswithsophia, K02Ruby/rubyfindsai, K03Lena/lenatalkssales, K04Maya/mayagrowthtips, K05Nina/b2bwithnina, K06Chloe/chloesalestips have stable character IDs/revisions and assigned Fish voices. Exact bindings live in manifests, not ad-hoc renamed files. User chose Captions/Mirage API styled speech captions; currently Altair available among requested styles. Editorial hooks are separate layers, no black headline boxes; brand is Buena AI; supplied large Claude+Buena logo pair.

Latest delivered media: four newly generated silent surprised reactions (K01–K04) plus two clearly labeled existing-footage alternatives (K05–K06), all 20.5s/1080×1920/no audio. K05/K06 new generation hit ReAPI HTTP402; about$5 top-up requested, not yet confirmed. Earlier fal reference upload403 was recovered by reusing byte-identical previously hosted references in the same saved jobs without new reservations. No service code or spending limit was changed. This is separate from browser automation testing.

Media evidence: /Users/buena/.codex/.chatgpt-projects/g-p-6aa9333e75ec819191c885b0d61cc0e7/buena-video-workflow/silent-six-20260919/{WORKFLOW.md,delivery.json,BLOCKERS.json,mobile-verification.json}. Previous talking videos preserved at http://100.121.5.10:8794/emotional-hooks.html . Do not divert the hackathon build into more video generation unless the user asks.
