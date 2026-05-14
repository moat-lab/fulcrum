#!/usr/bin/env bash
# Smoke script for fulcrum#208 — exercises the Alice path against the
# vctcn Mattermost deployment: POST /api/v4/commands/execute with bot token,
# then assert the response carries the fulcrum mgmt-bot card (pretext text +
# attachment with command rows).
#
# Required env (sourced from the prod fulcrum container env, not committed):
#   FULCRUM_MATTERMOST_SERVER_URL    e.g. https://mattermost.237575.xyz
#   FULCRUM_MATTERMOST_BOT_TOKEN     bot personal access token
#   FULCRUM_MATTERMOST_TEAM_ID       vctcn team id
#   FULCRUM_MATTERMOST_CHANNEL_ID    target channel id (the channel Alice would type /f in)
#
# To populate the env from prod (run from a host with ssh access to moatapp1):
#   eval "$(ssh moatapp1 'docker exec fulcrum env | grep ^FULCRUM_MATTERMOST_' | sed -E 's/^/export /')"
#
# Output:
#   - PASS / FAIL line on stdout
#   - response.json (full body)
#   - response-summary.txt (extracted pretext + attachment titles)
# Exit codes: 0 on PASS, 1 on FAIL (HTTP error or missing card fields).

set -euo pipefail

: "${FULCRUM_MATTERMOST_SERVER_URL:?missing}"
: "${FULCRUM_MATTERMOST_BOT_TOKEN:?missing}"
: "${FULCRUM_MATTERMOST_TEAM_ID:?missing}"
: "${FULCRUM_MATTERMOST_CHANNEL_ID:?missing}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT_JSON="$SCRIPT_DIR/response.json"
OUT_SUMMARY="$SCRIPT_DIR/response-summary.txt"

body=$(jq -n \
  --arg ch "$FULCRUM_MATTERMOST_CHANNEL_ID" \
  --arg team "$FULCRUM_MATTERMOST_TEAM_ID" \
  '{channel_id: $ch, team_id: $team, command: "/f help"}')

http_code=$(curl -sS -o "$OUT_JSON" -w '%{http_code}' \
  -X POST "$FULCRUM_MATTERMOST_SERVER_URL/api/v4/commands/execute" \
  -H "Authorization: Bearer $FULCRUM_MATTERMOST_BOT_TOKEN" \
  -H 'Content-Type: application/json' \
  --data "$body")

if [ "$http_code" != "200" ]; then
  echo "FAIL: HTTP $http_code from /api/v4/commands/execute" >&2
  cat "$OUT_JSON" >&2
  exit 1
fi

pretext=$(jq -r '.props.attachments[0].pretext // empty' "$OUT_JSON")
titles=$(jq -r '.props.attachments[]?.title? // empty' "$OUT_JSON")

{
  echo "response_type: $(jq -r '.response_type' "$OUT_JSON")"
  echo "text: $(jq -r '.text // empty' "$OUT_JSON")"
  echo "pretext: $pretext"
  echo "attachment_titles:"
  echo "$titles" | sed 's/^/  - /'
} > "$OUT_SUMMARY"

if [ -z "$pretext" ]; then
  echo "FAIL: response missing attachment pretext (no fulcrum mgmt-bot card)" >&2
  cat "$OUT_SUMMARY" >&2
  exit 1
fi

if ! echo "$pretext" | grep -q 'Fulcrum Commands'; then
  echo "FAIL: pretext does not contain 'Fulcrum Commands' — got: $pretext" >&2
  exit 1
fi

echo "PASS: /f help returned fulcrum mgmt-bot card"
echo "  pretext=$pretext"
echo "  response_json=$OUT_JSON"
echo "  summary=$OUT_SUMMARY"
