/**
 * Ring 2 — Background Terminal PTY Leases (`pty_start`, `pty_poll`, `pty_stop`)
 *          + Unattended Cron Routines (`DENY_UNATTENDED`)
 *
 * UPSTREAM OPEN-SOURCE PROVENANCE:
 * 1. `anomalyco/opencode` @ `7c16f4ac3ea5` — `packages/core/src/pty.ts` (MIT License, Anomaly):
 *    - `BUFFER_LIMIT = 2 * 1024 * 1024` (2 MiB ring buffer), `EXITED_LIMIT = 25` retention cap,
 *      `buffer` / `bufferCursor` / `cursor` incremental replay cursor semantics (`poll(id, cursor)`),
 *      and `teardown` lifecycle cleanup.
 * 2. `NousResearch/hermes-agent` @ `1f91da2a2770` — `tools/process_registry.py` & `cron/jobs.py`
 *    (MIT License, Nous Research):
 *    - `MAX_PROCESSES = 64` LRU pruning, per-session watch-pattern rate-limit circuit breaker
 *      (`WATCH_MIN_INTERVAL_SECONDS = 15`, `WATCH_STRIKE_LIMIT = 3`, `WATCH_LIFETIME_MAX_HITS = 8`).
 *    - Cron scheduler (`create | list | pause | resume | remove | tick`), global `pause`/`resume`
 *      emergency stop, misfire catch-up on resume, and durable SQLite job/run ledger.
 * 3. Ring 0 Security Wiring (`SPEC_BIBLE.md` Invariant `I-08`):
 *    - Detached lease with best-effort descendant cleanup and explicit unverified status;
 *      sanitized subprocess environment (zero host API keys leaked).
 *    - Every unattended Cron tick runs strictly under `executionOrigin = "unattended_cron"`
 *      (`DENY_UNATTENDED` fail-closed gate).
 */

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import crypto from "node:crypto";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { GuardrailsConfig, SandboxMode } from "../types.ts";
import {
  buildMinimalBwrapArgv,
  probeBwrapFunctional,
  SandboxUnavailableError
} from "../core/bwrap-sandbox.ts";
import {
  evaluateShellCommandGuard,
  GuardDeniedError,
  resolveAndValidateWorkspacePath
} from "../core/monotonic-guard.ts";
import { recordProcessIdentity, terminateProcessTree, type ProcessIdentity } from "../core/process-tree.ts";

// ============================================================================
// Upstream Constants (`anomalyco/opencode/src/pty.ts` + `hermes-agent/process_registry.py`)
// ============================================================================

export const PTY_BUFFER_LIMIT_BYTES = 2 * 1024 * 1024; // OpenCode `BUFFER_LIMIT`
export const PTY_EXITED_RETENTION_LIMIT = 25; // OpenCode `EXITED_LIMIT`
export const HERMES_MAX_PROCESSES = 64; // Hermes `MAX_PROCESSES`
export const WATCH_MIN_INTERVAL_MS = 15_000; // Hermes `WATCH_MIN_INTERVAL_SECONDS = 15`
export const WATCH_STRIKE_LIMIT = 3; // Hermes `WATCH_STRIKE_LIMIT = 3`
export const WATCH_LIFETIME_MAX_HITS = 8; // Hermes `WATCH_LIFETIME_MAX_HITS = 8`

const DEFAULT_LEASE_MS = 60_000;
const MAX_LEASE_MS = 3_600_000;

export interface PtyLeaseInfo {
  id: string;
  title: string;
  command: string;
  cwd: string;
  status: "running" | "leader_exited" | "exited" | "lease_expired" | "cleanup_pending" | "cleanup_unverified";
  /** Snapshot-based only; it does not prove that no reparented descendants exist. */
  cleanupStatus?: "pending" | "snapshot_cleared" | "unverified";
  pid: number;
  exitCode?: number | null;
  startedAtMs: number;
  leaseExpiresAtMs: number;
  cursor: number;
  bufferCursor: number;
  watchDisabled: boolean;
  watchHitsDelivered: number;
}

