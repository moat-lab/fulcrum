#!/usr/bin/env bash
set -euo pipefail

mkdir -p /data/.fulcrum /data/.ssh
chmod 700 /data/.ssh

if [ -n "${FULCRUM_SSH_PRIVATE_KEY:-}" ]; then
  umask 077
  printf '%s\n' "$FULCRUM_SSH_PRIVATE_KEY" > /data/.ssh/id_ed25519
  chmod 600 /data/.ssh/id_ed25519
fi

# Start rexecd sidecar (unless disabled). Container lifecycle is tied to BOTH
# rexecd and the main command: either exiting tears the whole container down,
# so Docker / Komodo treats half-dead state as a restart trigger.
REXECD_LISTEN="${REXECD_LISTEN:-0.0.0.0:50051}"
REXECD_PID=""
if [ "${REXECD_DISABLED:-}" != "true" ] && [ -x /usr/local/bin/rexecd ]; then
  /usr/local/bin/rexecd --listen "${REXECD_LISTEN}" &
  REXECD_PID=$!
fi

"$@" &
MAIN_PID=$!

forward_signal() {
  sig=$1
  if [ -n "${REXECD_PID}" ]; then
    kill -"${sig}" "${REXECD_PID}" 2>/dev/null || true
  fi
  kill -"${sig}" "${MAIN_PID}" 2>/dev/null || true
}

trap 'forward_signal TERM' SIGTERM
trap 'forward_signal INT' SIGINT

# `wait -n` returns the exit code of the first child to exit; we propagate it.
set +e
wait -n
status=$?
forward_signal TERM
wait
exit "${status}"
