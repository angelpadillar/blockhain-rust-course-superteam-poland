# Current private VPS deployment

- Host: `buena-prod-01`, Tailscale IP `100.121.5.10`.
- SSH: `ssh root@100.121.5.10`, authenticated using the existing 1Password SSH agent.
- Directory: `/opt/jev-hackathon`.
- Compose project: `jev-hackathon`.
- Browser image: `jev-hackathon-onboarding`.
- Persistent volume: `jev-hackathon_jev-data`.
- Account setup: verified and saved for the user-approved Home test destination. `jev-hackathon-onboarding-1` has exited normally after finishing setup.
- Private browser (only while onboarding runs): http://100.121.5.10:6088/vnc.html?autoconnect=1
- Finish setup (only while onboarding runs): http://100.121.5.10:6089/

The browser runs on the server. Open the private browser link from a device connected to the same Tailscale network, sign into Glovo, select the configured delivery destination and merchant, and leave the basket empty. Then use the finish-setup page. That check closes the browser and saves the session for later jobs. No purchase should be made.

The default repository Compose bindings are loopback. This deployment sets `JEV_BIND_IP=100.121.5.10` in its private `.env`, so no SSH forwarding is needed for these links. Do not expose the onboarding desktop on the public interface.

The API service is not running yet. Evaluation keys were supplied through hidden stdin and retained only in process memory; no key is saved in the server environment file. Account setup is confirmed. Before the first shopping job, configure API secrets and an available merchant; Duży Ben was unavailable at the selected home address. The saved marker does not claim that the basket or store is ready. Preserve the existing named volume. This is a separate Docker Compose stack alongside the existing Coolify applications; it is not yet registered in Coolify's dashboard.

The earlier address `100.117.208.119` was the laptop's Tailscale address. Its refused SSH connections were unrelated to the VPS or 1Password authorization.

Linux validation: the image built successfully and all five browser integration tests passed with sandboxing enabled. The browser and confirmation HTTP pages were verified reachable over Tailscale.

Account/address setup is complete. Browser containers are stopped and the profile is unlocked; desktop links are offline. `scripts/navigation-desktop.mjs` preserves the manually confirmed tab and uses a Start three navigation runs page instead of closing setup. Navigation scripts and cases are now included in the Docker build alongside the adapter source. The rebuilt onboarding image can run the evaluation entry point without development source mounts. See NAVIGATION-REPORT.md for measurements and restart instructions.

The account holder explicitly authorized repeating their existing 18+/Glovo age-and-terms declaration solely for this navigation-only case. Use `--repeat-confirmed-age` with the fresh-browser evaluation for that authorized action; do not ask again for the same scope in this task. The handler ran successfully in the ninth attempt. Ten development attempts are recorded with no independently verified target-page pass, basket action or purchase. The agent reached the exact target URL in 14.518 seconds for approximately $0.000298, but the title was not verified. A delayed-title readiness fix passed browser tests; its live retry encountered Glovo's problem page. Total estimated model cost across all attempts: $0.001856442.

New runs retain private journals under `/app/data/navigation/runs/` in the existing volume. These save the task contract, source fingerprint, decisions, confidence/probabilities, pending actions, outcomes and verification. Interrupted work is marked for inspection at the next locked run; it is never automatically replayed. Project intent and current scope are saved in PROJECT-DIRECTION.md.