interface ActivePtySession {
  info: PtyLeaseInfo;
  proc: ChildProcess;
  procIdentity: ProcessIdentity;
  buffer: string;
  leaseTimer: ReturnType<typeof setTimeout>;
  watchPatterns: RegExp[];
  lastWatchDeliveryMs: number;
  watchStrikes: number;
  watchMatchesLog: string[];
}

function buildSanitizedPtyEnv(): NodeJS.ProcessEnv {
  const safe: NodeJS.ProcessEnv = {
    PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
    HOME: process.env.HOME ?? "/tmp",
    LANG: process.env.LANG ?? "C.UTF-8",
    TERM: "xterm-256color",
    PI_APEX_PTY: "1"
  };
  return safe;
}

export interface PtyPollResult {
  id: string;
  status: PtyLeaseInfo["status"];
  cleanupStatus?: PtyLeaseInfo["cleanupStatus"];
  exitCode?: number | null;
  replay: string;
  cursor: number;
  bufferCursor: number;
  truncatedBytes: number;
  watchMatches: string[];
  watchDisabled: boolean;
}

export class PtyLeaseManager {
  private readonly workspaceRoot: string;
  private readonly guardrails: GuardrailsConfig;
  private readonly sandboxMode: SandboxMode;
  private readonly allowUnsandboxedDev: boolean;
  private readonly sessions = new Map<string, ActivePtySession>();
  private readonly exitOrder: string[] = [];

  constructor(opts: {
    workspaceRoot: string;
    guardrails: GuardrailsConfig;
    sandboxMode?: SandboxMode;
    allowUnsandboxedDev?: boolean;
  }) {
    this.workspaceRoot = path.resolve(opts.workspaceRoot);
    this.guardrails = opts.guardrails;
    this.sandboxMode = opts.sandboxMode ?? "workspace-write";
    this.allowUnsandboxedDev = opts.allowUnsandboxedDev ?? false;
  }

