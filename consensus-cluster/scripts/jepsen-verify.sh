#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
# Native is dependency-free. Set RAFT_MODE=docker (or pass --docker) for Compose.
exec node scripts/jepsen-verify.mjs "$@"
