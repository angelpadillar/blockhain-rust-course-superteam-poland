# will_escrow deployments

## Devnet

Deployed and initialized 2026-09-30 with `scripts/deploy.sh devnet` and
`clients/will-escrow-ts/scripts/initialize-config.mjs`. Explorer:
https://explorer.solana.com/address/Gb6xwa6T348n7d67Ri5c42ENeQqbwLuf4d6W9an9rbZb?cluster=devnet

| Item | Address |
| --- | --- |
| Program | `Gb6xwa6T348n7d67Ri5c42ENeQqbwLuf4d6W9an9rbZb` |
| ProgramData | `CcHoibXJsxpAt7eYd3WDtMNR4dHpAZ1P8aDA4egXxGo2` |
| Upgrade authority (devnet deployer) | `C86133H4StMbhpGXT7MHq2YHTEkHwWwVtiaATTjULQPo` |
| Config | `9jnLCBjyzjqTSAa6Y6K8VJnVmQo1bvi19vU4kUMgZbtR` |
| Admin | `6k9CDcxSEGvPCmAmDfBFqjXVpvdDDTbmULgntYm5MMbZ` |
| Operator | `74GiJwEam8iB3cowzJd41BBvEn3YKUWkNpEo9e7mUNXc` |
| Treasury (owner) | `7x6kcx15ccJNrWGWVyXu3gVm73sSRscsrN9aNpvdwJHe` |
| Mint: test USDC, 6 decimals, ours | `CbYmC3TMWDAQFZe2C4nEdejNb3z2sAKvcS4G6kJcgRDn` |
| Funding account (stand-in for Altitude) | `G7Nj2p559MN4YJrA21fLvVai7iAwmUonWN29gJVKcth9` |
| Test customer | `H5eRvg2U2BxULDVXoYgBvwxsemp17NRKiRqf6HVpaRM1` (1,000 test USDC) |

- **Transactions.**
  - Deploy: `79efU4iofdJ5m2WmwJTRtZcWnM4k2RG136Ne6Y6J56WUPKh5bcakospDcp6hwWk9xSj8TEfNBcWLZHVjQ8fjMYe`.
  - Initialize: `52v5LK5cDJZ9jiSptncokxCxggSzmxV1DJHgqAuQfbEApS6asb1DJ2STtFmo7Cb95jXDXKXnGcCuPHsES63Hr31Q`.
- **Config.** 5% fee, 24 h dispute window, 7-day job timeout, 14-day dispute
  timeout.
- **Mint.** The devnet mint is our own, so devnet runs can be funded freely.
  Real USDC is used only on mainnet. The config mint cannot change, so moving
  devnet to Circle's devnet USDC needs a fresh program id.
- **Keys.** The devnet keypairs live outside the repository, in
  `~/.config/solana/will-devnet/`. Scripts take their paths from environment
  variables.

## Mainnet

Not deployed. Each step needs explicit approval, and the security-only review
against SECURITY.md comes first. The plan is:
1. Create a Squads v4 multisig: 2-of-3, one key on a hardware wallet.
2. Deploy with the hot deployer key: `CONFIRM_MAINNET=will_escrow scripts/deploy.sh mainnet-beta`.
3. Call `initialize_config` while the deployer is still the upgrade authority,
   with the admin set to the Squads vault.
4. Transfer the upgrade authority to the Squads vault:
   `solana program set-upgrade-authority --new-upgrade-authority <vault> --skip-new-upgrade-authority-signer-check`.
   Verify with `solana program show`.
