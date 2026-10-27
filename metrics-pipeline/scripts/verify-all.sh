#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
export COMPOSE_PROJECT_NAME="metrics-verify-$$"
export METRICS_NAMESPACE="$COMPOSE_PROJECT_NAME"
WORK="$PWD/.verification/$COMPOSE_PROJECT_NAME"
mkdir -p "$WORK/redis"
export VERIFY_WORK="$WORK"
started=0
cleanup() {
  local status=$?
  trap - EXIT
  if [[ "$started" == 1 ]]; then
    if [[ "${VERIFY_LOCAL_REDIS:-0}" == 1 ]]; then
      redis-cli -p "$VERIFY_REDIS_PORT" shutdown nosave >/dev/null 2>&1 || true
    else
      docker compose down --volumes --remove-orphans || status=1
    fi
  fi
  rm -rf "$WORK"
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
if [[ "${VERIFY_LOCAL_REDIS:-0}" == 1 ]]; then
  export VERIFY_REDIS_PORT="${VERIFY_REDIS_PORT:-16380}"
  export REDIS_URL="redis://127.0.0.1:$VERIFY_REDIS_PORT"
  if redis-cli -p "$VERIFY_REDIS_PORT" ping >/dev/null 2>&1; then
    echo "Refusing to use an existing Redis on $VERIFY_REDIS_PORT" >&2
    exit 1
  fi
  echo "LOCAL MODE: native Redis, not verification of the Redis 7 Docker image"
  started=1
  redis-server --bind 127.0.0.1 --port "$VERIFY_REDIS_PORT" --dir "$WORK/redis" \
    --appendonly yes --appendfsync always --save "" --daemonize yes \
    --pidfile "$WORK/redis/redis.pid" --logfile "$WORK/redis/redis.log"
else
  server_version="$(docker info --format '{{.ServerVersion}}')"
  if [[ ! "$server_version" =~ ^[0-9]+\.[0-9]+ ]]; then
    echo "A real Docker daemon is required (detected a shim or unavailable daemon)." >&2
    exit 1
  fi
  export REDIS_URL="redis://127.0.0.1:6379"
  started=1
  docker compose up -d --wait --wait-timeout 60
fi
npm run lint
npm run test:e2e
node --test scripts/regression.mjs
# Repeated invocations exercise sustained bursts without weakening assertions.
for run in 1 2 3; do npm run benchmark:burst; done
node scripts/verify-chaos.mjs
echo "All checks passed ($COMPOSE_PROJECT_NAME)."
