import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
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

export type WalContentBlock = TextContent | ImageContent;

export interface NormalizedWalResult<T = unknown> {
  finalText: string;
  content: WalContentBlock[];
  details?: T;
  isError?: boolean;
  spilled: boolean;
  spillFallbackUsed: boolean;
}

/**
 * Normalizes tool results through a single shared bounded path:
 * 1. Computes total aggregate text across all text blocks and rawText.
 * 2. Runs scrubSecretsInfallible + spillStore.scrubAndMaybeSpill (handles disk spill and inline ENOSPC fallback).
 * 3. When text is bounded (spilled === true || spillFallbackUsed === true):
 *    - Replaces text blocks so that the aggregate delivered text in `content` does not exceed the inline budget,
 *      embedding the bounded/spilled reference text in the primary text block.
 *    - Preserves all image blocks, MIME types, and relative ordering intact.
 * 4. When text is within inline budget:
 *    - Scrubs secrets across all text blocks and preserves all image blocks.
 */
export function normalizeWalToolResult<T = unknown>(params: {
  sessionId: string;
  spillStore: PrivateSpillStore;
  rawText?: string;
  content?: WalContentBlock[];
  details?: T;
  isError?: boolean;
}): NormalizedWalResult<T> {
  const { sessionId, spillStore, details, isError } = params;
  const rawContent = params.content;

  const rawTextBlocks = rawContent
    ? rawContent.filter((c): c is TextContent => c.type === "text" && typeof (c as any).text === "string")
    : [];
  const contentJoined = rawTextBlocks.map((c) => c.text).join("\n");
  const callerRaw = typeof params.rawText === "string" ? params.rawText : undefined;

  let aggregateRawText: string;
  if (rawTextBlocks.length > 0) {
    if (callerRaw !== undefined && Buffer.byteLength(callerRaw, "utf8") > Buffer.byteLength(contentJoined, "utf8")) {
      aggregateRawText = callerRaw;
    } else {
      aggregateRawText = contentJoined;
    }
  } else {
    aggregateRawText = callerRaw ?? "";
  }

  const spillOut = spillStore.scrubAndMaybeSpill(sessionId, aggregateRawText);
  const textIsBounded = spillOut.spilled || spillOut.spillFallbackUsed;

  let finalContent: WalContentBlock[];

  if (rawContent && rawContent.length > 0) {
    if (textIsBounded) {
      // Programme F3: Preserve full ordered structured content in successful private spill storage
      const structSpill = spillStore.spillStructuredContent(sessionId, rawContent);
      let primaryTextSet = false;
      let primaryDeliveryText: string | undefined;
      finalContent = [];
      for (const block of rawContent) {
        if (block.type === "image") {
          finalContent.push(block);
        } else if (block.type === "text") {
          if (!primaryTextSet) {
            primaryTextSet = true;
            let deliveryText = spillOut.text;
            if (structSpill.spilled && structSpill.spillPath) {
              deliveryText += `\n[FULL STRUCTURED CONTENT PRESERVED: ${structSpill.spillPath}]`;
            } else {
              deliveryText += "\n[FULL STRUCTURED CONTENT UNAVAILABLE: structured spill failed]";
            }
            primaryDeliveryText = deliveryText;
            finalContent.push({ ...block, text: deliveryText });
          }
        } else {
          finalContent.push(block);
        }
      }
      if (!primaryTextSet && spillOut.text) {
        primaryDeliveryText = spillOut.text;
        finalContent.unshift({ type: "text", text: spillOut.text });
      }
      const combinedText = finalContent
        .filter((b): b is TextContent => b.type === "text" && typeof (b as any).text === "string")
        .map((b) => (b as any).text)
        .join("\n");
      return {
        finalText: combinedText || (primaryDeliveryText ?? spillOut.text),
        content: finalContent,
        details,
        isError,
        spilled: spillOut.spilled,
        spillFallbackUsed: spillOut.spillFallbackUsed
      };
    } else {
      finalContent = rawContent.map((block) => {
        if (block.type === "text" && typeof (block as any).text === "string") {
          return { ...block, text: scrubSecretsInfallible((block as any).text) };
        }
        return block;
      });
    }
  } else {
    finalContent = [{ type: "text", text: spillOut.text }];
  }

  return {
    finalText: spillOut.text,
    content: finalContent,
    details,
    isError,
    spilled: spillOut.spilled,
    spillFallbackUsed: spillOut.spillFallbackUsed
  };
}

