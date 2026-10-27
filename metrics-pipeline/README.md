# Multi-tenant metrics pipeline

Requires Node.js 22.18+ (native TypeScript stripping), npm, and Docker Compose v2.

```sh
npm ci
docker compose up -d --wait
npm run lint
npm run test:e2e
npm run benchmark:burst
```

Redis defaults to `redis://127.0.0.1:6379`; override with `REDIS_URL`. Compose uses
Redis 7-alpine, a named data volume, AOF, and `appendfsync always` so an acknowledged
write survives an abrupt Redis process/container kill. `docker compose down`
retains data; `docker compose down --volumes` intentionally deletes it.

## Storage and compatibility

- `MetricsAggregator` preserves the legacy constructor/method API. `maxBufferSize`
  is accepted but no longer drops metrics when bursts exceed a count limit.
- Tenant/name tuples are encoded unambiguously, with a separately encoded
  namespace (`METRICS_NAMESPACE`, default `default`). `clear()` only deletes that
  namespace; it is an administrative operation requiring quiescent writers.
- Atomic Lua scripts maintain sorted sliding logs. Concurrent writes are coalesced
  into bounded batches per metric to avoid hundreds of separate durable writes.
  Each call resolves only after its Redis write has completed.
- Default retention is seven days, configurable through `retentionMs`. Reads accept
  windows up to that retention, include the lower boundary, and preserve the legacy
  sum/average/p99 formula. Returned values follow timestamp/log order, not a
  guaranteed global ingestion order across writers. Expired observations are
  intentionally removed; this is not an indefinite archive.
- Replay uses the original timestamp and a stable event ID. Ambiguous Redis commits
  and concurrent WAL replayers do not duplicate the same observation within the
  retained log. A Redis client restart never clears data.

The old in-memory implementation has no persistent data format to migrate after a
process exits. Any still-live legacy data must be exported and submitted through
`aggregate(tenant, metric, value, originalTimestamp)` before shutdown. Verification
seeds fixtures through this legacy-compatible API and checks them after recovery.

## Circuit breaker and WAL

The gateway fails fast on unavailable Redis, opens its breaker, and acknowledges
`wal_buffered` only after the local record and directory have been fsynced. WAL
segments live under `.wal/` by default (override with `walDir`). Each segment is a
single immutable JSON line, published by atomic rename; incomplete, unacknowledged
`.tmp` files are not replayed. Disk errors reject ingestion rather than falsely
acknowledging a metric. Invalid metrics are rejected before reaching either store.

A background recovery loop retries every second, including pending files left by
an earlier process. `replayPendingWal()` also allows explicit recovery. Segments
are deleted only after Redis commits; stable IDs make a crash between commit and
unlink safe. Corrupt committed WAL files are retained and surfaced through the
explicit replay call or `lastReplayError`. Operators should alert on that property,
monitor WAL disk space, and retain/mount the WAL directory across gateway restarts.
WAL protects a Redis outage, not loss of the gateway's disk. Metrics older than the
configured retention are no longer queryable even if recovered from a long outage.

Call `gateway.close()` to stop its background worker before closing the aggregator.
Callers must first finish in-flight ingestion. The timer is unreferenced so it does
not prevent process exit. The recovery interval is configurable with
`recoveryIntervalMs`.

## Full verification

```sh
scripts/verify-all.sh
```

This requires a **real Docker daemon** and a free port 6379. It provisions an
isolated Compose project, runs lint/type checks, the unchanged integration suite,
extra regression checks, three burst benchmarks, and continuous-traffic chaos.
Chaos seeds legacy-compatible fixtures, abruptly stops Redis, verifies durable
WAL acknowledgements, restarts Redis, waits for automatic replay, and compares
all expected values per tenant (including collision-prone tenant/name pairs).
It checks actual Redis version/AOF configuration and asserts zero missing or
duplicate metrics and zero unhandled rejections. An exit trap tears down the test
containers and volumes on success or failure. Existing unrelated Redis instances
are never intentionally reconfigured or stopped.

For machines without Docker, an explicitly labeled native-Redis equivalent is
available:

```sh
VERIFY_LOCAL_REDIS=1 scripts/verify-all.sh
```

This requires `redis-server` and `redis-cli`, uses an isolated directory and port
16380 (`VERIFY_REDIS_PORT` overrides it), and performs a real SIGKILL/restart with
AOF recovery. It does **not** certify the Redis 7 Docker image. Docker shims are
rejected rather than treated as evidence of a passing container chaos test.