  public start(input: {
    command: string;
    title?: string;
    leaseMs?: number;
    watchPatterns?: string[];
  }): PtyLeaseInfo {
    if (this.sandboxMode === "read-only") {
      throw new GuardDeniedError("PTY_COMMAND_DENIED: PTY background process execution is denied in read-only sandbox mode.");
    }

    const probe = probeBwrapFunctional();
    let bin = "bwrap";
    let argv: string[];

    if (this.sandboxMode === "danger-full-access") {
      bin = "/bin/bash";
      argv = ["-c", input.command];
    } else if (probe.ok) {
      bin = "bwrap";
      argv = buildMinimalBwrapArgv(input.command, this.workspaceRoot, {
        workspaceRoot: this.workspaceRoot,
        mode: this.sandboxMode,
        unshareNet: this.guardrails.sandbox.unshare_network_by_default,
        allowUnsandboxedDev: this.allowUnsandboxedDev,
        unmaskedSecretExceptions: this.guardrails.sandbox.unmasked_exceptions
      });
    } else {
      if (!this.allowUnsandboxedDev) {
        throw new SandboxUnavailableError(
          process.platform === "darwin"
            ? "SANDBOX_UNAVAILABLE: PTY execution failed (bubblewrap is not supported on macOS darwin). Refusing unconfined execution without explicit allowUnsandboxedDev: true."
            : `SANDBOX_UNAVAILABLE: PTY execution failed (bubblewrap is not functional on Linux host: ${probe.reason ?? "unknown"}). Refusing unconfined execution without explicit allowUnsandboxedDev: true.`
        );
      }
      console.warn(
        `[APEX_CONFINEMENT_WARNING] Running unconfined development PTY on ${process.platform}. Kernel namespaces disabled.`
      );
      bin = "/bin/bash";
      argv = ["-c", input.command];
    }

    const guard = evaluateShellCommandGuard({
      command: input.command,
      cfg: this.guardrails,
      approvalPolicy: "never",
      unattendedRoutine: false
    });
    if (!guard.allowed) {
      throw new Error(`PTY_COMMAND_DENIED: ${guard.reason}`);
    }

    // Hermes `MAX_PROCESSES` LRU pruning of finished sessions before allocating a new slot
    this.pruneExitedIfNeeded();
    if (this.sessions.size >= HERMES_MAX_PROCESSES) {
      throw new Error(
        `PTY_MAX_PROCESSES_REACHED: ${HERMES_MAX_PROCESSES} active background sessions already running.`
      );
    }

    const id = `pty_${crypto.randomUUID().slice(0, 8)}`;
    const now = Date.now();
    const leaseMs = Math.max(250, Math.min(input.leaseMs ?? DEFAULT_LEASE_MS, MAX_LEASE_MS));

    const compiledWatches: RegExp[] = [];
    for (const pat of input.watchPatterns ?? []) {
      try {
        compiledWatches.push(new RegExp(pat));
      } catch {
        // Ignore malformed watch regex rather than crashing spawn
      }
    }

    const proc = spawn(bin, argv, {
      cwd: this.workspaceRoot,
      env: bin === "/bin/bash" ? buildSanitizedPtyEnv() : {},
      detached: true,
      stdio: ["pipe", "pipe", "pipe"]
    });

    const info: PtyLeaseInfo = {
      id,
      title: input.title ?? `PTY ${id.slice(-4)}`,
      command: input.command,
      cwd: this.workspaceRoot,
      status: "running",
      pid: proc.pid ?? -1,
      startedAtMs: now,
      leaseExpiresAtMs: now + leaseMs,
      cursor: 0,
      bufferCursor: 0,
      watchDisabled: false,
      watchHitsDelivered: 0
    };

    const procIdentity = recordProcessIdentity(proc.pid ?? -1);

    const leaseTimer = setTimeout(() => {
      const current = this.sessions.get(id);
      if (current && current.info.status === "running") {
        this.requestCleanup(current, "lease_expired", false);
      }
    }, leaseMs);
    leaseTimer.unref();

    const session: ActivePtySession = {
      info,
      proc,
      procIdentity,
      buffer: "",
      leaseTimer,
      watchPatterns: compiledWatches,
      lastWatchDeliveryMs: 0,
      watchStrikes: 0,
      watchMatchesLog: []
    };

    const onChunk = (raw: Buffer | string) => {
      const chunk = typeof raw === "string" ? raw : raw.toString("utf8");
      session.info.cursor += chunk.length;
      session.buffer += chunk;

      // OpenCode `packages/core/src/pty.ts` 2 MiB rolling ring buffer cursor adjustment
      if (session.buffer.length > PTY_BUFFER_LIMIT_BYTES) {
        const excess = session.buffer.length - PTY_BUFFER_LIMIT_BYTES;
        session.buffer = session.buffer.slice(excess);
        session.info.bufferCursor += excess;
      }

      // Hermes `process_registry.py` watch-pattern strike + lifetime circuit breaker
      if (!session.info.watchDisabled && session.watchPatterns.length > 0) {
        const matched = session.watchPatterns.find((re) => re.test(chunk));
        if (matched) {
          const ts = Date.now();
          if (
            session.lastWatchDeliveryMs > 0 &&
            ts - session.lastWatchDeliveryMs < WATCH_MIN_INTERVAL_MS
          ) {
            session.watchStrikes += 1;
            if (session.watchStrikes >= WATCH_STRIKE_LIMIT) {
              session.info.watchDisabled = true;
            }
          } else {
            session.watchStrikes = 0;
            session.lastWatchDeliveryMs = ts;
            session.info.watchHitsDelivered += 1;
            session.watchMatchesLog.push(matched.source);
            if (session.info.watchHitsDelivered >= WATCH_LIFETIME_MAX_HITS) {
              session.info.watchDisabled = true;
            }
          }
        }
      }
    };

    proc.stdout?.on("data", onChunk);
    proc.stderr?.on("data", onChunk);
    const markLeaderExited = (code: number | null) => {
      if (session.info.status === "running") {
        // A closed leader is not evidence that reparented descendants exited.
        session.info.status = "leader_exited";
        session.info.cleanupStatus = "unverified";
      }
      session.info.exitCode = code;
    };
    // `close` can be delayed by inherited pipes after the leader itself exits.
    proc.on("exit", markLeaderExited);
    proc.on("close", (code) => {
      clearTimeout(session.leaseTimer);
      markLeaderExited(code);
      if (this.sessions.has(id) && (session.info.status === "leader_exited" || !session.info.cleanupStatus || session.info.cleanupStatus === "snapshot_cleared")) {
        this.recordExitOrder(id);
      }
    });

    this.sessions.set(id, session);
    return { ...info };
  }

