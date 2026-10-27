import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { MetricsAggregator } from "../../ingest/src/aggregator.ts";
import { ApiGateway } from "../../gateway/src/gateway.ts";

describe("Multi-Tenant Ingestion & Aggregation Suite", () => {
  let aggregator;
  let gateway;
  const testWalDir = path.resolve("./.wal-test");

  before(async () => {
    if (fs.existsSync(testWalDir)) {
      fs.rmSync(testWalDir, { recursive: true, force: true });
    }
    aggregator = new MetricsAggregator();
    await aggregator.clear();
    gateway = new ApiGateway({ aggregator, walDir: testWalDir });
  });

  after(async () => {
    if (aggregator) {
      await aggregator.clear().catch(() => {});
      await aggregator.close().catch(() => {});
    }
    if (fs.existsSync(testWalDir)) {
      fs.rmSync(testWalDir, { recursive: true, force: true });
    }
  });

  test("1. Enforces strict tenant isolation across parallel ingestions", async () => {
    const tenantA = "tenant_alpha";
    const tenantB = "tenant_beta";

    // Ingest metrics for tenantA
    for (let i = 1; i <= 20; i++) {
      await gateway.ingest({ tenantId: tenantA, metricName: "cpu_usage", value: i * 2 });
    }

    // Ingest metrics for tenantB
    for (let i = 1; i <= 10; i++) {
      await gateway.ingest({ tenantId: tenantB, metricName: "cpu_usage", value: 100 + i });
    }

    const resA = await gateway.getAggregated(tenantA, "cpu_usage", 60000);
    const resB = await gateway.getAggregated(tenantB, "cpu_usage", 60000);

    assert.equal(resA.count, 20, "Tenant A must have exactly 20 recorded metrics");
    assert.equal(resB.count, 10, "Tenant B must have exactly 10 recorded metrics");

    // Assert no metric bleed: all values in A must be <= 40, all in B must be > 100
    assert.ok(resA.values.every(v => v <= 40), "Tenant A metrics must not contain Tenant B values");
    assert.ok(resB.values.every(v => v > 100), "Tenant B metrics must not contain Tenant A values");
  });

  test("2. Accurately calculates windowed aggregations (sum, avg, p99)", async () => {
    const tenant = "tenant_calc";
    const values = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
    for (const v of values) {
      await gateway.ingest({ tenantId: tenant, metricName: "latency_ms", value: v });
    }

    const res = await gateway.getAggregated(tenant, "latency_ms", 60000);
    assert.equal(res.count, 10);
    assert.equal(res.sum, 550);
    assert.equal(res.avg, 55);
    assert.equal(res.p99, 100);
  });

  test("3. Gracefully degrades to on-disk WAL when backend fails and replays on recovery", async () => {
    const tenant = "tenant_wal_test";
    
    // Simulate temporary outage by passing a failing hook or triggering breaker
    const brokenAggregator = {
      aggregate: async () => { throw new Error("REDIS_CONNECTION_REFUSED"); },
      getMetrics: async () => aggregator.getMetrics(tenant, "disk_io"),
      clear: async () => {}
    };

    const fallbackGateway = new ApiGateway({
      aggregator: brokenAggregator,
      walDir: testWalDir
    });

    // Ingestion during outage should not crash, must return { status: 'wal_buffered' }
    const res1 = await fallbackGateway.ingest({ tenantId: tenant, metricName: "disk_io", value: 42 });
    const res2 = await fallbackGateway.ingest({ tenantId: tenant, metricName: "disk_io", value: 43 });

    assert.equal(res1.status, "wal_buffered", "Should gracefully buffer to WAL on backend failure");
    assert.equal(res2.status, "wal_buffered", "Should gracefully buffer to WAL on backend failure");

    // Check WAL directory exists and contains files
    const walFiles = fs.readdirSync(testWalDir).filter(f => f.endsWith(".wal") || f.endsWith(".jsonl") || f.endsWith(".log"));
    assert.ok(walFiles.length > 0, "WAL directory must contain pending log files");

    // Replay WAL with working aggregator
    const recoveryGateway = new ApiGateway({
      aggregator,
      walDir: testWalDir
    });

    const replayedCount = await recoveryGateway.replayPendingWal();
    assert.equal(replayedCount, 2, "Must replay exactly 2 pending WAL metrics");

    const recoveredRes = await recoveryGateway.getAggregated(tenant, "disk_io", 60000);
    assert.equal(recoveredRes.count, 2, "Replayed metrics must be present in aggregate store");
  });
});
