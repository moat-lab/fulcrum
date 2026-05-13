#!/usr/bin/env bash
#
# Launch a real `claude` PM session with `@agent-channel/mcp` as a stdio MCP
# child, then drive it with a single prompt that exercises `channel.send` so
# that the wave-2 D2 chain (PM Claude → MCP stdio → exchange) produces:
#
#   - a PM Claude process whose ppid is this shell (NOT fulcrum)
#   - an `@agent-channel/mcp` subprocess of that PM Claude
#   - a Claude session jsonl containing a `channel.send` tool_use
#   - an envelope POST in the docker exchange access log
#
# Inputs come from the live `GET /api/channels/pm/mode` hook plus a single
# bearer-token env var that the launcher (not fulcrum) is responsible for
# providing per #153 §824. This script reads the hook fields directly so the
# evidence is anchored to the route under test.

set -euo pipefail

RUN_DIR="$(cd "$(dirname "$0")" && pwd)"
HOOK_PORT=19185
FULCRUM_HOOK_URL="http://127.0.0.1:${HOOK_PORT}/api/channels/pm/mode"
EXCHANGE_URL="http://127.0.0.1:18787"
MCP_BIN="/Users/mouriya/Ext/code/agent-channel-exchange/packages/mcp/src/bin.ts"
TARGET_MAILBOX="fulcrum-task-target-issue-185/main"

echo "[launch] hook: $FULCRUM_HOOK_URL"
HOOK_JSON="$(curl -sS "$FULCRUM_HOOK_URL")"
echo "$HOOK_JSON" > "$RUN_DIR/04-hook-live.json"

PM_MAILBOX="$(python3 -c "import sys, json; print(json.loads('''$HOOK_JSON''')['mailbox'])")"
CLIENT_FORM="$(python3 -c "import sys, json; print(json.loads('''$HOOK_JSON''')['clientForm'])")"
EXCHANGE_FROM_HOOK="$(python3 -c "import sys, json; print(json.loads('''$HOOK_JSON''')['exchange']['url'])")"

echo "[launch] PM mailbox=$PM_MAILBOX clientForm=$CLIENT_FORM exchange=$EXCHANGE_FROM_HOOK"
if [ "$CLIENT_FORM" != "claude-mcp" ]; then
  echo "[launch] FAIL: clientForm != claude-mcp" >&2; exit 1
fi
if [ "$EXCHANGE_FROM_HOOK" != "$EXCHANGE_URL" ]; then
  echo "[launch] FAIL: exchange url mismatch" >&2; exit 1
fi

# MCP server config. Note: the env block ONLY carries values the launcher
# already knows or read from elsewhere — fulcrum is NOT in the loop and the
# exchange bearer token would come from the launcher's secret store
# (here we leave it empty because our docker exchange does not require one).
MCP_CFG="$RUN_DIR/mcp-config.json"
python3 > "$MCP_CFG" <<PY
import json
print(json.dumps({
  "mcpServers": {
    "agent-channel": {
      "command": "bun",
      "args": ["run", "$MCP_BIN"],
      "env": {
        "AGENT_CHANNEL_EXCHANGE_URL": "$EXCHANGE_URL",
        "AGENT_CHANNEL_AGENT_KIND": "pm-agent",
        "AGENT_CHANNEL_INSTANCE_LABEL": "issue-185 PM probe",
        "AGENT_CHANNEL_CAPABILITIES": "channel.send,channel.receive,discovery.list",
        "AGENT_CHANNEL_DESIRED_CHANNEL_ID": "$PM_MAILBOX"
      }
    }
  }
}, indent=2))
PY
echo "[launch] wrote mcp config -> $MCP_CFG"

PROMPT="You are a Project Manager agent connected to a docker mailbox exchange via the agent-channel MCP server. Use the channel.send tool exactly once, with these JSON arguments verbatim (do not add or omit fields):

{
  \"to\": \"$TARGET_MAILBOX\",
  \"body_kind\": \"assignment\",
  \"payload\": {
    \"schema_version\": \"0.1.0\",
    \"title\": \"wave-2 D2 probe assignment\",
    \"summary\": \"Issue #185 acceptance: real PM Claude session via MCP\",
    \"acceptance\": [\"verify channel.send tool_use appears in PM session jsonl\"]
  }
}

After the tool call returns, respond only with the literal string 'sent'."

SESSION_ID="issue-185-pm-$(date +%s)"
PROMPT_FILE="$RUN_DIR/05-pm-prompt.txt"
printf '%s' "$PROMPT" > "$PROMPT_FILE"
echo "[launch] session-id=$SESSION_ID prompt saved -> $PROMPT_FILE"

CLAUDE_LOG="$RUN_DIR/06-claude-stream.jsonl"
CLAUDE_STDERR="$RUN_DIR/06-claude-stderr.txt"

echo "[launch] starting claude (real PM session, MCP stdio child, stream-json)…"
# Start claude in background so we can snapshot ps / pgrep / registry mid-flight.
# Session persistence stays ON so the session jsonl is written to
# `~/.claude/projects/<cwd-hash>/<session>.jsonl` — that file is what
# acceptance row #5 wants jq'd.
( claude \
    -p "$PROMPT" \
    --mcp-config "$MCP_CFG" \
    --strict-mcp-config \
    --allowedTools "mcp__agent-channel__channel.send" \
    --permission-mode bypassPermissions \
    --output-format stream-json \
    --verbose \
    > "$CLAUDE_LOG" 2> "$CLAUDE_STDERR"
) &
CLAUDE_PID=$!
echo "[launch] claude pid=$CLAUDE_PID (this shell ppid=$$)"

PS_SNAP="$RUN_DIR/07-ps-claude.txt"
PGREP_SNAP="$RUN_DIR/08-pgrep-mcp-child.txt"
REG_SNAP="$RUN_DIR/09a-exchange-registry-during-run.json"

sleep 5
ps -o pid,ppid,command -p "$CLAUDE_PID" 2>/dev/null > "$PS_SNAP" || echo "(claude already exited at snapshot time)" > "$PS_SNAP"
pgrep -P "$CLAUDE_PID" -af '.' 2>/dev/null > "$PGREP_SNAP" || echo "(no children found)" > "$PGREP_SNAP"
echo "[launch] ps snap -> $PS_SNAP"
cat "$PS_SNAP"
echo "[launch] children of claude -> $PGREP_SNAP"
cat "$PGREP_SNAP"

# Mid-flight registry probe — confirms PM self-registered with agent_kind=pm-agent.
curl -sS -X POST http://127.0.0.1:18787/v1/discovery/list \
  -H 'Content-Type: application/json' \
  -H 'x-agent-channel-sender: issue-185-probe/main' \
  -d "$(python3 -c '
import json, uuid, datetime
print(json.dumps({
  "msg_id": str(uuid.uuid4()),
  "from": "issue-185-probe/main",
  "to": "exchange/system",
  "ts": datetime.datetime.now(datetime.timezone.utc).isoformat(),
  "schema_version": "0.1.0",
  "body": {
    "kind": "discovery.list_request",
    "payload": {"filter": {}}
  }
}))
')" > "$REG_SNAP" || true
echo "[launch] mid-run registry -> $REG_SNAP"
python3 -m json.tool < "$REG_SNAP" | head -60

# Wait for claude to finish.
wait "$CLAUDE_PID"
CLAUDE_EXIT=$?
echo "[launch] claude exit=$CLAUDE_EXIT"

echo
echo "[launch] === claude stderr (tail) ==="
tail -n 60 "$CLAUDE_STDERR" || true
echo "[launch] done."
