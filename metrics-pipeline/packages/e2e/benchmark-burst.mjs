import assert from "node:assert/strict";
import { MetricsAggregator } from "../ingest/src/aggregator.ts";
import { ApiGateway } from "../gateway/src/gateway.ts";

async function runBurstBenchmark() {
  console.log("=== Starting Multi-Tenant Burst Benchmark ===");
  const aggregator = new MetricsAggregator();
  await aggregator.clear().catch(() => {});
  const gateway = new ApiGateway({ aggregator });

  const TOTAL_REQUESTS = 600;
  const TENANTS = ["tenant-burst-1", "tenant-burst-2", "tenant-burst-3", "tenant-burst-4"];
  const latencies = [];
  let unhandledRejections = 0;

  process.on("unhandledRejection", (err) => {
    unhandledRejections++;
    console.error("Unhandled rejection detected:", err);
  });

  const startTime = Date.now();
  const tasks = [];

  for (let i = 0; i < TOTAL_REQUESTS; i++) {
    const tenantId = TENANTS[i % TENANTS.length];
    const metricName = "http_latency";
    const value = (i % 100) + 1; // 1 to 100

    tasks.push((async () => {
      const t0 = performance.now();
      try {
        await gateway.ingest({ tenantId, metricName, value });
        const elapsed = performance.now() - t0;
        latencies.push(elapsed);
      } catch (err) {
        console.error(`Request failed for ${tenantId}:`, err);
        throw err;
      }
    })());
  }

  await Promise.all(tasks);
  const totalDuration = Date.now() - startTime;

  latencies.sort((a, b) => a - b);
  const p50 = latencies[Math.floor(latencies.length * 0.50)];
  const p95 = latencies[Math.floor(latencies.length * 0.95)];
  const p99 = latencies[Math.floor(latencies.length * 0.99)];
  const opsPerSec = Math.round((TOTAL_REQUESTS / totalDuration) * 1000);

  console.log(`Processed ${TOTAL_REQUESTS} requests in ${totalDuration}ms (${opsPerSec} req/sec)`);
  console.log(`Latency p50: ${p50.toFixed(2)}ms | p95: ${p95.toFixed(2)}ms | p99: ${p99.toFixed(2)}ms`);

  // Assertions:
  // 1. Zero unhandled promise rejections
  assert.equal(unhandledRejections, 0, "Must have zero unhandled promise rejections");

  // 2. p99 processing latency under 45ms
  assert.ok(p99 < 45, `p99 latency (${p99.toFixed(2)}ms) must be under 45ms`);

  // 3. 100% tenant isolation (no cross-tenant metric bleed)
  const expectedPerTenant = TOTAL_REQUESTS / TENANTS.length;
  for (const tenantId of TENANTS) {
    const res = await gateway.getAggregated(tenantId, "http_latency", 60000);
    assert.equal(res.count, expectedPerTenant, `Tenant ${tenantId} must have exactly ${expectedPerTenant} entries`);
  }

  console.log("=== Burst Benchmark PASSED successfully! ===");
  await aggregator.close().catch(() => {});
}

runBurstBenchmark().catch(err => {
  console.error("Burst Benchmark FAILED:", err);
  process.exit(1);
});
