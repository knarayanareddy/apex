import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const SECRET_PATTERNS: Array<[RegExp, string]> = [
  [/sk-ant-[A-Za-z0-9_-]{12,}/g, "[REDACTED:ANTHROPIC_KEY]"],
  [/sk-(?:proj-|live-)?[A-Za-z0-9_-]{16,}/g, "[REDACTED:OPENAI_KEY]"],
  [/gh[pousr]_[A-Za-z0-9]{20,}/g, "[REDACTED:GITHUB_TOKEN]"],
  [/github_pat_[A-Za-z0-9_]{20,}/g, "[REDACTED:GITHUB_PAT]"],
  [/xox[baprs]-[A-Za-z0-9-]{16,}/g, "[REDACTED:SLACK_TOKEN]"],
  [/AKIA[0-9A-Z]{16}/g, "[REDACTED:AWS_ACCESS_KEY]"],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "[REDACTED:PEM_KEY]"],
  [/Bearer\s+[A-Za-z0-9._~+/=-]{20,}/gi, "Bearer [REDACTED:TOKEN]"]
];

/**
 * Infallible secret scrubber: never throws even on malformed inputs or regex failures.
 */
export function scrubSecretsInfallible(input: string): string {
  try {
    let out = String(input);
    for (const [re, replacement] of SECRET_PATTERNS) {
      out = out.replace(re, replacement);
    }
    return out;
  } catch {
    return "[REDACTED_FALLBACK:SCRUBBER_ERROR]";
  }
}

export interface SpillOptions {
  rootDir: string;
  maxInlineBytes?: number;
  maxInlineLines?: number;
  previewBytes?: number;
  cleanupDays?: number;
  /** Fault-injection hook for testing post-effect spill failures (e.g. ENOSPC). */
  simulateWriteFailure?: boolean;
}

export interface SpillOutcome {
  text: string;
  spilled: boolean;
  spillPath: string | null;
  spillFallbackUsed: boolean;
}

export class PrivateSpillStore {
  readonly rootDir: string;
  readonly maxInlineBytes: number;
  readonly maxInlineLines: number;
  readonly previewBytes: number;
  readonly cleanupDays: number;
  simulateWriteFailure: boolean;

  constructor(opts: SpillOptions) {
    this.rootDir = opts.rootDir;
    this.maxInlineBytes = opts.maxInlineBytes ?? 32_768;
    this.maxInlineLines = opts.maxInlineLines ?? 800;
    this.previewBytes = opts.previewBytes ?? 2_048;
    this.cleanupDays = opts.cleanupDays ?? 30;
    this.simulateWriteFailure = opts.simulateWriteFailure ?? false;

    fs.mkdirSync(this.rootDir, { recursive: true, mode: 0o700 });
    fs.chmodSync(this.rootDir, 0o700);
  }

  /**
   * Scrubs secrets and optionally spills oversized output to a `0600` O_EXCL file.
   * NEVER throws: if disk spill fails (e.g. ENOSPC), degrades deterministically to inline head/tail truncation
   * so an already-committed tool effect is never misclassified as aborted.
   */
  scrubAndMaybeSpill(sessionId: string, rawText: string): SpillOutcome {
    const scrubbed = scrubSecretsInfallible(rawText);
    const byteLen = Buffer.byteLength(scrubbed, "utf8");
    const lineCount = scrubbed.split("\n").length;

    if (byteLen <= this.maxInlineBytes && lineCount <= this.maxInlineLines) {
      return { text: scrubbed, spilled: false, spillPath: null, spillFallbackUsed: false };
    }

    const half = Math.max(256, Math.floor(this.previewBytes / 2));
    const head = scrubbed.slice(0, half);
    const tail = scrubbed.slice(-half);

    try {
      if (this.simulateWriteFailure) {
        const err = new Error("ENOSPC: no space left on device") as NodeJS.ErrnoException;
        err.code = "ENOSPC";
        throw err;
      }

      const sessionHash = crypto.createHash("sha256").update(sessionId).digest("hex").slice(0, 12);
      const sessionDir = path.join(this.rootDir, `session-${sessionHash}`);
      fs.mkdirSync(sessionDir, { recursive: true, mode: 0o700 });

      const rand = crypto.randomBytes(12).toString("hex");
      const spillFile = path.join(sessionDir, `spill-${Date.now()}-${rand}.txt`);
      const fd = fs.openSync(spillFile, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, 0o600);
      try {
        fs.writeFileSync(fd, scrubbed, "utf8");
      } finally {
        fs.closeSync(fd);
      }

      const notice = [
        `[OUTPUT SPILLED TO DISK: ${byteLen} bytes, ${lineCount} lines -> ${spillFile}]`,
        `[Use read({ path: "${spillFile}", offset: 1, limit: 200 }) to inspect sections]`,
        `--- HEAD ---`,
        head,
        `--- TAIL ---`,
        tail
      ].join("\n");
      return { text: notice, spilled: true, spillPath: spillFile, spillFallbackUsed: false };
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code ?? "SPILL_ERROR";
      const fallback = [
        `[OUTPUT TRUNCATED INLINE (spill unavailable: ${code}; total ${byteLen} bytes, ${lineCount} lines)]`,
        `--- HEAD ---`,
        head,
        `--- TAIL ---`,
        tail
      ].join("\n");
      return { text: fallback, spilled: false, spillPath: null, spillFallbackUsed: true };
    }
  }

  sweepExpiredSync(nowMs: number = Date.now()): number {
    if (this.cleanupDays <= 0 || !fs.existsSync(this.rootDir)) return 0;
    const cutoffMs = nowMs - this.cleanupDays * 86_400_000;
    let deleted = 0;
    for (const dirEntry of fs.readdirSync(this.rootDir, { withFileTypes: true })) {
      if (!dirEntry.isDirectory() || dirEntry.isSymbolicLink()) continue;
      const subDir = path.join(this.rootDir, dirEntry.name);
      for (const fileEntry of fs.readdirSync(subDir, { withFileTypes: true })) {
        if (!fileEntry.isFile() || fileEntry.isSymbolicLink()) continue;
        const fp = path.join(subDir, fileEntry.name);
        const st = fs.lstatSync(fp);
        if (st.mtimeMs < cutoffMs) {
          fs.unlinkSync(fp);
          deleted++;
        }
      }
    }
    return deleted;
  }
}
