import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { canonicalizeArgs, computeFileContentSha256 } from "../core/wal-recovery.ts";

export interface LoopGuardEvent {
  kind: "STRIKE_WARNING" | "CALL_BLOCKED" | "PING_PONG_BLOCKED";
  toolName: string;
  signatureKey: string;
  strikeCount: number;
  detail: string;
  timestampMs: number;
}

export interface LoopGuardOptions {
  /** Number of consecutive identical outcomes before blocking the next identical call. Default `2` (blocks on 3rd attempt = 3-strike guard!). */
  maxIdenticalOutcomesBeforeBlock?: number;
}

function sha256Short(input: string): string {
  return crypto.createHash("sha256").update(input, "utf8").digest("hex").slice(0, 16);
}

function normalizeResultFingerprint(text: string, isError: boolean): string {
  // Strip volatile timestamps / PIDs so identical errors fingerprint deterministically
  const cleaned = text
    .replace(/\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z\b/g, "<TS>")
    .replace(/\bpid[=:\s]+\d+\b/gi, "pid=<PID>")
    .trim();
  return `${isError ? "ERR" : "OK"}:${sha256Short(cleaned)}`;
}

export class ThreeStrikeLoopGuard {
  private readonly workspaceRoot: string;
  private readonly thresholdBeforeBlock: number;

  /** Map `signatureKey -> { lastOutcomeFp, consecutiveCount, lastIsError }` */
  private readonly callStreaks = new Map<
    string,
    { lastOutcomeFp: string; consecutiveCount: number; lastIsError: boolean }
  >();

  /** Map `toolCallId -> { signatureKey, toolName, relPath, preHash }` for in-flight calls */
  private readonly inFlight = new Map<
    string,
    { signatureKey: string; toolName: string; relPath: string | null; preHash: string | null }
  >();

  /** Map `relPath -> recent content SHA-256 history` (detects `A -> B -> A -> B` edit ping-pong) */
  private readonly fileHashHistory = new Map<string, string[]>();
  private readonly pingPongBlockedPaths = new Set<string>();

  readonly events: LoopGuardEvent[] = [];

  constructor(workspaceRoot: string, options?: LoopGuardOptions) {
    this.workspaceRoot = fs.realpathSync(workspaceRoot);
    // Default: after 2 identical consecutive outcomes (Strikes 1 & 2), the 3rd identical call (Strike 3) is BLOCKED!
    this.thresholdBeforeBlock = options?.maxIdenticalOutcomesBeforeBlock ?? 2;
  }

  private computeSignatureKey(toolName: string, input: unknown): string {
    return `${toolName}:${sha256Short(canonicalizeArgs(input))}`;
  }

  private resolveRelPathIfFileOp(toolName: string, input: unknown): string | null {
    if (toolName !== "read" && toolName !== "write" && toolName !== "edit") return null;
    const raw = (input as { path?: unknown } | null)?.path;
    if (typeof raw !== "string" || !raw.trim()) return null;
    const abs = path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(this.workspaceRoot, raw);
    if (abs !== this.workspaceRoot && !abs.startsWith(`${this.workspaceRoot}${path.sep}`)) return null;
    return path.relative(this.workspaceRoot, abs).replace(/\\/g, "/");
  }

  private safeReadHash(relPath: string): string {
    const abs = path.join(this.workspaceRoot, relPath);
    try {
      if (!fs.existsSync(abs) || !fs.lstatSync(abs).isFile()) return "MISSING";
      return computeFileContentSha256(abs);
    } catch {
      return "UNREADABLE";
    }
  }