/**
 * Promotes an `EFFECT_COMMITTED_RAW` row to `EFFECT_COMMITTED` by running secret-scrub + spill
 * (degrading inline on ENOSPC without re-executing the effect).
 */
function finalizeCommittedRawRow<T = unknown>(
  stateDb: StateDb,
  spillStore: PrivateSpillStore,
  row: WalIntentRow
): NormalizedWalResult<T> {
  let rawReceipt: SupportedReceipt;
  if (!row.raw_receipt_json || typeof row.raw_receipt_json !== "string" || !row.raw_receipt_json.trim()) {
    const diagnostic = `[WAL_RECEIPT_INVALID: raw_receipt_json missing or empty]`;
    const errorResult: NormalizedWalResult<T> = {
      finalText: diagnostic,
      content: [{ type: "text", text: diagnostic }],
      details: { error: "RECEIPT_MISSING_OR_EMPTY", code: "WAL_RECEIPT_INVALID" } as unknown as T,
      isError: true,
      spilled: false,
      spillFallbackUsed: false
    };
    stateDb.db
      .prepare(
        `UPDATE wal_intents
         SET status = 'EFFECT_COMMITTED', result_json = ?, updated_at_ms = ?
         WHERE idempotency_key = ?`
      )
      .run(JSON.stringify(errorResult), Date.now(), row.idempotency_key);
    return errorResult;
  }

  const decode = decodeCommittedReceipt(row.raw_receipt_json);
  if (!decode.ok) {
    const diagnostic = `[WAL_RECEIPT_INVALID: raw_receipt_json corrupt: ${decode.reason}]`;
    const errorResult: NormalizedWalResult<T> = {
      finalText: diagnostic,
      content: [{ type: "text", text: diagnostic }],
      details: { error: decode.reason, code: decode.code } as unknown as T,
      isError: true,
      spilled: false,
      spillFallbackUsed: false
    };
    stateDb.db
      .prepare(
        `UPDATE wal_intents
         SET status = 'EFFECT_COMMITTED', result_json = ?, updated_at_ms = ?
         WHERE idempotency_key = ?`
      )
      .run(JSON.stringify(errorResult), Date.now(), row.idempotency_key);
    return errorResult;
  }
  rawReceipt = decode.receipt;

  const normalized = normalizeWalToolResult<T>({
    sessionId: row.session_id,
    spillStore,
    rawText: typeof rawReceipt.finalText === "string" ? rawReceipt.finalText : rawReceipt.rawText,
    content: Array.isArray(rawReceipt.content) ? rawReceipt.content : undefined,
    details: rawReceipt.details as T,
    isError: rawReceipt.isError
  });

  stateDb.db
    .prepare(
      `UPDATE wal_intents
       SET status = 'EFFECT_COMMITTED', result_json = ?, updated_at_ms = ?
       WHERE idempotency_key = ?`
    )
    .run(JSON.stringify(normalized), Date.now(), row.idempotency_key);
  return normalized;
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
  executeEffect: () => Promise<{
    rawText?: string;
    content?: WalContentBlock[];
    details?: T;
    isError?: boolean;
  }>;
}

export interface ExecuteWalResult<T> {
  idempotencyKey: string;
  fromCache: boolean;
  finalText: string;
  content: WalContentBlock[];
  details?: T;
  isError?: boolean;
  spilled: boolean;
  spillFallbackUsed: boolean;
}

export interface SupportedReceipt {
  finalText?: string;
  rawText?: string;
  content?: WalContentBlock[];
  details?: unknown;
  isError?: boolean;
  spilled?: boolean;
  spillFallbackUsed?: boolean;
  normalizedVersion?: number;
}

export type ReceiptDecodeResult =
  | { ok: true; receipt: SupportedReceipt }
  | {
      ok: false;
      code: "WAL_RECEIPT_INVALID";
      reason: string;
    };

export interface EnsureNormalizedCommittedResultParams<T = unknown> {
  receipt: unknown;
  spillStore: PrivateSpillStore;
  sessionId: string;
}

