#!/usr/bin/env bash
set -euo pipefail

mkdir -p /data/.fulcrum /data/.ssh
chmod 700 /data/.ssh

if [ -n "${FULCRUM_SSH_PRIVATE_KEY:-}" ]; then
  umask 077
  printf '%s\n' "$FULCRUM_SSH_PRIVATE_KEY" > /data/.ssh/id_ed25519
  chmod 600 /data/.ssh/id_ed25519
fi

exec "$@"
