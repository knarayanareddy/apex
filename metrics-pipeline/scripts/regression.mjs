import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { MetricsAggregator } from "../packages/ingest/src/aggregator.ts";
import { ApiGateway } from "../packages/gateway/src/gateway.ts";

test("distributed sliding log: bursts, collision-safe keys, duplicates, windows and scoped clear", async () => {
  const namespace = randomUUID();
  const a = new MetricsAggregator({ namespace, maxBufferSize: 1 });
  const b = new MetricsAggregator({ namespace });
  const other = new MetricsAggregator({ namespace: randomUUID() });
  try {
    const now = Date.now();
    await Promise.all(Array.from({ length: 1200 }, (_, i) =>
      (i % 2 ? a : b).aggregate("a:b", "c", i, now)));
    await b.aggregate("a", "b:c", 9999);
    assert.equal((await a.getMetrics("a:b", "c")).count, 1200);
    assert.deepEqual((await a.getMetrics("a", "b:c")).values, [9999]);
    await Promise.all([a.aggregate("dedupe", "m", 42, now, "same-id"), b.aggregate("dedupe", "m", 42, now, "same-id")]);
    assert.deepEqual((await b.getMetrics("dedupe", "m")).values, [42]);
    await a.aggregate("window", "m", 1, now - 120000);
    await a.aggregate("window", "m", 2, now);
    assert.deepEqual((await b.getMetrics("window", "m", 60000)).values, [2]);
    assert.equal((await b.getMetrics("window", "m", 180000)).count, 2);
    await assert.rejects(a.aggregate("bad", "m", NaN), TypeError);
    await other.aggregate("separate", "m", 7);
    await a.clear();
    assert.equal((await b.getMetrics("a:b", "c")).count, 0);
    assert.deepEqual((await other.getMetrics("separate", "m")).values, [7]);
  } finally {
    await a.clear();
    await other.clear();
    await Promise.all([a.close(), b.close(), other.close()]);
  }
});

test("WAL survives gateway restart, ambiguous commits and duplicate replay; disk errors are not acknowledged", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "metrics-wal-"));
  const aggregator = new MetricsAggregator({ namespace: randomUUID() });
  const gateways = [];
  const create = backend => {
    const gateway = new ApiGateway({ aggregator: backend, walDir: dir, recoveryIntervalMs: 60000 });
    gateways.push(gateway);
    return gateway;
  };
  try {
    const uncertain = create({
      aggregate: async (...args) => { await aggregator.aggregate(...args); throw new Error("Lost Redis reply after commit"); },
      getMetrics: (...args) => aggregator.getMetrics(...args)
    });
    assert.equal((await uncertain.ingest({ tenantId: "t", metricName: "m", value: 9 })).status, "wal_buffered");
    await uncertain.close();
    const name = (await fs.readdir(dir)).find(file => file.endsWith(".wal"));
    const saved = await fs.readFile(path.join(dir, name));
    const recovery = create(aggregator);
    assert.equal(await recovery.replayPendingWal(), 1);
    // Simulate a crash after the Redis commit but before durable WAL deletion.
    await fs.writeFile(path.join(dir, name), saved);
    await Promise.all([recovery.replayPendingWal(), create(aggregator).replayPendingWal()]);
    assert.deepEqual((await aggregator.getMetrics("t", "m")).values, [9]);
    assert.deepEqual(await fs.readdir(dir), []);
    await assert.rejects(recovery.ingest({ tenantId: "t", metricName: "m", value: Infinity }), TypeError);
    await fs.writeFile(path.join(dir, "corrupt.wal"), "not-json");
    await assert.rejects(recovery.replayPendingWal(), SyntaxError);
    assert.ok((await fs.readdir(dir)).includes("corrupt.wal"));
    await fs.rm(dir, { recursive: true });
    const broken = create({ aggregate: async () => { throw new Error("offline"); }, getMetrics: () => {} });
    await fs.rm(dir, { recursive: true });
    await assert.rejects(broken.ingest({ tenantId: "t", metricName: "m", value: 1 }), { code: "ENOENT" });
  } finally {
    await Promise.all(gateways.map(gateway => gateway.close()));
    await aggregator.clear();
    await aggregator.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});
