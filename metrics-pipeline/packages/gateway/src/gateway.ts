import fs from "node:fs";
import { promises as fsp } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { MetricsAggregator, validateMetric } from "../../ingest/src/aggregator.ts";

export interface IngestPayload {
  tenantId: string;
  metricName: string;
  value: number;
  timestamp?: number;
}

interface WalRecord extends IngestPayload {
  id: string;
  timestamp: number;
}

type Aggregator = Pick<MetricsAggregator, "aggregate" | "getMetrics">;

export class ApiGateway {
  private aggregator: Aggregator;
  private walDir: string;
  private isDegraded = false;
  private dirSyncPromise?: Promise<void>;
  private replaying?: Promise<number>;
  private timer: ReturnType<typeof setInterval>;
  private closed = false;
  // Exposes disk/corruption errors instead of creating unhandled background rejections.
  lastReplayError: unknown;

  constructor(opts: { aggregator: Aggregator; walDir?: string; recoveryIntervalMs?: number }) {
    this.aggregator = opts.aggregator;
    this.walDir = path.resolve(opts.walDir ?? ".wal");
    fs.mkdirSync(this.walDir, { recursive: true });
    this.timer = setInterval(() => {
      void this.replayPendingWal().catch(error => { this.lastReplayError = error; });
    }, opts.recoveryIntervalMs ?? 1000);
    this.timer.unref();
  }

  private async syncDirectory(): Promise<void> {
    if (this.dirSyncPromise) return this.dirSyncPromise;
    this.dirSyncPromise = (async () => {
      const directory = await fsp.open(this.walDir, "r");
      try { await directory.sync(); } finally { await directory.close(); }
    })().finally(() => { this.dirSyncPromise = undefined; });
    return this.dirSyncPromise;
  }

  private async append(record: WalRecord): Promise<void> {
    // One immutable append-only segment per record. Only atomically published,
    // fsynced segments are replayed; a torn, unacknowledged .tmp is never read.
    const temporary = path.join(this.walDir, `${record.id}.tmp`);
    const file = await fsp.open(temporary, "wx", 0o600);
    try {
      await file.writeFile(JSON.stringify(record) + "\n");
      await file.sync();
    } finally {
      await file.close();
    }
    await fsp.rename(temporary, path.join(this.walDir, `${record.id}.wal`));
    await this.syncDirectory();
  }

  async ingest(payload: IngestPayload): Promise<{ status: "ingested" | "wal_buffered" }> {
    if (this.closed) throw new Error("Gateway is closed");
    const record = { ...payload, timestamp: payload.timestamp ?? Date.now(), id: randomUUID() };
    // Invalid input must not trip the breaker or poison recovery indefinitely.
    validateMetric(record.tenantId, record.metricName, record.value, record.timestamp);
    if (!this.isDegraded) {
      try {
        await this.aggregator.aggregate(record.tenantId, record.metricName, record.value, record.timestamp, record.id);
        return { status: "ingested" };
      } catch {
        this.isDegraded = true;
      }
    }
    // Acknowledge only after durable publication. Disk failures propagate to caller.
    await this.append(record);
    return { status: "wal_buffered" };
  }

  replayPendingWal(): Promise<number> {
    if (this.closed) return Promise.resolve(0);
    if (!this.replaying) {
      this.replaying = this.replay().finally(() => { this.replaying = undefined; });
    }
    return this.replaying;
  }

  private async replay(): Promise<number> {
    const files = (await fsp.readdir(this.walDir)).filter(file => file.endsWith(".wal")).sort();
    let count = 0;
    // Strict chronological replay: commit all pending WAL files to Redis first.
    // isDegraded remains true during replay to prevent live traffic from interleaving
    // ahead of the outage backlog for the same sliding window.
    for (const name of files) {
      const filename = path.join(this.walDir, name);
      let contents: string;
      try {
        contents = await fsp.readFile(filename, "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
      const record = JSON.parse(contents) as WalRecord;
      validateMetric(record.tenantId, record.metricName, record.value, record.timestamp);
      if (typeof record.id !== "string" || `${record.id}.wal` !== name) {
        throw new Error(`Invalid WAL record: ${name}`);
      }
      try {
        await this.aggregator.aggregate(record.tenantId, record.metricName, record.value, record.timestamp, record.id);
      } catch (error) {
        this.isDegraded = true;
        this.lastReplayError = error;
        return count;
      }
      // Redis idempotency makes a crash between commit and unlink safe, including
      // concurrent replayers in different processes sharing this WAL directory.
      await fsp.unlink(filename).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
      });
      await this.syncDirectory();
      count++;
    }

    // ALL backlog files in this batch have been committed to Redis and unlinked.
    // Reset degraded state only AFTER complete drain to ensure clean monotonic handoff.
    this.isDegraded = false;
    this.lastReplayError = undefined;
    return count;
  }

  async getAggregated(tenantId: string, metricName: string, windowMs = 60000) {
    return this.aggregator.getMetrics(tenantId, metricName, windowMs);
  }

  async close(): Promise<void> {
    this.closed = true;
    clearInterval(this.timer);
    await this.replaying;
  }
}