export interface EnsureNormalizedCommittedResultOutcome<T = unknown> {
  result: NormalizedWalResult<T>;
  changed: boolean;
  invalid?: boolean;
  reason?: string;
}

/**
 * Decodes a raw receipt (JSON string or object) into a SupportedReceipt.
 * Distinguishes:
 *  - Valid modern receipt (has finalText and/or content)
 *  - Supported legacy receipt (has rawText, details, isError)
 *  - Legitimate empty result (finalText: "", rawText: "", or empty content array)
 *  - Malformed JSON (syntax error)
 *  - Unsupported top-level type or receipt shape (null, array, primitive, object lacking receipt fields)
 */
export function decodeCommittedReceipt(raw: unknown): ReceiptDecodeResult {
  if (raw === null || raw === undefined) {
    return {
      ok: false,
      code: "WAL_RECEIPT_INVALID",
      reason: "RECEIPT_NULL_OR_UNDEFINED: receipt payload is null or undefined"
    };
  }

  let parsed: unknown;
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (!trimmed) {
      return {
        ok: false,
        code: "WAL_RECEIPT_INVALID",
        reason: "RECEIPT_EMPTY_STRING: raw receipt is an empty string"
      };
    }
    try {
      parsed = JSON.parse(trimmed);
    } catch (err: any) {
      const posMatch = typeof err?.message === "string" ? err.message.match(/position\s+(\d+)/i) : null;
      const posSuffix = posMatch ? ` (at position ${posMatch[1]})` : "";
      return {
        ok: false,
        code: "WAL_RECEIPT_INVALID",
        reason: `JSON_SYNTAX_ERROR${posSuffix}`
      };
    }
  } else if (typeof raw === "object") {
    parsed = raw;
  } else {
    return {
      ok: false,
      code: "WAL_RECEIPT_INVALID",
      reason: `UNSUPPORTED_TOP_LEVEL_TYPE: receipt cannot be of type ${typeof raw}`
    };
  }

  if (parsed === null || typeof parsed !== "object") {
    return {
      ok: false,
      code: "WAL_RECEIPT_INVALID",
      reason: "NON_OBJECT_RECEIPT: parsed receipt is not a valid JSON object"
    };
  }

  if (Array.isArray(parsed)) {
    return {
      ok: false,
      code: "WAL_RECEIPT_INVALID",
      reason: "ARRAY_RECEIPT_NOT_SUPPORTED: receipt cannot be an array"
    };
  }

  const obj = parsed as Record<string, unknown>;

  // Validate field types if present
  if (obj["finalText"] !== undefined && typeof obj["finalText"] !== "string") {
    return {
      ok: false,
      code: "WAL_RECEIPT_INVALID",
      reason: "INVALID_FIELD_TYPE: finalText must be a string"
    };
  }
  if (obj["rawText"] !== undefined && typeof obj["rawText"] !== "string") {
    return {
      ok: false,
      code: "WAL_RECEIPT_INVALID",
      reason: "INVALID_FIELD_TYPE: rawText must be a string"
    };
  }
  if (obj["content"] !== undefined && !Array.isArray(obj["content"])) {
    return {
      ok: false,
      code: "WAL_RECEIPT_INVALID",
      reason: "INVALID_FIELD_TYPE: content must be an array"
    };
  }
  if (obj["isError"] !== undefined && typeof obj["isError"] !== "boolean") {
    return {
      ok: false,
      code: "WAL_RECEIPT_INVALID",
      reason: "INVALID_FIELD_TYPE: isError must be a boolean"
    };
  }
  if (obj["spilled"] !== undefined && typeof obj["spilled"] !== "boolean") {
    return {
      ok: false,
      code: "WAL_RECEIPT_INVALID",
      reason: "INVALID_FIELD_TYPE: spilled must be a boolean"
    };
  }
  if (obj["spillFallbackUsed"] !== undefined && typeof obj["spillFallbackUsed"] !== "boolean") {
    return {
      ok: false,
      code: "WAL_RECEIPT_INVALID",
      reason: "INVALID_FIELD_TYPE: spillFallbackUsed must be a boolean"
    };
  }

  // Must have at least one recognized supported receipt field:
  // (finalText, rawText, content, details, isError, or spilled)
  const hasRecognizedField =
    obj["finalText"] !== undefined ||
    obj["rawText"] !== undefined ||
    obj["content"] !== undefined ||
    obj["details"] !== undefined ||
    obj["isError"] !== undefined ||
    obj["spilled"] !== undefined;

  if (!hasRecognizedField) {
    return {
      ok: false,
      code: "WAL_RECEIPT_INVALID",
      reason: "MISSING_REQUIRED_FIELDS: object lacks recognized receipt fields (finalText, rawText, content, details, isError)"
    };
  }

  // Check content elements if present
  if (Array.isArray(obj["content"])) {
    for (let i = 0; i < obj["content"].length; i++) {
      const block = obj["content"][i];
      if (!block || typeof block !== "object") {
        return {
          ok: false,
          code: "WAL_RECEIPT_INVALID",
          reason: `MALFORMED_CONTENT_BLOCK: block at index ${i} is not an object`
        };
      }
      const blockObj = block as Record<string, unknown>;
      if (typeof blockObj["type"] !== "string") {
        return {
          ok: false,
          code: "WAL_RECEIPT_INVALID",
          reason: `MALFORMED_CONTENT_BLOCK: block at index ${i} lacks string type`
        };
      }
      if (blockObj["type"] === "text") {
        if (typeof blockObj["text"] !== "string") {
          return {
            ok: false,
            code: "WAL_RECEIPT_INVALID",
            reason: `MALFORMED_CONTENT_BLOCK: text block at index ${i} requires string text`
          };
        }
      } else if (blockObj["type"] === "image") {
        if (
          typeof blockObj["data"] !== "string" ||
          !blockObj["data"] ||
          typeof blockObj["mimeType"] !== "string" ||
          !blockObj["mimeType"]
        ) {
          return {
            ok: false,
            code: "WAL_RECEIPT_INVALID",
            reason: `MALFORMED_CONTENT_BLOCK: image block at index ${i} requires non-empty data and mimeType strings`
          };
        }
      } else {
        return {
          ok: false,
          code: "WAL_RECEIPT_INVALID",
          reason: `UNSUPPORTED_CONTENT_BLOCK_TYPE: block at index ${i} has an unsupported type`
        };
      }
    }
  }

  return {
    ok: true,
    receipt: obj as SupportedReceipt
  };
}

