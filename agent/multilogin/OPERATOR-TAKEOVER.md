# Operator takeover for a human-verification checkpoint

How a person interacts with the **same** persistent Multilogin browser while a job is
stopped at `waiting_for_human`. This path already exists in the deployment; nothing in
this document adds a new remote-control system.

## The existing path: headed browser on the shared X display + VNC

The Compose project runs three services:

| service | role |
| --- | --- |
| `launcher` | Multilogin launcher; starts the profile browser and returns its CDP port. Runs with `DISPLAY=:99` and the shared X11 socket + Xauthority cookie. |
| `viewer` | `Xvfb :99 -screen 0 1920x1080x24` + `x11vnc`, publishing **`127.0.0.1:5901`** on the host. |
| `worker` | the job kernel; shares the launcher's network namespace. |

Because the launcher starts the browser on `:99` and the viewer serves that display over
VNC, a person sees and drives the exact browser the job is holding.

Proof of the path in this deployment:

- `x11vnc` and `Xvfb :99` running in `buena-multilogin-viewer-1`;
- `127.0.0.1:5901` answering the RFB handshake (`RFB 003.008`);
- `buena-multilogin-launcher-1` with `DISPLAY=:99`;
- `private/operator-view/display99-headed-proof.png`, a 1920x1080 capture of that display.

### Connecting

```bash
# VNC is bound to host loopback only, so tunnel it over SSH (Tailscale + SSH already
# reach the host). Leave this running.
ssh -N -L 5901:127.0.0.1:5901 root@100.121.5.10

# then point any VNC client at localhost:5901
# the password is in /opt/buena-multilogin/private/vnc-password (mode 600)
```

## What is guaranteed during `waiting_for_human`

| guarantee | why |
| --- | --- |
| the profile/browser stays **running** | `api.start` was called; nothing calls stop until the flow returns |
| the profile **lock stays held** | `MultiloginSessionProvider.claimOwnership` takes `locks/profile-<profileRef>.lock`; it is released only in `detach()` |
| cookies/session/profile state are **not cleared** | the wait only observes; the only stop/sync is the graceful one after the flow ends |
| the browser is **not auto-stopped** while solving | `waitForHuman` polls `observe()`; no stop path runs during the wait |
| the wait **does not consume the login budget** | `login.mjs`: `deadline += Number(paused.waitedMs) \|\| 0` after the checkpoint resolves |
| a **concrete takeover exists** | the VNC display above |

`waitForHuman` never answers, fills, classifies-and-clicks, rotates a proxy, changes a
fingerprint, clears a profile or creates a replacement. It re-observes every
`humanCheckpointPollMs` (2 s) and resumes **only** when the challenge surface is gone
(`snapshot.challengeFrame !== true` and the page no longer classifies as the checkpoint).

## Operator sequence

1. **Wait for the checkpoint.** The job writes
   `<data>/jobs/<jobId>/screenshots/NN-checkpoint_<reason>.png` and transitions to
   `waiting_for_human`.
2. **Announce it** (photo preview + byte-identical PNG document, with checkpoint / job /
   account / profile / expiry):

   ```bash
   node scripts/checkpoint-announce.mjs --job /data/account-pilot/jobs/youtube-live-04 --seconds 1800
   # --dry-run prints the record without saving or sending
   ```

   `announceCheckpoint` reuses an existing waiting checkpoint instead of sending a second
   alert, and never re-captures, resizes or re-encodes the job's image.
3. **Solve it in the VNC browser.** A human clears the challenge; nothing is automated.
4. **The job re-observes and continues.** The live re-observation is the gate — not the
   `/done` message. `/done <checkpoint>` from the allowlisted Telegram account is an
   operator confirmation; the batch poller has no browser session of its own and therefore
   replies `challenge still present (verification_unavailable)` while the job is still
   waiting. Trust the job log, not that reply.
5. The flow then verifies the signed-in identity, runs Studio verification when part of the
   job, stops/syncs gracefully, reopens the same profile and proves restart persistence.

## Expiry

`humanCheckpointSeconds` (default 600, max 7200) bounds the wait; pass
`--human-checkpoint-seconds` or set it in the config. Generous values are safe: waiting is
credited back to the login budget. On expiry the job ends with `human_checkpoint_timeout`.

## Known gaps (not blockers)

- `--preserve-on-checkpoint` is accepted by the CLI and threaded through
  `wrapProfileApi`, but `preserved.active` is never set to `true`, so the flag currently
  has no effect: after a checkpoint the browser is stopped by the normal teardown. A
  generous `humanCheckpointSeconds` is the working answer today.
- The VNC display is shared and password-protected on host loopback. It is acceptable
  because the socket is shared only by the launcher and viewer containers and the port is
  loopback-bound; dropping `-ac` (stable container hostnames + one Xauthority entry per
  hostname) is the durable follow-up noted in `compose.yaml`.