  /**
   * OpenCode `Pty.attach` / `replay` cursor semantics:
   * - `cursor === undefined`: replays entire retained buffer from `bufferCursor`.
   * - `cursor === -1`: tails from current end (`""`).
   * - `cursor >= 0`: replays only unread output from `max(cursor, bufferCursor)` to `info.cursor`.
   */
  public poll(id: string, requestedCursor?: number): PtyPollResult {
    const session = this.sessions.get(id);
    if (!session) {
      throw new Error(`PTY_NOT_FOUND: ${id}`);
    }

    let replay = "";
    let truncatedBytes = 0;
    if (requestedCursor === -1) {
      replay = "";
    } else if (requestedCursor === undefined) {
      replay = session.buffer;
      truncatedBytes = session.info.bufferCursor;
    } else {
      if (requestedCursor < session.info.bufferCursor) {
        truncatedBytes = session.info.bufferCursor - requestedCursor;
      }
      const effectiveStart = Math.max(requestedCursor, session.info.bufferCursor);
      const offsetInBuffer = Math.max(0, effectiveStart - session.info.bufferCursor);
      replay = session.buffer.slice(offsetInBuffer);
    }

    const watchMatches = session.watchMatchesLog.splice(0, session.watchMatchesLog.length);
    return {
      id: session.info.id,
      status: session.info.status,
      cleanupStatus: session.info.cleanupStatus,
      exitCode: session.info.exitCode,
      replay,
      cursor: session.info.cursor,
      bufferCursor: session.info.bufferCursor,
      truncatedBytes,
      watchMatches,
      watchDisabled: session.info.watchDisabled
    };
  }

  public writeStdin(id: string, data: string): void {
    const session = this.sessions.get(id);
    if (!session) throw new Error(`PTY_NOT_FOUND: ${id}`);
    if (session.info.status !== "running") {
      throw new Error(`PTY_EXITED: ${id} is already '${session.info.status}'.`);
    }
    session.proc.stdin?.write(data);
  }

  public stop(id: string, removeRecord = false): PtyLeaseInfo {
    const session = this.sessions.get(id);
    if (!session) throw new Error(`PTY_NOT_FOUND: ${id}`);
    clearTimeout(session.leaseTimer);
    if (session.info.status === "running") {
      this.requestCleanup(session, "exited", removeRecord);
    }
    const snap = { ...session.info };
    if (removeRecord && (session.info.status === "leader_exited" || (session.info.status === "exited" && session.info.cleanupStatus !== "unverified"))) {
      this.sessions.delete(id);
      const idx = this.exitOrder.indexOf(id);
      if (idx !== -1) this.exitOrder.splice(idx, 1);
    }
    return snap;
  }

  public list(): PtyLeaseInfo[] {
    return Array.from(this.sessions.values()).map((s) => ({ ...s.info }));
  }

  public dispose(): void {
    for (const session of this.sessions.values()) {
      clearTimeout(session.leaseTimer);
      if (session.info.status === "running") {
        this.requestCleanup(session, "exited", true);
      }
    }
  }

