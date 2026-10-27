import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { promises as fs } from "node:fs";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { Redis } from "ioredis";
import { MetricsAggregator } from "../packages/ingest/src/aggregator.ts";
import { ApiGateway } from "../packages/gateway/src/gateway.ts";

const exec = promisify(execFile);
const local = process.env.VERIFY_LOCAL_REDIS === "1";
const work = process.env.VERIFY_WORK;
assert.ok(work, "Run through scripts/verify-all.sh");
const redisDir = path.join(work, "redis");
const control = new Redis(process.env.REDIS_URL, { enableOfflineQueue: false, retryStrategy: () => 100 });
control.on("error", () => {});
const aggregator = new MetricsAggregator();
const walDir = path.join(work, "wal");
const gateway = new ApiGateway({ aggregator, walDir, recoveryIntervalMs: 50 });
let running = true;
let traffic;
let trafficError;
let unhandled = 0;
const onRejection = error => { unhandled++; console.error(error); };
process.on("unhandledRejection", onRejection);

async function waitFor(check, description) {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    try { if (await check()) return; } catch { /* Recovery in progress. */ }
    await sleep(50);
  }
  throw new Error(`Timed out: ${description}`);
}

async function stopRedis() {
  if (local) {
    const pid = Number(await fs.readFile(path.join(redisDir, "redis.pid"), "utf8"));
    process.kill(pid, "SIGKILL");
  } else {
    await exec("docker", ["compose", "stop", "--timeout", "0", "redis"]);
  }
}

async function startRedis() {
  if (local) {
    await exec("redis-server", ["--bind", "127.0.0.1", "--port", process.env.VERIFY_REDIS_PORT,
      "--dir", redisDir, "--appendonly", "yes", "--appendfsync", "always", "--save", "",
      "--daemonize", "yes", "--pidfile", path.join(redisDir, "redis.pid"), "--logfile", path.join(redisDir, "redis.log")]);
  } else {
    await exec("docker", ["compose", "start", "redis"]);
  }
}

try {
  await waitFor(async () => await control.ping() === "PONG", "Redis startup");
  const version = (await control.info("server")).match(/redis_version:([^\r\n]+)/)[1];
  if (!local) assert.match(version, /^7\./, "Docker verification must actually use Redis 7");
  assert.equal((await control.config("GET", "appendonly"))[1], "yes");
  assert.equal((await control.config("GET", "appendfsync"))[1], "always");
  console.log(`Chaos target: Redis ${version}, AOF enabled, appendfsync=always`);
  await aggregator.clear();
  const tenants = ["legacy:a", "legacy", "tenant-3", "tenant-4"];
  const names = ["cpu", "a:cpu", "cpu", "cpu"];
  const expected = tenants.map(() => []);
  // Legacy API fixtures survive a new client and a Redis process/container crash.
  for (let t = 0; t < tenants.length; t++) {
    for (let i = 0; i < 20; i++) {
      const value = (t + 1) * 10000 + i;
      await aggregator.aggregate(tenants[t], names[t], value, Date.now() - 1000);
      expected[t].push(value);
    }
  }
  let sequence = 20;
  let buffered = 0;
  traffic = (async () => {
    while (running) {
      const index = sequence++;
      await Promise.all(tenants.map(async (tenantId, t) => {
        const value = (t + 1) * 10000 + index;
        const result = await gateway.ingest({ tenantId, metricName: names[t], value });
        if (result.status === "wal_buffered") buffered++;
        expected[t].push(value);
      }));
      await sleep(5);
    }
  })().catch(error => { trafficError = error; });
  await sleep(100);
  await stopRedis();
  console.log("Redis killed while ingestion remains live");
  await sleep(400);
  assert.ok(buffered > 0, "Outage must acknowledge durable WAL metrics");
  assert.ok((await fs.readdir(walDir)).some(file => file.endsWith(".wal")));
  await startRedis();
  await waitFor(async () => await control.ping() === "PONG", "Redis recovery");
  await waitFor(async () => !(await fs.readdir(walDir)).some(file => file.endsWith(".wal")), "automatic WAL replay during traffic");
  running = false;
  await traffic;
  if (trafficError) throw trafficError;
  await waitFor(async () => {
    await gateway.replayPendingWal();
    return !(await fs.readdir(walDir)).some(file => file.endsWith(".wal"));
  }, "final WAL drain");
  const reader = new MetricsAggregator();
  try {
    for (let t = 0; t < tenants.length; t++) {
      const result = await reader.getMetrics(tenants[t], names[t], 60000);
      assert.deepEqual(result.values.sort((a, b) => a - b), expected[t].sort((a, b) => a - b), "No drops, duplicates, or cross-tenant bleed");
    }
  } finally { await reader.close(); }
  assert.equal(unhandled, 0);
  console.log(`Chaos PASSED: ${expected.flat().length} metrics, ${buffered} WAL acknowledgements, zero drops/duplicates/unhandled rejections`);
} finally {
  running = false;
  await traffic;
  await gateway.close();
  await aggregator.close();
  control.disconnect();
  process.off("unhandledRejection", onRejection);
}
