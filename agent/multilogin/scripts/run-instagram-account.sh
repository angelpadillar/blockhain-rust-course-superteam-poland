#!/usr/bin/env bash
# Set up ONE warmed Instagram account: profile photo, display name, username.
# Tries each candidate username in order and stops on the first that saves.
#
# Usage: run-instagram-account.sh <code> <profile-id> "<name>" "<u1,u2,u3>" <photo-host-path>
set -uo pipefail
CODE=$1; PID=$2; NAME=$3; CANDIDATES=$4; PHOTO=$5
DIR=/opt/buena-multilogin/private/instagram-runs
EVIDENCE=/opt/buena-multilogin/private/instagram-evidence
PHOTOS_DIR=/opt/buena-multilogin/private/instagram-photos
mkdir -p "$DIR" "$EVIDENCE"; chmod 700 "$DIR"
LOG="$DIR/$CODE.log"
exec >>"$LOG" 2>&1
PHOTO_NAME=$(basename "$PHOTO")
echo "### $(date -u +%FT%TZ) $CODE profile=$PID name=\"$NAME\" photo=$PHOTO_NAME"
cd /opt/buena-multilogin
IFS=',' read -ra USERNAMES <<< "$CANDIDATES"
for candidate in "${USERNAMES[@]}"; do
  echo "--- candidate: $candidate"
  docker compose run --rm --no-deps -T \
    -v /opt/buena-multilogin-orchestrator/src:/app/work/src:ro \
    -v /opt/buena-multilogin-orchestrator/scripts/instagram-profile.mjs:/app/work/scripts/instagram-profile.mjs:ro \
    -v "$PHOTOS_DIR":/app/work/photos:ro \
    --entrypoint node worker work/scripts/instagram-profile.mjs \
    --profile-id "$PID" --mode update --label "$CODE" \
    --new-username "$candidate" --new-name "$NAME" --photo-file "/app/work/photos/$PHOTO_NAME" \
    --watchdog-ms 480000
  echo "connector exit: $?"
  REPORT=$(ls -t "$EVIDENCE"/instagram-"$PID"-*.json 2>/dev/null | head -1)
  STATUS=$(python3 -c "import json,sys; print((json.load(open(sys.argv[1])).get('status') or 'unknown') if sys.argv[1] else 'no_report')" "$REPORT" 2>/dev/null)
  echo "candidate $candidate -> $STATUS"
  case "$STATUS" in
    updated) break ;;
    username_taken) continue ;;
    *) break ;;
  esac
done
chmod 600 "$LOG"
echo "### done $(date -u +%FT%TZ)"