  private requestCleanup(session: ActivePtySession, successStatus: "exited" | "lease_expired", removeRecord: boolean): void {
    session.info.status = successStatus === "lease_expired" ? "lease_expired" : "cleanup_pending";
    session.info.cleanupStatus = "pending";
    const finish = (success: boolean, diagnostic: string) => {
      session.info.cleanupStatus = success ? "snapshot_cleared" : "unverified";
      session.info.status = success ? successStatus : "cleanup_unverified";
      if (!success) {
        console.warn(`[PTY_CLEANUP_UNVERIFIED] ${diagnostic}`);
        return;
      }
      this.recordExitOrder(session.info.id);
      if (removeRecord) {
        this.sessions.delete(session.info.id);
        const index = this.exitOrder.indexOf(session.info.id);
        if (index !== -1) this.exitOrder.splice(index, 1);
      }
    };
    void terminateProcessTree(session.proc.pid ?? -1, session.procIdentity)
      .then((result) => finish(result.success, result.diagnostic))
      .catch((error) => finish(false, error instanceof Error ? error.message : String(error)));
  }

  private recordExitOrder(id: string): void {
    if (!this.exitOrder.includes(id)) {
      this.exitOrder.push(id);
    }
    while (this.exitOrder.length > PTY_EXITED_RETENTION_LIMIT) {
      const oldest = this.exitOrder.shift();
      if (oldest) this.sessions.delete(oldest);
    }
  }

  private pruneExitedIfNeeded(): void {
    if (this.sessions.size < HERMES_MAX_PROCESSES) return;
    while (this.exitOrder.length > 0 && this.sessions.size >= HERMES_MAX_PROCESSES) {
      const oldest = this.exitOrder.shift();
      if (oldest) this.sessions.delete(oldest);
    }
  }
}

// ============================================================================
// Upstream `NousResearch/hermes-agent` Cron Scheduler + Ring 0 `DENY_UNATTENDED`
// ============================================================================

export interface CronRoutineRecord {
  jobId: string;
  name: string;
  intervalMs: number;
  command: string;
  targetPaths: string[];
  paused: boolean;
  nextRunAtMs: number;
  lastRunAtMs: number | null;
  misfirePending: boolean;
  createdAtMs: number;
}

export interface CronRunReceipt {
  runId: string;
  jobId: string;
  executedAtMs: number;
  status: "SUCCEEDED" | "FAILED" | "BLOCKED_DENY_UNATTENDED";
  exitCode: number;
  output: string;
  blockedRuleId?: string;
}

export class UnattendedCronScheduler {
  private readonly db: DatabaseSync;
  private readonly workspaceRoot: string;
  private readonly guardrails: GuardrailsConfig;
  private readonly sandboxMode: SandboxMode;
  private readonly allowUnsandboxedDev: boolean;
  private globalPaused = false;
  private globalPauseReason: string | null = null;

