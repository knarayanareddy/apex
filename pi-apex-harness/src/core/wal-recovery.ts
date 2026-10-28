import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { DurabilityMode, MutabilityClass, WalIntentRow } from "../types.ts";
import { extractNativeErrnoCode, getLinuxFsBridge } from "./linux-fs-bridge.ts";
import {
  normalizeLexicalWorkspaceRelPath,
  openParentDirFdBeneath,
  openWorkspaceRootFd,
  PathContainmentError,
  verifyOpenFdContainedInWorkspace
} from "./safe-path.ts";
import { type PrivateSpillStore, scrubSecretsInfallible } from "./spill-store.ts";
import type { StateDb } from "./state-db.ts";

export class OutcomeUnknownLockError extends Error {
  readonly unresolvedRows: WalIntentRow[];
  constructor(sessionId: string, unresolvedRows: WalIntentRow[]) {
    super(
      `OUTCOME_UNKNOWN_SESSION_LOCK [${sessionId}]: ${unresolvedRows.length} interrupted operation(s) require explicit resolution (${unresolvedRows.map((r) => `${r.tool_name}:${r.tool_call_id}`).join(", ")})`
    );
    this.name = "OutcomeUnknownLockError";
    this.unresolvedRows = unresolvedRows;
  }
}

export class PreDispatchAbortedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PreDispatchAbortedError";
  }
}

export class TranscriptNotSyncedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TranscriptNotSyncedError";
  }
}

