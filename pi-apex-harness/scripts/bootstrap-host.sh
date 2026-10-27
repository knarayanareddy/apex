#!/usr/bin/env bash
set -euo pipefail

# Reproducible host toolchain bootstrapper for Pi-Apex (Linux x86_64/arm64)
if ! command -v bwrap >/dev/null 2>&1; then
  echo "[bootstrap] Installing bubblewrap..."
  sudo apt-get update -qq && sudo apt-get install -y -qq bubblewrap
fi

if ! command -v chromium >/dev/null 2>&1 && ! command -v google-chrome >/dev/null 2>&1; then
  echo "[bootstrap] Installing headless chromium + xvfb..."
  sudo apt-get update -qq && sudo apt-get install -y --no-install-recommends chromium xvfb
fi

NEED_NODE22=0
if ! command -v node >/dev/null 2>&1; then
  NEED_NODE22=1
else
  NODE_MAJOR=$(node -p "process.versions.node.split('.')[0]")
  NODE_MINOR=$(node -p "process.versions.node.split('.')[1]")
  if [ "$NODE_MAJOR" -lt 22 ] || { [ "$NODE_MAJOR" -eq 22 ] && [ "$NODE_MINOR" -lt 19 ]; }; then
    NEED_NODE22=1
  fi
fi

if [ "$NEED_NODE22" -eq 1 ] && [ ! -x /tmp/node22/bin/node ]; then
  echo "[bootstrap] Provisioning Node.js v22.20.0 in /tmp/node22..."
  ARCH=$(uname -m)
  if [ "$ARCH" = "x86_64" ]; then NODE_ARCH="x64"; else NODE_ARCH="arm64"; fi
  curl -fsSL "https://nodejs.org/dist/v22.20.0/node-v22.20.0-linux-${NODE_ARCH}.tar.xz" -o /tmp/node22.tar.xz
  mkdir -p /tmp/node22
  tar -xJf /tmp/node22.tar.xz -C /tmp/node22 --strip-components=1
  rm -f /tmp/node22.tar.xz
fi

if [ -x /tmp/node22/bin/node ]; then
  export PATH="/tmp/node22/bin:$PATH"
fi

echo "[bootstrap] Node: $(node -v) | bwrap: $(bwrap --version)"
cd "$(dirname "$0")/.."
NODE_INC="/usr/include/node"
if [ ! -f "$NODE_INC/node_api.h" ] && [ -f "/tmp/node22/include/node/node_api.h" ]; then
  NODE_INC="/tmp/node22/include/node"
fi
if [ ! -f "$NODE_INC/node_api.h" ]; then
  sudo apt-get update -qq && sudo apt-get install -y -qq build-essential libnode-dev
  NODE_INC="/usr/include/node"
fi
gcc -shared -fPIC -O2 -Wall -Wextra -I"$NODE_INC" src/native/linux_fs_bridge.c -o src/native/linux_fs_bridge.node
chmod 0755 bin/pi-apex scripts/*.sh
chmod 0444 surfaces-immutable/GUARDRAILS.yaml
npm install --no-audit --no-fund
