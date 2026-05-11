#!/bin/sh
set -e

if [ -n "$SSH_PRIVATE_KEY_B64" ]; then
  mkdir -p /root/.ssh
  printf '%s' "$SSH_PRIVATE_KEY_B64" | base64 -d > /root/.ssh/id_ed25519
  chmod 600 /root/.ssh/id_ed25519
fi

exec node server.js