export function computeBytesSha256(buf: Buffer | string): string {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

/**
 * Symlink-safe `O_NOFOLLOW` content SHA-256 computation.
 * Never uses `existsSync` (which misreports dangling symlinks as absent).
 */
export function computeFileContentSha256(absPath: string): string {
  let st: fs.Stats;
  try {
    st = fs.lstatSync(absPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return "MISSING";
    throw err;
  }
  if (st.isSymbolicLink()) return "NON_FILE:SYMLINK";
  if (!st.isFile()) return `NON_FILE:${st.mode}`;

  const fd = fs.openSync(absPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const fst = fs.fstatSync(fd);
    if (!fst.isFile()) return `NON_FILE:${fst.mode}`;
    return computeBytesSha256(fs.readFileSync(fd));
  } finally {
    fs.closeSync(fd);
  }
}

export function canonicalizeArgs(args: unknown): string {
  if (args === null || typeof args !== "object") return JSON.stringify(args);
  if (Array.isArray(args)) return `[${args.map(canonicalizeArgs).join(",")}]`;
  const rec = args as Record<string, unknown>;
  const keys = Object.keys(rec).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalizeArgs(rec[k])}`).join(",")}}`;
}

export function computeIdempotencyKey(params: {
  sessionId: string;
  leafId: string;
  toolCallId: string;
  toolName: string;
  canonicalArgs: string;
}): string {
  return computeBytesSha256(
    `${params.sessionId}:${params.leafId}:${params.toolCallId}:${params.toolName}:${params.canonicalArgs}`
  );
}

function getProcessUmask(): number {
  // Read current umask non-destructively where supported; default standard 0o022
  const prev = process.umask(0o022);
  process.umask(prev);
  return prev;
}

export interface DurableWriteOptions {
  /** Explicit POSIX permission bits (e.g. `0o755` or `0o644` when restoring Git blobs). Masked with `0o777`. */
  mode?: number;
  /** Optional workspaceRoot to enforce descriptor-relative `openat2` + `renameat` + `fsync(parentDirFd)`. */
  workspaceRoot?: string;
  /** Test-only fault-injection hook invoked AFTER `parentDirFd` is opened and BEFORE `renameatSingle`! */
  testRaceHookBeforeRename?: () => void;
}

/**
 * Reviewer #4 Issue #1 Fix:
 * Descriptor-relative atomic file write (`openat2(RESOLVE_BENEATH | RESOLVE_NO_SYMLINKS)` -> `fchmodSync` ->
 * `fsyncSync(tmpFd)` -> `renameat(parentDirFd, tmpName, parentDirFd, leafName)` -> `fsyncSync(parentDirFd)`).
 * Zero pathname-based `renameSync` or `unlinkSync` races!
 */
export function writeFileDurable(
  absPath: string,
  content: Buffer | string,
  durabilityMode: DurabilityMode,
  options?: DurableWriteOptions
): { afterContentSha256: string; appliedMode: number } {
  const bridge = getLinuxFsBridge();
  const buf = Buffer.isBuffer(content) ? content : Buffer.from(content, "utf8");
  const defaultNewMode = (0o666 & ~getProcessUmask()) & 0o777;

  if (options?.workspaceRoot) {
    const { realWs, relPath } = normalizeLexicalWorkspaceRelPath(options.workspaceRoot, absPath);
    if (!relPath) {
      throw new PathContainmentError(`[guard: cannot overwrite workspace root directory as file]`);
    }

    const { wsFd } = openWorkspaceRootFd(realWs);
    try {
      const parentInfo = openParentDirFdBeneath({
        wsFd,
        realWs,
        relPath,
        createMissingDirs: true
      });

      try {
        const existingEntry = bridge.fstatatNoFollow(parentInfo.parentDirFd, parentInfo.leafName);
        if (existingEntry && existingEntry.kind !== "file") {
          throw new PathContainmentError(
            `[guard: refusing to overwrite ${existingEntry.kind} with file at '${relPath}']`
          );
        }

        const existingMode = existingEntry?.kind === "file" ? existingEntry.mode & 0o777 : null;
        const rawMode =
          options.mode !== undefined
            ? options.mode
            : existingMode !== null
              ? existingMode
              : defaultNewMode;
        const targetMode = rawMode & 0o777;
        const tmpName = `.pi-apex-tmp.${process.pid}.${crypto.randomBytes(8).toString("hex")}`;

        const tmpFd = bridge.openBeneath(
          parentInfo.parentDirFd,
          tmpName,
          fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY,
          0o600
        );
        let closed = false;
        let renamed = false;

        try {
          verifyOpenFdContainedInWorkspace(tmpFd, realWs);
          fs.writeFileSync(tmpFd, buf);
          fs.fchmodSync(tmpFd, targetMode);
          if (durabilityMode === "power-loss-safe") {
            fs.fsyncSync(tmpFd);
          }
          fs.closeSync(tmpFd);
          closed = true;

          if (options.testRaceHookBeforeRename) {
            options.testRaceHookBeforeRename();
          }

          // Confirm `parentDirFd` itself was not moved outside `realWs`, then execute descriptor-bound `renameat`!
          verifyOpenFdContainedInWorkspace(parentInfo.parentDirFd, realWs);
          bridge.renameatSingle(
            parentInfo.parentDirFd,
            tmpName,
            parentInfo.parentDirFd,
            parentInfo.leafName
          );
          renamed = true;

          if (durabilityMode === "power-loss-safe") {
            fs.fsyncSync(parentInfo.parentDirFd);
          }

          return { afterContentSha256: computeBytesSha256(buf), appliedMode: targetMode };
        } finally {
          if (!closed) {
            try {
              fs.closeSync(tmpFd);
            } catch {
              // ignore
            }
          }
          if (!renamed) {
            try {
              bridge.unlinkatSingle(parentInfo.parentDirFd, tmpName, false);
            } catch {
              // ignore temp cleanup failure
            }
          }
        }
      } finally {
        if (parentInfo.ownsFd) fs.closeSync(parentInfo.parentDirFd);
      }
    } finally {
      fs.closeSync(wsFd);
    }
  }

  // Fallback when called without `workspaceRoot` (still uses descriptor-relative `parentDirFd`!)
  const targetPath = path.resolve(absPath);
  const parentDir = path.dirname(targetPath);
  const leafName = path.basename(targetPath);
  fs.mkdirSync(parentDir, { recursive: true });

  const parentDirFd = fs.openSync(
    parentDir,
    fs.constants.O_RDONLY | (fs.constants.O_DIRECTORY ?? 0) | fs.constants.O_NOFOLLOW
  );
  try {
    const existingEntry = bridge.fstatatNoFollow(parentDirFd, leafName);
    if (existingEntry && existingEntry.kind !== "file") {
      throw new PathContainmentError(
        `[guard: refusing to overwrite ${existingEntry.kind} target: ${targetPath}]`
      );
    }
    const existingMode = existingEntry?.kind === "file" ? existingEntry.mode & 0o777 : null;
    const rawMode =
      options?.mode !== undefined
        ? options.mode
        : existingMode !== null
          ? existingMode
          : defaultNewMode;
    const targetMode = rawMode & 0o777;
    const tmpName = `.pi-apex-tmp.${process.pid}.${crypto.randomBytes(8).toString("hex")}`;

    let tmpFd: number;
    try {
      tmpFd = bridge.openBeneath(
        parentDirFd,
        tmpName,
        fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY,
        0o600
      );
    } catch (err) {
      const code = extractNativeErrnoCode(err);
      throw new PathContainmentError(`openBeneath temp failed (${code ?? String(err)})`);
    }

    let closed = false;
    let renamed = false;
    try {
      fs.writeFileSync(tmpFd, buf);
      fs.fchmodSync(tmpFd, targetMode);
      if (durabilityMode === "power-loss-safe") {
        fs.fsyncSync(tmpFd);
      }
      fs.closeSync(tmpFd);
      closed = true;

      if (options?.testRaceHookBeforeRename) {
        options.testRaceHookBeforeRename();
      }

      bridge.renameatSingle(parentDirFd, tmpName, parentDirFd, leafName);
      renamed = true;

      if (durabilityMode === "power-loss-safe") {
        fs.fsyncSync(parentDirFd);
      }

      return { afterContentSha256: computeBytesSha256(buf), appliedMode: targetMode };
    } finally {
      if (!closed) {
        try {
          fs.closeSync(tmpFd);
        } catch {
          // ignore
        }
      }
      if (!renamed) {
        try {
          bridge.unlinkatSingle(parentDirFd, tmpName, false);
        } catch {
          // ignore
        }
      }
    }
  } finally {
    fs.closeSync(parentDirFd);
  }
}

export function getUnresolvedOutcomeUnknownRows(stateDb: StateDb, sessionId: string): WalIntentRow[] {
  return stateDb.db
    .prepare(`SELECT * FROM wal_intents WHERE session_id = ? AND status = 'OUTCOME_UNKNOWN' ORDER BY created_at_ms ASC`)
    .all(sessionId) as unknown as WalIntentRow[];
}

export function assertNoUnresolvedOutcomeUnknown(stateDb: StateDb, sessionId: string): void {
  const rows = getUnresolvedOutcomeUnknownRows(stateDb, sessionId);
  if (rows.length > 0) {
    throw new OutcomeUnknownLockError(sessionId, rows);
  }
}

export function resolveOutcomeUnknown(
  stateDb: StateDb,
  idempotencyKey: string,
  resolution: "mark_succeeded" | "allow_retry" | "abort",
  operatorNote = ""
): void {
  const now = Date.now();
  const row = stateDb.getWalRow(idempotencyKey);
  if (resolution === "allow_retry") {
    stateDb.db
      .prepare(`DELETE FROM wal_intents WHERE idempotency_key = ? AND status = 'OUTCOME_UNKNOWN'`)
      .run(idempotencyKey);
    return;
  }
  stateDb.db
    .prepare(
      `UPDATE wal_intents
       SET status = 'RESOLVED_BY_USER',
           result_json = COALESCE(result_json, ?),
           updated_at_ms = ?
       WHERE idempotency_key = ? AND status = 'OUTCOME_UNKNOWN'`
    )
    .run(JSON.stringify({ resolution, operatorNote }), now, idempotencyKey);

  // If resolving a synthetic/parent nested-subcall lock, mark its orphaned committed children RESOLVED_BY_USER/TRANSCRIPT_APPENDED
  if (row) {
    stateDb.db
      .prepare(
        `UPDATE wal_intents
         SET status = 'TRANSCRIPT_APPENDED', updated_at_ms = ?
         WHERE session_id = ? AND parent_tool_call_id = ? AND status = 'EFFECT_COMMITTED'`
      )
      .run(now, row.session_id, row.tool_call_id);
  }
}

/**
 * Promotes an `EFFECT_COMMITTED_RAW` row to `EFFECT_COMMITTED` by running secret-scrub + spill
 * (degrading inline on ENOSPC without re-executing the effect).
 */
function finalizeCommittedRawRow<T = unknown>(
  stateDb: StateDb,
  spillStore: PrivateSpillStore,
  row: WalIntentRow
): { finalText: string; details?: T; spilled: boolean; spillFallbackUsed: boolean } {
  const rawReceipt = row.raw_receipt_json
    ? (JSON.parse(row.raw_receipt_json) as { rawText: string; details?: T })
    : { rawText: "" };
  const spillOut = spillStore.scrubAndMaybeSpill(row.session_id, rawReceipt.rawText);
  const finalized = {
    finalText: spillOut.text,
    details: rawReceipt.details,
    spilled: spillOut.spilled,
    spillFallbackUsed: spillOut.spillFallbackUsed
  };
  stateDb.db
    .prepare(
      `UPDATE wal_intents
       SET status = 'EFFECT_COMMITTED', result_json = ?, updated_at_ms = ?
       WHERE idempotency_key = ?`
    )
    .run(JSON.stringify(finalized), Date.now(), row.idempotency_key);
  return finalized;
}

export interface ExecuteWalParams<T> {
  stateDb: StateDb;
  spillStore: PrivateSpillStore;
  sessionId: string;
  leafId: string;
  toolCallId: string;
  parentToolCallId?: string | null;
  toolName: string;
  mutabilityClass: MutabilityClass;
  args: unknown;
  /**
   * Framework preflight admission check executed BEFORE effect dispatch.
   * If this throws, operation is guaranteed pre-dispatch and recorded as ABORTED_CLEAN.
   */
  preflightAdmission?: () => void | Promise<void>;
  /** Required when mutabilityClass === 'LOCAL_REVERSIBLE' */
  localReversibleSpec?: {
    targetPath: string;
    expectedAfterBytes: Buffer | string;
  };
  /** Executes the underlying confined effect and returns raw output text + structured metadata. */
  executeEffect: () => Promise<{ rawText: string; details?: T }>;
}

export interface ExecuteWalResult<T> {
  idempotencyKey: string;
  fromCache: boolean;
  finalText: string;
  details?: T;
  spilled: boolean;
  spillFallbackUsed: boolean;
}

/**
 * Executes a tool through the Ring-0 WAL Spine with Two-Step Post-Effect Receipt (`EFFECT_COMMITTED_RAW`).
 *
 * Reviewer #3 Fix: Returning a result to an in-memory QuickJS `Codemode` VM (`parentToolCallId != null`)
 * stops at `EFFECT_COMMITTED` — NEVER `TRANSCRIPT_APPENDED`. Only durable persistence of the root
 * `toolResult` to Pi's JSONL transcript advances root + children to `TRANSCRIPT_APPENDED`.
 */
export async function executeThroughWalSpine<T = unknown>(
  params: ExecuteWalParams<T>
): Promise<ExecuteWalResult<T>> {
  const { stateDb, spillStore, sessionId, leafId, toolCallId, toolName, mutabilityClass } = params;
  assertNoUnresolvedOutcomeUnknown(stateDb, sessionId);

  const canonicalArgs = canonicalizeArgs(params.args);
  const idempotencyKey = computeIdempotencyKey({
    sessionId,
    leafId,
    toolCallId,
    toolName,
    canonicalArgs
  });

  const existing = stateDb.getWalRow(idempotencyKey);
  if (existing) {
    if (
      existing.status === "EFFECT_COMMITTED" ||
      existing.status === "TRANSCRIPT_APPENDED" ||
      existing.status === "EFFECT_COMMITTED_RAW"
    ) {
      if (existing.mutability_class === "LOCAL_REVERSIBLE" && existing.target_path && existing.after_content_sha256) {
        const diskHash = computeFileContentSha256(existing.target_path);
        if (diskHash !== existing.after_content_sha256) {
          stateDb.db
            .prepare(
              `UPDATE wal_intents
               SET status = 'OUTCOME_UNKNOWN',
                   error_text = ?,
                   updated_at_ms = ?
               WHERE idempotency_key = ?`
            )
            .run(
              `DISK_HASH_DRIFT_POST_COMMIT: expected ${existing.after_content_sha256}, found ${diskHash}`,
              Date.now(),
              idempotencyKey
            );
          assertNoUnresolvedOutcomeUnknown(stateDb, sessionId);
        }
      }

      if (existing.status === "EFFECT_COMMITTED_RAW") {
        const finalized = finalizeCommittedRawRow<T>(stateDb, spillStore, existing);
        return { idempotencyKey, fromCache: true, ...finalized };
      }

      const cached = JSON.parse(existing.result_json!) as Omit<ExecuteWalResult<T>, "idempotencyKey" | "fromCache">;
      return { idempotencyKey, fromCache: true, ...cached };
    }

    if (existing.status === "ABORTED_CLEAN") {
      stateDb.db.prepare(`DELETE FROM wal_intents WHERE idempotency_key = ?`).run(idempotencyKey);
    }
  }

  const targetPath = params.localReversibleSpec?.targetPath ?? null;
  const beforeSha = targetPath ? computeFileContentSha256(targetPath) : null;
  const afterSha = params.localReversibleSpec
    ? computeBytesSha256(params.localReversibleSpec.expectedAfterBytes)
    : null;

  const now = Date.now();
  stateDb.db
    .prepare(
      `INSERT INTO wal_intents (
        idempotency_key, session_id, leaf_id, tool_call_id, parent_tool_call_id,
        tool_name, mutability_class, target_path, before_content_sha256, after_content_sha256,
        canonical_args, status, created_at_ms, updated_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'INTENT_LOGGED', ?, ?)`
    )
    .run(
      idempotencyKey,
      sessionId,
      leafId,
      toolCallId,
      params.parentToolCallId ?? null,
      toolName,
      mutabilityClass,
      targetPath,
      beforeSha,
      afterSha,
      canonicalArgs,
      now,
      now
    );

  if (params.preflightAdmission) {
    try {
      await params.preflightAdmission();
    } catch (preflightErr) {
      const errMsg = preflightErr instanceof Error ? preflightErr.message : String(preflightErr);
      stateDb.db
        .prepare(`UPDATE wal_intents SET status = 'ABORTED_CLEAN', error_text = ?, updated_at_ms = ? WHERE idempotency_key = ?`)
        .run(errMsg, Date.now(), idempotencyKey);
      throw preflightErr;
    }
  }

  stateDb.db
    .prepare(`UPDATE wal_intents SET status = 'EXECUTING', updated_at_ms = ? WHERE idempotency_key = ?`)
    .run(Date.now(), idempotencyKey);

  let rawEffectOut: { rawText: string; details?: T };
  try {
    rawEffectOut = await params.executeEffect();
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    if (mutabilityClass === "PURE_READ") {
      stateDb.db
        .prepare(`UPDATE wal_intents SET status = 'ABORTED_CLEAN', error_text = ?, updated_at_ms = ? WHERE idempotency_key = ?`)
        .run(errMsg, Date.now(), idempotencyKey);
      throw err;
    }

    if (mutabilityClass === "LOCAL_REVERSIBLE" && targetPath) {
      const diskSha = computeFileContentSha256(targetPath);
      if (diskSha === beforeSha) {
        stateDb.db
          .prepare(`UPDATE wal_intents SET status = 'ABORTED_CLEAN', error_text = ?, updated_at_ms = ? WHERE idempotency_key = ?`)
          .run(errMsg, Date.now(), idempotencyKey);
        throw err;
      }
    }

    stateDb.db
      .prepare(`UPDATE wal_intents SET status = 'OUTCOME_UNKNOWN', error_text = ?, updated_at_ms = ? WHERE idempotency_key = ?`)
      .run(errMsg, Date.now(), idempotencyKey);
    throw err;
  }

  // Immediately persist EFFECT_COMMITTED_RAW before optional spill I/O
  const safeRawReceipt = JSON.stringify({
    rawText: scrubSecretsInfallible(rawEffectOut.rawText),
    details: rawEffectOut.details
  });
  stateDb.db
    .prepare(
      `UPDATE wal_intents
       SET status = 'EFFECT_COMMITTED_RAW', raw_receipt_json = ?, updated_at_ms = ?
       WHERE idempotency_key = ?`
    )
    .run(safeRawReceipt, Date.now(), idempotencyKey);

  const spillOut = spillStore.scrubAndMaybeSpill(sessionId, rawEffectOut.rawText);
  const finalizedPayload = {
    finalText: spillOut.text,
    details: rawEffectOut.details,
    spilled: spillOut.spilled,
    spillFallbackUsed: spillOut.spillFallbackUsed
  };

  // Both top-level AND nested QuickJS sub-calls stay EFFECT_COMMITTED until root JSONL append!
  stateDb.db
    .prepare(
      `UPDATE wal_intents
       SET status = 'EFFECT_COMMITTED', result_json = ?, updated_at_ms = ?
       WHERE idempotency_key = ?`
    )
    .run(JSON.stringify(finalizedPayload), Date.now(), idempotencyKey);

  return {
    idempotencyKey,
    fromCache: false,
    ...finalizedPayload
  };
}

export interface TranscriptSyncReceipt {
  synced: boolean;
  fileSynced: boolean;
  dirSynced: boolean;
}

/**
 * Explicitly synchronizes Pi's session JSONL file + parent directory to stable storage when
 * `durabilityMode === "power-loss-safe"`. Must complete BEFORE transitioning WAL rows to `TRANSCRIPT_APPENDED`.
 */
export function syncSessionTranscriptDurable(
  sessionFile: string | null | undefined,
  durabilityMode: DurabilityMode,
  requireFileWhenPowerLossSafe = false
): TranscriptSyncReceipt {
  if (durabilityMode !== "power-loss-safe") {
    return { synced: true, fileSynced: false, dirSynced: false };
  }

  if (!sessionFile || !fs.existsSync(sessionFile)) {
    if (requireFileWhenPowerLossSafe) {
      throw new TranscriptNotSyncedError(
        `power-loss-safe mode requires persisted session JSONL file before marking TRANSCRIPT_APPENDED (got '${sessionFile ?? "null"}')`
      );
    }
    return { synced: true, fileSynced: false, dirSynced: false };
  }

  const fileFd = fs.openSync(sessionFile, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    fs.fsyncSync(fileFd);
  } finally {
    fs.closeSync(fileFd);
  }

  const bridge = getLinuxFsBridge();
  const dirFd = bridge.openRootDir(fs.realpathSync(path.dirname(sessionFile)));
  try {
    fs.fsyncSync(dirFd);
  } finally {
    fs.closeSync(dirFd);
  }

  return { synced: true, fileSynced: true, dirSynced: true };
}

export interface MarkTranscriptAppendedOptions {
  rootIdempotencyKey?: string;
  sessionFile?: string | null;
  requireSessionFileWhenPowerLossSafe?: boolean;
  transcriptSynced?: boolean;
}

export function markWalTranscriptAppended(
  stateDb: StateDb,
  idempotencyKey: string,
  options?: Omit<MarkTranscriptAppendedOptions, "rootIdempotencyKey">
): void {
  const row = stateDb.getWalRow(idempotencyKey);
  if (!row) return;
  markWalCallTreeTranscriptAppended(stateDb, row.session_id, row.tool_call_id, {
    ...options,
    rootIdempotencyKey: idempotencyKey
  });
}

/**
 * Atomically transitions a root tool call AND all nested `<parentId>/<n>` QuickJS sub-calls
 * to `TRANSCRIPT_APPENDED` ONLY once the root toolResult is durably appended (and `fsync`ed in
 * `power-loss-safe` mode!) to Pi's JSONL transcript.
 */
export function markWalCallTreeTranscriptAppended(
  stateDb: StateDb,
  sessionId: string,
  rootToolCallId: string,
  optionsOrKey?: string | MarkTranscriptAppendedOptions
): void {
  const opts: MarkTranscriptAppendedOptions =
    typeof optionsOrKey === "string"
      ? { rootIdempotencyKey: optionsOrKey }
      : (optionsOrKey ?? {});

  if (stateDb.durabilityMode === "power-loss-safe") {
    if (opts.transcriptSynced === false) {
      throw new TranscriptNotSyncedError(
        `Refusing to mark WAL call tree '${rootToolCallId}' TRANSCRIPT_APPENDED in power-loss-safe mode before session JSONL fsync!`
      );
    }
    if (opts.transcriptSynced !== true) {
      syncSessionTranscriptDurable(
        opts.sessionFile,
        stateDb.durabilityMode,
        opts.requireSessionFileWhenPowerLossSafe ?? false
      );
    }
  }

  const now = Date.now();
  stateDb.db.exec("BEGIN IMMEDIATE");
  try {
    if (opts.rootIdempotencyKey) {
      stateDb.db
        .prepare(
          `UPDATE wal_intents
           SET status = 'TRANSCRIPT_APPENDED', updated_at_ms = ?
           WHERE idempotency_key = ? AND status IN ('EFFECT_COMMITTED', 'EFFECT_COMMITTED_RAW')`
        )
        .run(now, opts.rootIdempotencyKey);
    } else {
      stateDb.db
        .prepare(
          `UPDATE wal_intents
           SET status = 'TRANSCRIPT_APPENDED', updated_at_ms = ?
           WHERE session_id = ? AND tool_call_id = ? AND parent_tool_call_id IS NULL
             AND status IN ('EFFECT_COMMITTED', 'EFFECT_COMMITTED_RAW')`
        )
        .run(now, sessionId, rootToolCallId);
    }

    stateDb.db
      .prepare(
        `UPDATE wal_intents
         SET status = 'TRANSCRIPT_APPENDED', updated_at_ms = ?
         WHERE session_id = ? AND (parent_tool_call_id = ? OR tool_call_id LIKE ? || '/%')
           AND status IN ('EFFECT_COMMITTED', 'EFFECT_COMMITTED_RAW')`
      )
      .run(now, sessionId, rootToolCallId, rootToolCallId);

    stateDb.db.exec("COMMIT");
  } catch (err) {
    stateDb.db.exec("ROLLBACK");
    throw err;
  }
}

export interface StartupReconcileSummary {
  promotedFromCommittedRaw: string[];
  replayedCommitted: WalIntentRow[];
  promotedLocalReversible: string[];
  abortedClean: string[];
  outcomeUnknown: WalIntentRow[];
}

/**
 * Reconciles incomplete WAL intents after a process crash/SIGKILL:
 * 1. Explicitly promotes `EFFECT_COMMITTED_RAW -> EFFECT_COMMITTED` via `spillStore` (never re-running effects).
 * 2. Verifies `LOCAL_REVERSIBLE` post-commit file SHA-256 on disk.
 * 3. Locks session with `OUTCOME_UNKNOWN` if nested QuickJS side-effecting sub-calls finished (`EFFECT_COMMITTED`)
 *    before the parent `codemode` call durably appended its `toolResult` to JSONL!
 */
export function reconcileWalOnStartup(
  stateDb: StateDb,
  spillStore: PrivateSpillStore,
  sessionId: string
): StartupReconcileSummary {
  const pending = stateDb.db
    .prepare(
      `SELECT * FROM wal_intents
       WHERE session_id = ?
         AND status NOT IN ('TRANSCRIPT_APPENDED', 'ABORTED_CLEAN', 'RESOLVED_BY_USER')
       ORDER BY created_at_ms ASC`
    )
    .all(sessionId) as unknown as WalIntentRow[];

  const summary: StartupReconcileSummary = {
    promotedFromCommittedRaw: [],
    replayedCommitted: [],
    promotedLocalReversible: [],
    abortedClean: [],
    outcomeUnknown: []
  };

  const orphanedMutatingChildrenByParent = new Map<string, WalIntentRow[]>();

  for (const row of pending) {
    const now = Date.now();
    if (row.status === "INTENT_LOGGED") {
      stateDb.db
        .prepare(`UPDATE wal_intents SET status = 'ABORTED_CLEAN', updated_at_ms = ? WHERE idempotency_key = ?`)
        .run(now, row.idempotency_key);
      summary.abortedClean.push(row.idempotency_key);
      continue;
    }

    if (row.status === "EFFECT_COMMITTED_RAW" || row.status === "EFFECT_COMMITTED") {
      if (row.mutability_class === "LOCAL_REVERSIBLE" && row.target_path && row.after_content_sha256) {
        const diskHash = computeFileContentSha256(row.target_path);
        if (diskHash !== row.after_content_sha256) {
          stateDb.db
            .prepare(
              `UPDATE wal_intents SET status = 'OUTCOME_UNKNOWN', error_text = ?, updated_at_ms = ? WHERE idempotency_key = ?`
            )
            .run(
              `POST_COMMIT_FILE_MISMATCH: expected ${row.after_content_sha256}, found ${diskHash}`,
              now,
              row.idempotency_key
            );
          summary.outcomeUnknown.push(stateDb.getWalRow(row.idempotency_key)!);
          continue;
        }
      }

      let committedRow = row;
      if (row.status === "EFFECT_COMMITTED_RAW") {
        finalizeCommittedRawRow(stateDb, spillStore, row);
        summary.promotedFromCommittedRaw.push(row.idempotency_key);
        committedRow = stateDb.getWalRow(row.idempotency_key)!;
      }

      if (!committedRow.parent_tool_call_id) {
        summary.replayedCommitted.push(committedRow);
      } else if (committedRow.mutability_class === "PURE_READ") {
        // Pure-read sub-call inside an interrupted Codemode script has zero external/disk side effects
        stateDb.db
          .prepare(`UPDATE wal_intents SET status = 'ABORTED_CLEAN', updated_at_ms = ? WHERE idempotency_key = ?`)
          .run(now, committedRow.idempotency_key);
        summary.abortedClean.push(committedRow.idempotency_key);
      } else {
        const list = orphanedMutatingChildrenByParent.get(committedRow.parent_tool_call_id) ?? [];
        list.push(committedRow);
        orphanedMutatingChildrenByParent.set(committedRow.parent_tool_call_id, list);
      }
      continue;
    }

    if (row.status === "EXECUTING") {
      if (row.mutability_class === "PURE_READ") {
        stateDb.db
          .prepare(`UPDATE wal_intents SET status = 'ABORTED_CLEAN', updated_at_ms = ? WHERE idempotency_key = ?`)
          .run(now, row.idempotency_key);
        summary.abortedClean.push(row.idempotency_key);
        continue;
      }

      if (row.mutability_class === "LOCAL_REVERSIBLE" && row.target_path) {
        const diskHash = computeFileContentSha256(row.target_path);
        if (diskHash === row.after_content_sha256) {
          const synthetic = JSON.stringify({
            finalText: `Recovered completed write to ${row.target_path}`,
            spilled: false,
            spillFallbackUsed: false
          });
          stateDb.db
            .prepare(
              `UPDATE wal_intents SET status = 'EFFECT_COMMITTED', result_json = ?, updated_at_ms = ? WHERE idempotency_key = ?`
            )
            .run(synthetic, now, row.idempotency_key);
          summary.promotedLocalReversible.push(row.idempotency_key);
          const updatedRow = stateDb.getWalRow(row.idempotency_key)!;
          if (!updatedRow.parent_tool_call_id) {
            summary.replayedCommitted.push(updatedRow);
          } else {
            const list = orphanedMutatingChildrenByParent.get(updatedRow.parent_tool_call_id) ?? [];
            list.push(updatedRow);
            orphanedMutatingChildrenByParent.set(updatedRow.parent_tool_call_id, list);
          }
          continue;
        }
        if (diskHash === row.before_content_sha256) {
          stateDb.db
            .prepare(`UPDATE wal_intents SET status = 'ABORTED_CLEAN', updated_at_ms = ? WHERE idempotency_key = ?`)
            .run(now, row.idempotency_key);
          summary.abortedClean.push(row.idempotency_key);
          continue;
        }
      }

      stateDb.db
        .prepare(
          `UPDATE wal_intents
           SET status = 'OUTCOME_UNKNOWN',
               error_text = COALESCE(error_text, 'Process crashed while EXECUTING opaque/diverged operation'),
               updated_at_ms = ?
           WHERE idempotency_key = ?`
        )
        .run(now, row.idempotency_key);
      summary.outcomeUnknown.push(stateDb.getWalRow(row.idempotency_key)!);
      continue;
    }

    if (row.status === "OUTCOME_UNKNOWN") {
      summary.outcomeUnknown.push(row);
    }
  }

  // Handle nested QuickJS sub-calls that committed side effects before the parent `codemode` appended to JSONL!
  for (const [parentCallId, children] of orphanedMutatingChildrenByParent.entries()) {
    const parentRow = stateDb.db
      .prepare(
        `SELECT * FROM wal_intents WHERE session_id = ? AND tool_call_id = ? AND parent_tool_call_id IS NULL`
      )
      .get(sessionId, parentCallId) as unknown as WalIntentRow | undefined;

    if (parentRow && (parentRow.status === "TRANSCRIPT_APPENDED" || parentRow.status === "EFFECT_COMMITTED")) {
      // Parent itself committed cleanly — keep children aligned with parent
      if (parentRow.status === "TRANSCRIPT_APPENDED") {
        markWalCallTreeTranscriptAppended(stateDb, sessionId, parentCallId, parentRow.idempotency_key);
      }
      continue;
    }

    const childSummary = children.map((c) => ({
      toolCallId: c.tool_call_id,
      toolName: c.tool_name,
      mutabilityClass: c.mutability_class,
      canonicalArgs: c.canonical_args
    }));
    const detailMsg = `UNAPPENDED_NESTED_SUBCALL_EFFECTS: ${children.length} nested sub-call(s) committed inside QuickJS before parent '${parentCallId}' appended to JSONL: ${JSON.stringify(childSummary)}`;

    if (parentRow) {
      stateDb.db
        .prepare(
          `UPDATE wal_intents
           SET status = 'OUTCOME_UNKNOWN', error_text = ?, updated_at_ms = ?
           WHERE idempotency_key = ?`
        )
        .run(detailMsg, Date.now(), parentRow.idempotency_key);
      const refreshed = stateDb.getWalRow(parentRow.idempotency_key)!;
      if (!summary.outcomeUnknown.some((r) => r.idempotency_key === refreshed.idempotency_key)) {
        summary.outcomeUnknown.push(refreshed);
      }
    } else {
      // Parent Codemode wasn't wrapped in its own WAL row — insert explicit synthetic session lock row
      const lockKey = computeIdempotencyKey({
        sessionId,
        leafId: children[0].leaf_id,
        toolCallId: parentCallId,
        toolName: "codemode",
        canonicalArgs: "{}"
      });
      const existingLock = stateDb.getWalRow(lockKey);
      if (!existingLock) {
        const ts = Date.now();
        stateDb.db
          .prepare(
            `INSERT INTO wal_intents (
              idempotency_key, session_id, leaf_id, tool_call_id, parent_tool_call_id,
              tool_name, mutability_class, canonical_args, status, error_text, created_at_ms, updated_at_ms
            ) VALUES (?, ?, ?, ?, NULL, 'codemode', 'OPAQUE_EXTERNAL', '{}', 'OUTCOME_UNKNOWN', ?, ?, ?)`
          )
          .run(lockKey, sessionId, children[0].leaf_id, parentCallId, detailMsg, ts, ts);
      }
      const lockRow = stateDb.getWalRow(lockKey)!;
      if (!summary.outcomeUnknown.some((r) => r.idempotency_key === lockRow.idempotency_key)) {
        summary.outcomeUnknown.push(lockRow);
      }
    }
  }

  return summary;
}
