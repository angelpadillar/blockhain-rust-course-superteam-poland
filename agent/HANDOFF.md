# Handoff — browser-control work

Prepared 20 September 2026. Entry point: PR #5, branch
`devin/browser-control-import`. Read `BROWSER-METHODS.md` first — it is
the inventory of every method, its measured results, and the plan this
handoff continues.

## The goal

Generalize the shared control loop into one runtime so the browser can
be driven for any use case:

```
observe (DOM) → constrain (task/job policy) → deterministic rules →
Jev typed choice only for ambiguity → execute → independent verify →
private evidence
```

Site adapters supply observation, permission and verification; the
loop itself is site-agnostic. **The known gap is the NL→plan compiler**
(v4 prose plans went 0/6 — see `jev/benchmarks/browser-runtime-v4/`),
not browser control.

## Layout under `agent/`

| Dir                                    | What                                                                                                                                                                                       | Live state                                                                       |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------- |
| `multilogin/`                          | Multilogin X account pilot: one cloud profile per account, Playwright-over-CDP, Instagram + YouTube/Google adapters, local TOTP, bounded proxy rotation, stop/reopen identity verification | **Deployed and running** on the VPS                                              |
| `jev/`                                 | Glovo prepare-only adapter + experimental runtimes (v3/v4) + all benchmarks                                                                                                                | Persistent Glovo profile saved on VPS (`jev-hackathon` compose project, stopped) |
| `delio-worker/`                        | Delio.com.pl adapter, Camoufox profile, registration + cart/quote/coupon probes                                                                                                            | Snapshot — **live copy runs on the VPS**, resync before editing                  |
| `captions-editor/`                     | Captions AI editor bridge (Camoufox/gomoufox 0.1.29-9), snapshot/select/action tokens, bounded job policy                                                                                  | Snapshot of deployed project                                                     |
| `captions-editor-agent/` (+`-deploy/`) | Earlier Chromium editor adapter                                                                                                                                                            | Superseded by `captions-editor/`; 0 verified live exports                        |
| `captions-editor-eval/`                | Jev selection eval                                                                                                                                                                         | 15/15 live choices, p50 233 ms                                                   |
| `browser-readiness-20260919/`          | Readiness benchmark incl. OCR-vs-accessibility desktop comparison                                                                                                                          | Evidence archive                                                                 |
| `trust/`                               | Approval/evidence prototype — mandatory screenshot receipts at quote/approval/confirmation                                                                                                 | Prototype, not wired to payments                                                 |
| `evaluation/`                          | Earlier live Glovo benchmark (Jev vs supervised Codex, ~5.6×)                                                                                                                              | Evidence archive                                                                 |
| `hackathon-handoff-20260919/`          | Prior handoff bundle                                                                                                                                                                       | Context                                                                          |

## VPS layout (`root@100.121.5.10`, host `buena-prod-01`)

- `/opt/buena-multilogin` — deployed copy of `agent/multilogin`
  (compose project `buena-multilogin`; launcher `https://launcher.mlx.yt:45001`,
  loopback only). Private state: `private/account-pilot/`
  (profiles.json, per-account dirs, reports).
- `/opt/buena-delio-worker` — live copy of `agent/delio-worker`;
  container `buena-delio-worker`, VNC `100.121.5.10:6094`, state in
  `/data/buena-delio` (includes the persistent `delio-owner` Firefox
  profile and the Jev ledger `state/jev/jev-cart-choices.jsonl`).
- `/opt/jev-hackathon` — live copy of `agent/jev`; volume
  `jev-hackathon_jev-data` holds the onboarded Glovo profile.
- `/opt/captions-editor-*`, `/data/captions-editor-*` — captions
  deployments; the `buena-captions-editor-camoufox` image also hosts
  the Delio worker.
- Secrets live only on the VPS: `private/secrets/` under each project
  (`service_token`, `typesafe_key`, `vnc_password`, …). Mode 600/700.
  A 1-month Multilogin automation token is at
  `/opt/buena-multilogin/private/automation-token` (~Oct 19 expiry).

## Invariants — do not relax

- Jev receives only permitted, already-observed action descriptions —
  never passwords, TOTP seeds, cookies, tokens, or raw page content
  containing secrets.
- Callers choose among policy-permitted actions only; no
  caller-supplied selectors, JS, navigation or file paths.
- "Completed" requires independent verification — model self-reports
  (incl. Jev confidence) are never proof.
- Exports/checkouts are `*_unverified` until separately validated;
  payment, publishing, account-change and deletion labels are rejected.
- Graceful browser stop before Multilogin profile stop so cloud
  storage syncs; never silently duplicate profiles after uncertain
  lifecycle operations.
- Secrets, session state and private configs stay out of git; the two
  real Gmail addresses in `multilogin/VALIDATION.md` are the only
  known account identifiers committed — scrub if the repo goes public.

## Next steps (from BROWSER-METHODS.md)

1. Extract the shared loop into one runtime; port adapters onto it.
2. Fix + re-evaluate the NL→plan compiler on held-out wordings.
3. OCR/screenshot fallback only behind the DOM reader's
   "cannot represent" signal.
4. Standardize metrics: verified-success rate, p50/p95 wall time,
   model calls/cost per success, fallback and abstention rates.

## Open operational items

- `franciscomorelos91@gmail.com` — Google `signin_rejected` after proxy
  rotation; needs a full recovery email or replacement account.
- `sstepney77@gmail.com` — verified, but Google birthday interstitial
  still pending (does not block YouTube).
- Delio worker reports `blocked` — merchant session, delivery
  confirmation and cart calibration unverified.