/**
 * Validates whether a cached receipt from `result_json` satisfies the active delivery policy:
 * 1. Inline delivery: aggregate UTF-8 bytes <= maxInlineBytes AND lines <= maxInlineLines,
 *    and neither spilled nor spillFallbackUsed.
 * 2. Formatted spill notice: exactly one text block delivering a genuine spill notice
 *    (prefixed with '[OUTPUT SPILLED TO DISK:' and containing '--- HEAD ---' / '--- TAIL ---'),
 *    whose UTF-8 bytes do not exceed the provable notice limit (previewBytes * 4 + 1024),
 *    matching finalText, with secondary text blocks omitted.
 * 3. Formatted fallback notice: exactly one text block delivering a genuine inline truncation notice
 *    (prefixed with '[OUTPUT TRUNCATED INLINE (' and containing '--- HEAD ---' / '--- TAIL ---'),
 *    whose UTF-8 bytes do not exceed the provable notice limit, matching finalText.
 */
export function isReceiptDeliveryCompliant(
  cached: any,
  spillStore: PrivateSpillStore
): boolean {
  if (!cached || typeof cached !== "object") return false;

  const maxNoticeBytes = Math.max(spillStore.previewBytes * 4 + 1024, 8192);

  // Must have structured content array to be compliant with modern delivery policy
  if (!Array.isArray(cached.content)) {
    return false;
  }

  const textBlocks = cached.content.filter(
    (b: any) => b && b.type === "text" && typeof b.text === "string"
  );
  const aggregateText = textBlocks.map((b: any) => b.text).join("\n");
  const aggregateBytes = Buffer.byteLength(aggregateText, "utf8");
  const aggregateLines = aggregateText.split("\n").length;

  // Case 1: Unspilled inline text
  if (!cached.spilled && !cached.spillFallbackUsed) {
    if (aggregateBytes <= spillStore.maxInlineBytes && aggregateLines <= spillStore.maxInlineLines) {
      if (typeof cached.finalText === "string" && Buffer.byteLength(cached.finalText, "utf8") <= spillStore.maxInlineBytes) {
        return true;
      }
    }
    return false;
  }

  // Case 2 & 3: Spilled or fallback notice
  if (cached.spilled === true || cached.spillFallbackUsed === true) {
    if (textBlocks.length === 0) return false;
    const primaryNotice = textBlocks[0].text;

    if (typeof cached.finalText !== "string") {
      return false;
    }

    const noticeBytes = Buffer.byteLength(cached.finalText, "utf8");
    if (noticeBytes > maxNoticeBytes || aggregateBytes > maxNoticeBytes || aggregateText !== cached.finalText) {
      return false;
    }

    if (cached.spilled === true) {
      if (
        !cached.finalText.startsWith("[OUTPUT SPILLED TO DISK:") ||
        !cached.finalText.includes("--- HEAD ---") ||
        !cached.finalText.includes("--- TAIL ---")
      ) {
        return false;
      }
    } else {
      if (
        !cached.finalText.startsWith("[OUTPUT TRUNCATED INLINE (") ||
        !cached.finalText.includes("--- HEAD ---") ||
        !cached.finalText.includes("--- TAIL ---")
      ) {
        return false;
      }
    }

    // Secondary text blocks in structured results must be bounded omission notices
    for (let i = 1; i < textBlocks.length; i++) {
      const secBytes = Buffer.byteLength(textBlocks[i].text, "utf8");
      if (secBytes > maxNoticeBytes) return false;
      if (!textBlocks[i].text.startsWith("[TEXT BLOCK ")) return false;
    }

    return true;
  }

  return false;
}

