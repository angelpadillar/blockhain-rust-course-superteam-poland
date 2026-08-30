#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
DEMO_DIR="$PROJECT_DIR/.demo"
DEMO_WALLET="$DEMO_DIR/payer.json"
RPC_URL="${ANCHOR_PROVIDER_URL:-http://127.0.0.1:8899}"

mkdir -p "$DEMO_DIR"

if [[ ! -f "$DEMO_WALLET" ]]; then
  solana-keygen new \
    --no-bip39-passphrase \
    --silent \
    --outfile "$DEMO_WALLET"
  echo "Created repo-local demo wallet: $DEMO_WALLET"
fi

echo "Surfpool RPC: $RPC_URL"
echo "Surfpool Studio: http://127.0.0.1:18488"
echo "Demo wallet: $(solana-keygen pubkey "$DEMO_WALLET")"
echo
echo "In the terminal that will run Anchor and the demo:"
echo "export ANCHOR_PROVIDER_URL=$RPC_URL"
echo "export ANCHOR_WALLET=$DEMO_WALLET"
echo

if ! solana cluster-version --url "$RPC_URL" >/dev/null 2>&1; then
  if [[ "$(uname -s)" == "Darwin" ]]; then
    echo "Starting Surfpool in the foreground. Keep this terminal open."
    exec surfpool start \
      --offline \
      --db :memory: \
      --no-deploy \
      --yes \
      --airdrop-keypair-path "$DEMO_WALLET"
  else
    surfpool start \
      --offline \
      --db :memory: \
      --no-deploy \
      --daemon \
      --yes \
      --airdrop-keypair-path "$DEMO_WALLET"
  fi
fi

solana airdrop 100 \
  --url "$RPC_URL" \
  --keypair "$DEMO_WALLET" >/dev/null

echo "Surfpool was already running; the demo wallet is funded."
