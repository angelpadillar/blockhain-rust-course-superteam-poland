#!/usr/bin/env bash
# Run the Upload-Post TikTok connect flow for ONE warmed Multilogin profile.
# Minting happens inside the same log so the single-use state never crosses
# sessions; the log is private and never prints the authorize URL.
#
# Usage: run-uploadpost-account.sh <code> <profile-id> <tiktok-handle>
set -uo pipefail
CODE=$1; PID=$2; HANDLE=$3
KEY=$(cat /opt/buena-multilogin/private/upload-post-api-key)
DIR=/opt/buena-multilogin/private/uploadpost-runs
mkdir -p "$DIR"; chmod 700 "$DIR"
LOG="$DIR/$CODE.log"
exec >>"$LOG" 2>&1
echo "### $(date -u +%FT%TZ) $CODE $HANDLE profile=$PID"
curl -s -m 30 -X POST -H "Authorization: Apikey $KEY" -H "Content-Type: application/json" \
  -d "{\"profile\":\"$HANDLE\"}" \
  https://api.upload-post.com/api/uploadposts/oauth/tiktok/start -o /tmp/uploadpost-start.json
python3 -c "
import json
d=json.load(open('/tmp/uploadpost-start.json'))
url=d.get('authorize_url') or ''
assert url, json.dumps(d)[:300]
open('/opt/buena-multilogin/private/uploadpost-authorize-url.txt','w').write(url+'\n')
print('minted ok')
"
rm -f /tmp/uploadpost-start.json
chown 1000:1000 /opt/buena-multilogin/private/uploadpost-authorize-url.txt
chmod 600 /opt/buena-multilogin/private/uploadpost-authorize-url.txt
cd /opt/buena-multilogin
docker compose run --rm --no-deps -T \
  -v /opt/buena-multilogin-orchestrator/src:/app/src:ro \
  -v /opt/buena-multilogin-orchestrator/scripts/uploadpost-connect.mjs:/app/scripts/uploadpost-connect.mjs:ro \
  --entrypoint node worker scripts/uploadpost-connect.mjs \
  --profile-id "$PID" --handle "$HANDLE" --mode authorize --code "$CODE" \
  --authorize-url-file /data/uploadpost-authorize-url.txt --watchdog-ms 480000
echo "connector exit: $?"
curl -s -m 30 -H "Authorization: Apikey $KEY" "https://api.upload-post.com/api/uploadposts/users/$HANDLE" | python3 -c "
import sys,json
d=json.load(sys.stdin)
tk=((d.get('profile') or {}).get('social_accounts') or {}).get('tiktok')
if tk: print('VERIFY', tk.get('handle'), '|', tk.get('display_name'), '| reauth:', tk.get('reauth_required'), '| caps:', len(tk.get('capabilities') or []))
else: print('VERIFY NOT CONNECTED')
"
chmod 600 "$LOG"
echo "### done $(date -u +%FT%TZ)"
