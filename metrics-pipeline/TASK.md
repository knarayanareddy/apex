# Objective: Upgrade and stabilize the multi-tenant metrics ingestion pipeline in the current workspace.

## Background: 
The repository contains a legacy Node.js/TypeScript ingestion service (\`packages/ingest\`), an API gateway (\`packages/gateway\`), and an integration test runner (\`packages/e2e\`). The project currently relies on an in-memory ring-buffer for rate limiting and metric aggregation, which loses data across restarts and corrupts state during sudden traffic spikes.

## Requirements:

### 1. Infrastructure Provisioning:
Update \`docker-compose.yml\` to provision a local Redis service (version \`7-alpine\`) exposed on port \`6379\`, with persistence enabled (AOF) and health checks configured.

### 2. Distributed Storage Migration:
Refactor \`packages/ingest/src/aggregator.ts\` to replace the in-memory windowing logic with an atomic, Redis-backed sliding log using Lua scripts or Redis Transactions (\`MULTI/EXEC\`) to avoid race conditions.

### 3. Backward Compatibility & Invariant Guarantees:
- The system must pass all existing integration suites in \`npm run test:e2e\` without modifying any assertions inside \`packages/e2e/specs/\`.
- Under continuous load from \`npm run benchmark:burst\`, the pipeline must achieve zero unhandled promise rejections, maintain p99 processing latency under 45ms, and maintain 100% tenant isolation (no cross-tenant metric bleed under parallel execution).

### 4. Graceful Degradation & Recovery:
Implement a fallback circuit breaker in the gateway (\`packages/gateway/src/gateway.ts\`): if Redis is stopped (\`docker stop <redis_container>\`) while ingestion traffic is live, the gateway must switch to a temporary on-disk append-only write-ahead log (WAL) under \`.wal/\` and replay pending metrics once Redis recovers.

### 5. Deliverables:
- Working, linted code across all affected packages (\`packages/ingest\`, \`packages/gateway\`).
- A verification script \`scripts/verify-all.sh\` that stands up the environment, seeds legacy data, executes the chaos test (killing and reviving Redis mid-run), asserts zero dropped metrics, and cleanly tears down containers.