  constructor(opts: {
    db: DatabaseSync;
    workspaceRoot: string;
    guardrails: GuardrailsConfig;
    sandboxMode?: SandboxMode;
    allowUnsandboxedDev?: boolean;
  }) {
    this.db = opts.db;
    this.workspaceRoot = path.resolve(opts.workspaceRoot);
    this.guardrails = opts.guardrails;
    this.sandboxMode = opts.sandboxMode ?? "workspace-write";
    this.allowUnsandboxedDev = opts.allowUnsandboxedDev ?? false;
    this.initSchema();
  }

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS cron_jobs (
        job_id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        interval_ms INTEGER NOT NULL,
        command TEXT NOT NULL,
        target_paths_json TEXT NOT NULL,
        paused INTEGER NOT NULL DEFAULT 0,
        next_run_at_ms INTEGER NOT NULL,
        last_run_at_ms INTEGER,
        misfire_pending INTEGER NOT NULL DEFAULT 0,
        created_at_ms INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS cron_runs (
        run_id TEXT PRIMARY KEY,
        job_id TEXT NOT NULL,
        executed_at_ms INTEGER NOT NULL,
        status TEXT NOT NULL,
        exit_code INTEGER NOT NULL,
        output TEXT NOT NULL,
        blocked_rule_id TEXT
      );
    `);
  }

  /**
   * Hermes `hermes pause` / `hermes resume` global emergency stop.
   */
  public pauseAll(reason = "operator emergency pause"): void {
    this.globalPaused = true;
    this.globalPauseReason = reason;
  }

  public resumeAll(): void {
    this.globalPaused = false;
    this.globalPauseReason = null;
  }

  public isGloballyPaused(): { paused: boolean; reason: string | null } {
    return { paused: this.globalPaused, reason: this.globalPauseReason };
  }

  public createRoutine(params: {
    name: string;
    intervalMs: number;
    command: string;
    targetPaths?: string[];
    nowMs?: number;
  }): CronRoutineRecord {
    const now = params.nowMs ?? Date.now();
    const intervalMs = Math.max(1_000, params.intervalMs);
    const jobId = `cron_${crypto.randomUUID().slice(0, 8)}`;
    const targetPaths = params.targetPaths ?? [];

    this.db
      .prepare(
        `INSERT INTO cron_jobs (
          job_id, name, interval_ms, command, target_paths_json, paused, next_run_at_ms, last_run_at_ms, misfire_pending, created_at_ms
        ) VALUES (?, ?, ?, ?, ?, 0, ?, NULL, 0, ?)`
      )
      .run(
        jobId,
        params.name,
        intervalMs,
        params.command,
        JSON.stringify(targetPaths),
        now + intervalMs,
        now
      );

    return this.getRoutine(jobId)!;
  }

  public pauseRoutine(jobId: string, nowMs = Date.now()): CronRoutineRecord {
    const job = this.getRoutine(jobId);
    if (!job) throw new Error(`CRON_JOB_NOT_FOUND: ${jobId}`);
    const misfire = nowMs >= job.nextRunAtMs ? 1 : job.misfirePending ? 1 : 0;
    this.db
      .prepare(`UPDATE cron_jobs SET paused = 1, misfire_pending = ? WHERE job_id = ?`)
      .run(misfire, jobId);
    return this.getRoutine(jobId)!;
  }

  /**
   * Hermes `cron.resume` semantics:
   * A recurring slot that came due while paused stays due as a single misfire catch-up
   * on the next tick; otherwise `nextRunAtMs` stays in the future.
   */
  public resumeRoutine(jobId: string, nowMs = Date.now()): CronRoutineRecord {
    const job = this.getRoutine(jobId);
    if (!job) throw new Error(`CRON_JOB_NOT_FOUND: ${jobId}`);
    const cameDueWhilePaused = job.misfirePending || nowMs >= job.nextRunAtMs;
    const nextRunAtMs = cameDueWhilePaused ? nowMs : job.nextRunAtMs;
    this.db
      .prepare(
        `UPDATE cron_jobs SET paused = 0, misfire_pending = ?, next_run_at_ms = ? WHERE job_id = ?`
      )
      .run(cameDueWhilePaused ? 1 : 0, nextRunAtMs, jobId);
    return this.getRoutine(jobId)!;
  }

  public removeRoutine(jobId: string): boolean {
    const res = this.db.prepare(`DELETE FROM cron_jobs WHERE job_id = ?`).run(jobId);
    return Number(res.changes ?? 0) > 0;
  }

  public listRoutines(): CronRoutineRecord[] {
    const rows = this.db
      .prepare(`SELECT * FROM cron_jobs ORDER BY created_at_ms ASC`)
      .all() as Array<Record<string, unknown>>;
    return rows.map((r) => this.hydrateJob(r));
  }

  public getRoutine(jobId: string): CronRoutineRecord | undefined {
    const row = this.db
      .prepare(`SELECT * FROM cron_jobs WHERE job_id = ?`)
      .get(jobId) as Record<string, unknown> | undefined;
    return row ? this.hydrateJob(row) : undefined;
  }

  public listRuns(jobId?: string): CronRunReceipt[] {
    const rows = (
      jobId
        ? this.db
            .prepare(`SELECT * FROM cron_runs WHERE job_id = ? ORDER BY executed_at_ms ASC`)
            .all(jobId)
        : this.db.prepare(`SELECT * FROM cron_runs ORDER BY executed_at_ms ASC`).all()
    ) as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      runId: String(r.run_id),
      jobId: String(r.job_id),
      executedAtMs: Number(r.executed_at_ms),
      status: String(r.status) as CronRunReceipt["status"],
      exitCode: Number(r.exit_code),
      output: String(r.output),
      blockedRuleId: r.blocked_rule_id ? String(r.blocked_rule_id) : undefined
    }));
  }

  /**
   * Executes all due unattended routines at `nowMs`, enforcing Ring 0's
   * `executionOrigin = "unattended_cron"` (`DENY_UNATTENDED`) fail-closed gate!
   */
  public tick(nowMs = Date.now()): CronRunReceipt[] {
    if (this.globalPaused) {
      return [];
    }

    const dueRows = this.db
      .prepare(
        `SELECT * FROM cron_jobs WHERE paused = 0 AND next_run_at_ms <= ? ORDER BY next_run_at_ms ASC`
      )
      .all(nowMs) as Array<Record<string, unknown>>;

    const receipts: CronRunReceipt[] = [];
    for (const row of dueRows) {
      const job = this.hydrateJob(row);
      const receipt = this.executeSingleUnattendedJob(job, nowMs);
      receipts.push(receipt);

      const nextRunAtMs = nowMs + job.intervalMs;
      this.db
        .prepare(
          `UPDATE cron_jobs
           SET last_run_at_ms = ?, next_run_at_ms = ?, misfire_pending = 0
           WHERE job_id = ?`
        )
        .run(nowMs, nextRunAtMs, job.jobId);
    }

    return receipts;
  }

  private executeSingleUnattendedJob(job: CronRoutineRecord, nowMs: number): CronRunReceipt {
    const runId = `crun_${crypto.randomUUID().slice(0, 8)}`;

    if (this.sandboxMode === "read-only") {
      return this.persistRunReceipt({
        runId,
        jobId: job.jobId,
        executedAtMs: nowMs,
        status: "BLOCKED_DENY_UNATTENDED",
        exitCode: 126,
        output: "DENY_UNATTENDED (READ_ONLY_SANDBOX): cron routine execution denied in read-only sandbox mode",
        blockedRuleId: "READ_ONLY_SANDBOX"
      });
    }

    const probe = probeBwrapFunctional();
    let bin = "bwrap";
    let argv: string[];

    if (this.sandboxMode === "danger-full-access") {
      bin = "/bin/bash";
      argv = ["-c", job.command];
    } else if (probe.ok) {
      bin = "bwrap";
      argv = buildMinimalBwrapArgv(job.command, this.workspaceRoot, {
        workspaceRoot: this.workspaceRoot,
        mode: this.sandboxMode,
        unshareNet: this.guardrails.sandbox.unshare_network_by_default,
        allowUnsandboxedDev: this.allowUnsandboxedDev,
        unmaskedSecretExceptions: this.guardrails.sandbox.unmasked_exceptions
      });
    } else {
      if (!this.allowUnsandboxedDev) {
        return this.persistRunReceipt({
          runId,
          jobId: job.jobId,
          executedAtMs: nowMs,
          status: "BLOCKED_DENY_UNATTENDED",
          exitCode: 126,
          output: `DENY_UNATTENDED (CONFINEMENT_UNAVAILABLE): bubblewrap confinement is unavailable on ${process.platform} (${probe.reason ?? "unknown"}). Refusing unconfined execution without explicit allowUnsandboxedDev: true`,
          blockedRuleId: "CONFINEMENT_UNAVAILABLE"
        });
      }
      console.warn(
        `[APEX_CONFINEMENT_WARNING] Running unconfined development cron on ${process.platform}. Kernel namespaces disabled.`
      );
      bin = "/bin/bash";
      argv = ["-c", job.command];
    }

    // 1. Check declared target paths via Ring 0 `resolveAndValidateWorkspacePath` (blocks `.env`, `.git`, outside-ws)
    for (const rel of job.targetPaths) {
      try {
        resolveAndValidateWorkspacePath(rel, this.workspaceRoot, "read", this.guardrails);
      } catch (err) {
        const msg = err instanceof GuardDeniedError ? err.message : String(err);
        return this.persistRunReceipt({
          runId,
          jobId: job.jobId,
          executedAtMs: nowMs,
          status: "BLOCKED_DENY_UNATTENDED",
          exitCode: 126,
          output: `DENY_UNATTENDED (PATH_GUARD): ${msg}`,
          blockedRuleId: "PATH_GUARD"
        });
      }
    }

    // 2. Check shell command under `unattendedRoutine: true` (`DENY_UNATTENDED` blocks `git push`, `curl -X POST`, `rm -rf`, etc.)
    const isDestructiveUnattended = /\brm\s+-[a-zA-Z]*r[a-zA-Z]*f?\b/i.test(job.command);
    const shellGuard = evaluateShellCommandGuard({
      command: job.command,
      cfg: this.guardrails,
      approvalPolicy: "on-request",
      unattendedRoutine: true
    });
    if (!shellGuard.allowed || isDestructiveUnattended) {
      const reason = !shellGuard.allowed
        ? shellGuard.reason
        : "[guard: DENY_UNATTENDED — recursive deletion blocked in unattended cron]";
      return this.persistRunReceipt({
        runId,
        jobId: job.jobId,
        executedAtMs: nowMs,
        status: "BLOCKED_DENY_UNATTENDED",
        exitCode: 126,
        output: reason,
        blockedRuleId: "DENY_UNATTENDED"
      });
    }

    // 3. Execute safe unattended command
    const res = spawnSync(bin, argv, {
      cwd: this.workspaceRoot,
      encoding: "utf8",
      timeout: 30_000,
      env: bin === "/bin/bash" ? buildSanitizedPtyEnv() : {}
    });
    const exitCode = res.status ?? 1;
    const output = `${res.stdout ?? ""}\n${res.stderr ?? ""}`.trim();

    return this.persistRunReceipt({
      runId,
      jobId: job.jobId,
      executedAtMs: nowMs,
      status: exitCode === 0 ? "SUCCEEDED" : "FAILED",
      exitCode,
      output: output.slice(0, 8_000)
    });
  }

  private persistRunReceipt(receipt: CronRunReceipt): CronRunReceipt {
    this.db
      .prepare(
        `INSERT INTO cron_runs (run_id, job_id, executed_at_ms, status, exit_code, output, blocked_rule_id)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        receipt.runId,
        receipt.jobId,
        receipt.executedAtMs,
        receipt.status,
        receipt.exitCode,
        receipt.output,
        receipt.blockedRuleId ?? null
      );
    return receipt;
  }

  private hydrateJob(row: Record<string, unknown>): CronRoutineRecord {
    return {
      jobId: String(row.job_id),
      name: String(row.name),
      intervalMs: Number(row.interval_ms),
      command: String(row.command),
      targetPaths: JSON.parse(String(row.target_paths_json || "[]")) as string[],
      paused: Number(row.paused) === 1,
      nextRunAtMs: Number(row.next_run_at_ms),
      lastRunAtMs: row.last_run_at_ms !== null ? Number(row.last_run_at_ms) : null,
      misfirePending: Number(row.misfire_pending) === 1,
      createdAtMs: Number(row.created_at_ms)
    };
  }
}
