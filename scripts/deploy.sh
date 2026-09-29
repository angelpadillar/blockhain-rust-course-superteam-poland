#!/usr/bin/env bash
# Deploys or upgrades will_escrow, then reclaims any leftover buffers.
#
#   WILL_DEPLOYER_KEYPAIR=~/.config/solana/will-devnet/deployer.json scripts/deploy.sh devnet
#
# Environment:
#   WILL_DEPLOYER_KEYPAIR  path to the fee payer and upgrade authority keypair (required)
#   WILL_PROGRAM_KEYPAIR   program id keypair, needed only for the first deploy
#                          (default target/deploy/will_escrow-keypair.json)
#   COMPUTE_UNIT_PRICE     priority fee in micro-lamports per CU (default 10000)
#   RPC_URL                overrides the cluster's public endpoint
#   CONFIRM_MAINNET        must be "will_escrow" for mainnet-beta; set it only
#                          after the security review and an explicit approval
#
# Extra arguments go to `solana program deploy` (for example --use-rpc).
set -euo pipefail

cluster=${1:?usage: scripts/deploy.sh <localnet|devnet|mainnet-beta> [deploy args]}
shift
case $cluster in
  localnet) url=${RPC_URL:-http://127.0.0.1:8899} ;;
  devnet) url=${RPC_URL:-https://api.devnet.solana.com} ;;
  mainnet-beta)
    if [[ ${CONFIRM_MAINNET:-} != will_escrow ]]; then
      echo "refusing mainnet: needs the security review and explicit approval (CONFIRM_MAINNET=will_escrow)" >&2
      exit 1
    fi
    url=${RPC_URL:-https://api.mainnet-beta.solana.com}
    ;;
  *) echo "unknown cluster: $cluster" >&2; exit 1 ;;
esac

root=$(cd "$(dirname "$0")/.." && pwd)
manifest=$root/programs/will_escrow/Cargo.toml
so=$root/target/deploy/will_escrow.so
deployer=${WILL_DEPLOYER_KEYPAIR:?set WILL_DEPLOYER_KEYPAIR to the deployer keypair path}
program_keypair=${WILL_PROGRAM_KEYPAIR:-$root/target/deploy/will_escrow-keypair.json}
price=${COMPUTE_UNIT_PRICE:-10000}
program_id=$(sed -n 's/^program-id = "\(.*\)"/\1/p' "$manifest")
payer=$(solana-keygen pubkey "$deployer")

# Every call names the cluster and the key explicitly; the CLI's own config
# (which may point at mainnet) is never used.
sol() { solana --url "$url" --keypair "$deployer" "$@"; }
balance() { sol balance --lamports "$payer" | cut -d' ' -f1; }

cargo build-sbf --manifest-path "$manifest"
size=$(wc -c <"$so" | tr -d ' ')
max_len=$(((size * 105 + 99) / 100))
before=$(balance)
echo "cluster $cluster, program $program_id, deployer $payer"
echo "binary $size B, max-len $max_len B, deployer balance $before lamports"

if sol program show "$program_id" >/dev/null 2>&1; then
  data_len=$(sol program show "$program_id" --output json | jq -r .dataLen)
  if ((size > data_len)); then
    echo "extending ProgramData from $data_len to $max_len B"
    sol program extend "$program_id" $((max_len - data_len)) --with-compute-unit-price "$price"
  fi
  sol program deploy "$so" --program-id "$program_id" --upgrade-authority "$deployer" \
    --with-compute-unit-price "$price" "$@"
else
  if [[ $(solana-keygen pubkey "$program_keypair") != "$program_id" ]]; then
    echo "program keypair $program_keypair is not $program_id" >&2
    exit 1
  fi
  sol program deploy "$so" --program-id "$program_keypair" --upgrade-authority "$deployer" \
    --max-len "$max_len" --with-compute-unit-price "$price" "$@"
fi

sol program show "$program_id"
echo "buffers owned by $payer:"
sol program show --buffers --buffer-authority "$payer"
if (($(sol program show --buffers --buffer-authority "$payer" --output json | jq '.buffers | length') > 0)); then
  sol program close --buffers --authority "$deployer" --recipient "$payer"
fi
after=$(balance)
echo "deployer spent $((before - after)) lamports ($before -> $after)"