  /**
   *Evaluated inside `pi.on("tool_call")`: blocks Strike-3 identical failing/stagnant calls
   * or `A -> B -> A -> B` edit ping-pong before execution!
   */
  evaluateBeforeToolCall(params: {
    toolCallId: string;
    toolName: string;
    input: unknown;
  }): { blocked: boolean; reason?: string } {
    const sigKey = this.computeSignatureKey(params.toolName, params.input);
    const relPath = this.resolveRelPathIfFileOp(params.toolName, params.input);

    // 1. Check `A -> B -> A -> B` edit ping-pong on same file first
    if (relPath && (params.toolName === "write" || params.toolName === "edit")) {
      if (this.pingPongBlockedPaths.has(relPath)) {
        this.pingPongBlockedPaths.delete(relPath);
        const reason =
          `[LOOP_GUARD_PING_PONG]: Detected A -> B -> A state oscillation on '${relPath}'. ` +
          `Pause blind edits on '${relPath}', read diagnostics/tests carefully, and apply a non-oscillating fix.`;
        this.events.push({
          kind: "PING_PONG_BLOCKED",
          toolName: params.toolName,
          signatureKey: sigKey,
          strikeCount: 3,
          detail: reason,
          timestampMs: Date.now()
        });
        return { blocked: true, reason };
      }
    }

    // 2. Check 3-strike consecutive identical call streak (across turns OR duplicate parallel spam within a single turn!)
    const streak = this.callStreaks.get(sigKey);
    let inFlightSameSig = 0;
    for (const f of this.inFlight.values()) {
      if (f.signatureKey === sigKey) inFlightSameSig += 1;
    }
    const effectiveCount = (streak?.consecutiveCount ?? 0) + inFlightSameSig;
    if (effectiveCount >= this.thresholdBeforeBlock) {
      const strikeNum = effectiveCount + 1;
      const reason =
        `[LOOP_GUARD_TRIPPED (strike ${strikeNum})]: '${params.toolName}' was already invoked ${effectiveCount} ` +
        `times with identical arguments${streak ? ` and produced the exact same ${streak.lastIsError ? "error" : "unchanged output"}` : " concurrently"}. ` +
        `Change your hypothesis, inspect surrounding context (e.g. repo_map / lsp_query / different path), or modify inputs before retrying.`;
      this.events.push({
        kind: "CALL_BLOCKED",
        toolName: params.toolName,
        signatureKey: sigKey,
        strikeCount: strikeNum,
        detail: reason,
        timestampMs: Date.now()
      });
      return { blocked: true, reason };
    }

    const preHash = relPath ? this.safeReadHash(relPath) : null;
    this.inFlight.set(params.toolCallId, {
      signatureKey: sigKey,
      toolName: params.toolName,
      relPath,
      preHash
    });
    return { blocked: false };
  }

  /**
   * Evaluated inside `pi.on("tool_result")`: records outcome fingerprint, detects ping-pong,
   * resets `bash` streaks when a real workspace edit lands, and emits Strike-2 tail warning (`Invariant I-02`).
   */
  recordToolResult(params: {
    toolCallId: string;
    resultText: string;
    isError: boolean;
  }): { warningTailBlock: string } {
    const flight = this.inFlight.get(params.toolCallId);
    this.inFlight.delete(params.toolCallId);
    if (!flight) return { warningTailBlock: "" };

    const outcomeFp = normalizeResultFingerprint(params.resultText, params.isError);
    const prev = this.callStreaks.get(flight.signatureKey);

    let nextCount = 1;
    if (prev && prev.lastOutcomeFp === outcomeFp) {
      nextCount = prev.consecutiveCount + 1;
    }
    this.callStreaks.set(flight.signatureKey, {
      lastOutcomeFp: outcomeFp,
      consecutiveCount: nextCount,
      lastIsError: params.isError
    });

    // If a `write` or `edit` genuinely changed a workspace file's hash, clear `bash:*` streaks
    // so re-running a test command (`npm test`) after an actual code change is allowed cleanly!
    if (
      !params.isError &&
      flight.relPath &&
      (flight.toolName === "write" || flight.toolName === "edit")
    ) {
      const postHash = this.safeReadHash(flight.relPath);
      if (postHash !== flight.preHash) {
        for (const k of Array.from(this.callStreaks.keys())) {
          if (k !== flight.signatureKey) {
            this.callStreaks.delete(k);
          }
        }

        // Update per-file SHA-256 history to detect `A -> B -> A` oscillation
        const hist = this.fileHashHistory.get(flight.relPath) ?? (flight.preHash ? [flight.preHash] : []);
        hist.push(postHash);
        if (hist.length > 6) hist.shift();
        this.fileHashHistory.set(flight.relPath, hist);

        const len = hist.length;
        if (
          len >= 4 &&
          hist[len - 1] === hist[len - 3] &&
          hist[len - 2] === hist[len - 4] &&
          hist[len - 1] !== hist[len - 2]
        ) {
          this.pingPongBlockedPaths.add(flight.relPath);
        }
      }
    }

    if (nextCount === this.thresholdBeforeBlock) {
      const warn =
        `\n\n<loop-guard-warning strike="${nextCount}" tool="${flight.toolName}">` +
        `Identical call + ${params.isError ? "error" : "unchanged output"} observed ${nextCount} times consecutively. ` +
        `Repeating the exact same call one more time will be blocked (Strike ${nextCount + 1}).` +
        `</loop-guard-warning>`;
      this.events.push({
        kind: "STRIKE_WARNING",
        toolName: flight.toolName,
        signatureKey: flight.signatureKey,
        strikeCount: nextCount,
        detail: warn,
        timestampMs: Date.now()
      });
      return { warningTailBlock: warn };
    }

    return { warningTailBlock: "" };
  }
}
