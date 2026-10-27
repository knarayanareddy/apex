import { randomUUID } from "node:crypto";
import { Redis } from "ioredis";

declare module "ioredis" {
  interface Redis {
    appendMetric(key: string, ...args: (string | number)[]): Promise<number>;
    readMetrics(key: string, ...args: number[]): Promise<string[]>;
  }
}

// A retry uses the same member, so an ambiguous network failure cannot double count.
// Uses single variadic ZADD call to avoid event loop contention across the C/Lua boundary.
const APPEND = `
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', '(' .. ARGV[1])
local added = 0
if #ARGV >= 4 then
  added = redis.call('ZADD', KEYS[1], 'NX', unpack(ARGV, 3))
end
redis.call('PEXPIRE', KEYS[1], ARGV[2])
return added
`;
const READ = `
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', '(' .. ARGV[1])
return redis.call('ZRANGEBYSCORE', KEYS[1], ARGV[2], '+inf')
`;

export function validateMetric(tenantId: string, metricName: string, value: number, timestamp: number): void {
  if (typeof tenantId !== "string" || !tenantId || typeof metricName !== "string" || !metricName ||
      !Number.isFinite(value) || !Number.isSafeInteger(timestamp)) {
    throw new TypeError("Metrics require nonempty tenant/name, a finite value, and an integer timestamp");
  }
}

export class MetricsAggregator {
  private redis: Redis;
  private prefix: string;
  private retentionMs: number;
  private connecting?: Promise<void>;
  private closed = false;
  private pending = new Map<string, { timestamp: number; member: string; resolve: () => void; reject: (error: unknown) => void }[]>();

  constructor(opts: {
    maxBufferSize?: number; // Accepted for compatibility; never truncate a burst by count.
    redisUrl?: string;
    namespace?: string;
    retentionMs?: number;
  } = {}) {
    this.retentionMs = opts.retentionMs ?? 7 * 24 * 60 * 60 * 1000;
    if (!Number.isSafeInteger(this.retentionMs) || this.retentionMs <= 0) {
      throw new TypeError("retentionMs must be a positive integer");
    }
    this.prefix = `metrics:${Buffer.from(opts.namespace ?? process.env.METRICS_NAMESPACE ?? "default").toString("base64url")}:`;
    this.redis = new Redis(opts.redisUrl ?? process.env.REDIS_URL ?? "redis://127.0.0.1:6379", {
      lazyConnect: true,
      enableOfflineQueue: false,
      enableAutoPipelining: true,
      maxRetriesPerRequest: 0,
      connectTimeout: 500,
      commandTimeout: 1000,
      autoResendUnfulfilledCommands: false,
      retryStrategy: times => Math.min(times * 50, 500)
    });
    // Connection failures are surfaced by awaited commands, never as unhandled events.
    this.redis.on("error", () => {});
    this.redis.defineCommand("appendMetric", { numberOfKeys: 1, lua: APPEND });
    this.redis.defineCommand("readMetrics", { numberOfKeys: 1, lua: READ });
  }

  private async ready(): Promise<void> {
    if (this.closed) throw new Error("Aggregator is closed");
    if (this.redis.status === "ready") return;
    if (this.connecting) return this.connecting;
    if (this.redis.status !== "wait") throw new Error("Redis is unavailable");
    this.connecting = this.redis.connect().finally(() => { this.connecting = undefined; });
    return this.connecting;
  }

  private getKey(tenantId: string, metricName: string): string {
    // Hash tag {tenantTag} forces Redis Cluster to map all metrics for this tenant
    // to the same hash slot, while base64url encoding guarantees collision safety.
    const tenantTag = Buffer.from(tenantId).toString("base64url");
    const metricTag = Buffer.from(metricName).toString("base64url");
    return `${this.prefix}{${tenantTag}}:${metricTag}`;
  }

  async aggregate(tenantId: string, metricName: string, value: number, timestamp = Date.now(), eventId: string = randomUUID()): Promise<void> {
    validateMetric(tenantId, metricName, value, timestamp);
    await this.ready();
    const key = this.getKey(tenantId, metricName);
    await new Promise<void>((resolve, reject) => {
      if (!this.pending.size) queueMicrotask(() => this.flush());
      const entries = this.pending.get(key) ?? [];
      entries.push({ timestamp, member: JSON.stringify([eventId, value]), resolve, reject });
      this.pending.set(key, entries);
    });
  }

  private flush(): void {
    const batch = this.pending;
    this.pending = new Map();
    for (const [key, entries] of batch) {
      // Bound script duration while coalescing a burst into fewer durable writes.
      for (let start = 0; start < entries.length; start += 512) {
        const chunk = entries.slice(start, start + 512);
        const args = chunk.flatMap(entry => [entry.timestamp, entry.member]);
        void this.redis.appendMetric(key, Date.now() - this.retentionMs, this.retentionMs, ...args).then(
          () => { for (const entry of chunk) entry.resolve(); },
          error => { for (const entry of chunk) entry.reject(error); }
        );
      }
    }
  }

  async getMetrics(tenantId: string, metricName: string, windowMs = 60000): Promise<{
    count: number; sum: number; avg: number; p99: number; values: number[];
  }> {
    if (!Number.isFinite(windowMs) || windowMs < 0 || windowMs > this.retentionMs) {
      throw new RangeError("windowMs must be between zero and retentionMs");
    }
    await this.ready();
    const now = Date.now();
    const entries = await this.redis.readMetrics(this.getKey(tenantId, metricName), now - this.retentionMs, now - windowMs);
    const values = entries.map(entry => (JSON.parse(entry) as [string, number])[1]);
    const count = values.length;
    const sum = values.reduce((acc, value) => acc + value, 0);
    const sorted = [...values].sort((a, b) => a - b);
    return { count, sum, avg: count ? sum / count : 0, p99: count ? sorted[Math.floor(count * 0.99)] : 0, values };
  }

  // Administrative operation: callers must quiesce writers first. Never FLUSHDB.
  async clear(): Promise<void> {
    await this.ready();
    let cursor = "0";
    do {
      const [next, keys] = await this.redis.scan(cursor, "MATCH", `${this.prefix}*`, "COUNT", 500);
      cursor = next;
      if (keys.length) await this.redis.unlink(...keys);
    } while (cursor !== "0");
  }

  async close(): Promise<void> {
    this.closed = true;
    this.redis.disconnect();
  }
}