/**
 * Single shared validation and normalization path for cached committed tool results.
 * Used identically by direct cache replay in `executeThroughWalSpine()` and startup reconciliation in `reconcileWalOnStartup()`.
 */
export function ensureNormalizedCommittedResult<T = unknown>(
  params: EnsureNormalizedCommittedResultParams<T>
): EnsureNormalizedCommittedResultOutcome<T> {
  const { receipt, spillStore, sessionId } = params;

  const decodeRes = decodeCommittedReceipt(receipt);
  if (!decodeRes.ok) {
    const diagnosticMessage = `[WAL_RECEIPT_INVALID: ${decodeRes.reason}]`;
    return {
      result: {
        finalText: diagnosticMessage,
        content: [{ type: "text", text: diagnosticMessage }],
        details: { error: decodeRes.reason, code: decodeRes.code } as unknown as T,
        isError: true,
        spilled: false,
        spillFallbackUsed: false
      },
      changed: false,
      invalid: true,
      reason: decodeRes.reason
    };
  }

  const cached = decodeRes.receipt;

  // If already compliant with delivery policy, return unchanged
  if (isReceiptDeliveryCompliant(cached, spillStore)) {
    return {
      result: {
        finalText: cached.finalText ?? "",
        content: cached.content ?? [{ type: "text", text: cached.finalText ?? "" }],
        details: cached.details as T,
        isError: cached.isError,
        spilled: Boolean(cached.spilled),
        spillFallbackUsed: Boolean(cached.spillFallbackUsed)
      },
      changed: false
    };
  }

  // Noncompliant, legacy, or crafted receipt: normalize through canonical routine
  let normalized: NormalizedWalResult<T>;
  try {
    const rawText =
      typeof cached.finalText === "string"
        ? cached.finalText
        : typeof cached.rawText === "string"
          ? cached.rawText
          : undefined;
    const content = Array.isArray(cached.content) ? (cached.content as WalContentBlock[]) : undefined;

    normalized = normalizeWalToolResult<T>({
      sessionId,
      spillStore,
      rawText,
      content,
      details: cached.details as T,
      isError: cached.isError
    });

    if (!isReceiptDeliveryCompliant(normalized, spillStore)) {
      throw new Error("Normalized output failed delivery compliance check");
    }
  } catch {
    const fallbackNotice = [
      `[OUTPUT TRUNCATED INLINE (spill unavailable: NORMALIZATION_FAILED; total 0 bytes, 1 lines)]`,
      `--- HEAD ---`,
      ``,
      `--- TAIL ---`,
      ``
    ].join("\n");
    normalized = {
      finalText: fallbackNotice,
      content: [{ type: "text", text: fallbackNotice }],
      details: cached?.details as T,
      isError: true,
      spilled: false,
      spillFallbackUsed: true
    };
  }

  return {
    result: normalized,
    changed: true
  };
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

      let { result, changed, invalid } = ensureNormalizedCommittedResult<T>({
        receipt: existing.result_json,
        spillStore,
        sessionId: existing.session_id
      });

      if (invalid && existing.raw_receipt_json) {
        const rawDecode = decodeCommittedReceipt(existing.raw_receipt_json);
        if (rawDecode.ok) {
          const rawReceipt = rawDecode.receipt;
          const normalized = normalizeWalToolResult<T>({
            sessionId: existing.session_id,
            spillStore,
            rawText: typeof rawReceipt.finalText === "string" ? rawReceipt.finalText : rawReceipt.rawText,
            content: Array.isArray(rawReceipt.content) ? rawReceipt.content : undefined,
            details: rawReceipt.details as T,
            isError: rawReceipt.isError
          });
          const updatedResultJson = JSON.stringify({
            ...normalized,
            normalizedVersion: 2
          });
          stateDb.db
            .prepare(
              `UPDATE wal_intents
               SET result_json = ?, updated_at_ms = ?
               WHERE idempotency_key = ?`
            )
            .run(updatedResultJson, Date.now(), idempotencyKey);
          result = normalized;
          changed = false;
        }
      } else if (changed) {
        const updatedResultJson = JSON.stringify({
          ...result,
          normalizedVersion: 2
        });
        stateDb.db
          .prepare(
            `UPDATE wal_intents
             SET result_json = ?, updated_at_ms = ?
             WHERE idempotency_key = ?`
          )
          .run(updatedResultJson, Date.now(), idempotencyKey);
      }

      return {
        idempotencyKey,
        fromCache: true,
        finalText: result.finalText,
        content: result.content,
        details: result.details,
        isError: result.isError,
        spilled: result.spilled,
        spillFallbackUsed: result.spillFallbackUsed
      };
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

  let rawEffectOut: {
    rawText?: string;
    content?: WalContentBlock[];
    details?: T;
    isError?: boolean;
  };
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

  const spineTextBlocks = Array.isArray(rawEffectOut.content)
    ? rawEffectOut.content.filter((c): c is TextContent => c.type === "text" && typeof (c as any).text === "string")
    : [];
  const spineContentJoined = spineTextBlocks.map((c) => c.text).join("\n");
  const spineCallerRaw = typeof rawEffectOut.rawText === "string" ? rawEffectOut.rawText : undefined;

  let rawText: string;
  if (spineTextBlocks.length > 0) {
    if (spineCallerRaw !== undefined && Buffer.byteLength(spineCallerRaw, "utf8") > Buffer.byteLength(spineContentJoined, "utf8")) {
      rawText = spineCallerRaw;
    } else {
      rawText = spineContentJoined;
    }
  } else {
    rawText = spineCallerRaw ?? "";
  }

  let scrubbedContent: WalContentBlock[] | undefined = undefined;
  if (Array.isArray(rawEffectOut.content)) {
    scrubbedContent = rawEffectOut.content.map((block) => {
      if (block.type === "text" && typeof (block as any).text === "string") {
        return {
          ...block,
          text: scrubSecretsInfallible((block as any).text)
        };
      }
      return block;
    });
  }

  // Immediately persist EFFECT_COMMITTED_RAW before optional spill I/O
  const safeRawReceipt = JSON.stringify({
    rawText: scrubSecretsInfallible(rawText),
    content: scrubbedContent,
    details: rawEffectOut.details,
    isError: rawEffectOut.isError
  });
  stateDb.db
    .prepare(
      `UPDATE wal_intents
       SET status = 'EFFECT_COMMITTED_RAW', raw_receipt_json = ?, updated_at_ms = ?
       WHERE idempotency_key = ?`
    )
    .run(safeRawReceipt, Date.now(), idempotencyKey);

  const normalized = normalizeWalToolResult<T>({
    sessionId,
    spillStore,
    rawText,
    content: scrubbedContent,
    details: rawEffectOut.details,
    isError: rawEffectOut.isError
  });

  // Both top-level AND nested QuickJS sub-calls stay EFFECT_COMMITTED until root JSONL append!
  stateDb.db
    .prepare(
      `UPDATE wal_intents
       SET status = 'EFFECT_COMMITTED', result_json = ?, updated_at_ms = ?
       WHERE idempotency_key = ?`
    )
    .run(JSON.stringify(normalized), Date.now(), idempotencyKey);

  return {
    idempotencyKey,
    fromCache: false,
    ...normalized
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
  corruptReceipts: WalIntentRow[];
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
    outcomeUnknown: [],
    corruptReceipts: []
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

      // Promotion preserves an error result so the effect is never re-run, but
      // that result must not make malformed raw evidence look like a healthy
      // replay on this or later startups.
      let invalidRawDiagnostic = false;
      try {
        const result = JSON.parse(committedRow.result_json ?? "null");
        invalidRawDiagnostic = result?.isError === true &&
          typeof result.finalText === "string" &&
          result.finalText.startsWith("[WAL_RECEIPT_INVALID: raw_receipt_json ") &&
          (!committedRow.raw_receipt_json || !decodeCommittedReceipt(committedRow.raw_receipt_json).ok);
      } catch {
        // The normal committed-result validation below classifies malformed JSON.
      }
      if (invalidRawDiagnostic) {
        summary.corruptReceipts.push(committedRow);
        console.warn(`[WAL_RECOVERY_DIAGNOSTIC] Invalid raw WAL receipt in idempotency_key ${committedRow.idempotency_key}`);
        continue;
      }

      let receiptIsInvalid = false;
      if (committedRow.status === "EFFECT_COMMITTED") {
        try {
          const outcome = ensureNormalizedCommittedResult({
            receipt: committedRow.result_json,
            spillStore,
            sessionId: committedRow.session_id
          });
          const { result, changed, invalid } = outcome;
          if (invalid) {
            let recoveredFromRaw = false;
            if (committedRow.raw_receipt_json) {
              const rawDecode = decodeCommittedReceipt(committedRow.raw_receipt_json);
              if (rawDecode.ok) {
                const rawReceipt = rawDecode.receipt;
                const normalized = normalizeWalToolResult({
                  sessionId: committedRow.session_id,
                  spillStore,
                  rawText: typeof rawReceipt.finalText === "string" ? rawReceipt.finalText : rawReceipt.rawText,
                  content: Array.isArray(rawReceipt.content) ? rawReceipt.content : undefined,
                  details: rawReceipt.details,
                  isError: rawReceipt.isError
                });
                const updatedJson = JSON.stringify({
                  ...normalized,
                  normalizedVersion: 2
                });
                stateDb.db
                  .prepare(`UPDATE wal_intents SET result_json = ?, updated_at_ms = ? WHERE idempotency_key = ?`)
                  .run(updatedJson, now, committedRow.idempotency_key);
                committedRow = stateDb.getWalRow(committedRow.idempotency_key)!;
                recoveredFromRaw = true;
              }
            }

            if (!recoveredFromRaw) {
              receiptIsInvalid = true;
              summary.corruptReceipts.push(committedRow);
              console.warn(
                `[WAL_RECOVERY_DIAGNOSTIC] Invalid committed WAL receipt in idempotency_key ${committedRow.idempotency_key}: ${outcome.reason}`
              );
            }
          } else if (changed) {
            const updatedJson = JSON.stringify({
              ...result,
              normalizedVersion: 2
            });
            stateDb.db
              .prepare(`UPDATE wal_intents SET result_json = ?, updated_at_ms = ? WHERE idempotency_key = ?`)
              .run(updatedJson, now, committedRow.idempotency_key);
            committedRow = stateDb.getWalRow(committedRow.idempotency_key)!;
          }
        } catch {
          receiptIsInvalid = true;
          summary.corruptReceipts.push(committedRow);
          console.warn(
            `[WAL_RECOVERY_DIAGNOSTIC] Error normalizing committed WAL receipt in idempotency_key ${committedRow.idempotency_key}`
          );
        }
      }

      if (receiptIsInvalid) {
        // Do NOT silently present this receipt as healthy replayedCommitted!
        continue;
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
