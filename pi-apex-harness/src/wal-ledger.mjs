import { spawn } from "node:child_process";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Node client for the SQLite WAL + FTS5 Sidecar Ledger.
 * (In Node >=22.19 / Bun, this binds directly to in-process `node:sqlite` / `bun:sqlite`.)
 */
export class WalLedger {
  constructor(dbPath) {
    this.dbPath = dbPath;
    this.seq = 0;
    this.pending = new Map();
    this.buf = "";
    this.proc = spawn("python3", [path.join(__dirname, "sqlite-wal-worker.py"), dbPath], {
      stdio: ["pipe", "pipe", "inherit"],
    });
    // Strict LF-only splitting (matching Pi RPC spec — never split on Unicode U+2028/U+2029)
    this.proc.stdout.setEncoding("utf8");
    this.proc.stdout.on("data", (chunk) => {
      this.buf += chunk;
      let idx;
      while ((idx = this.buf.indexOf("\n")) !== -1) {
        const line = this.buf.slice(0, idx);
        this.buf = this.buf.slice(idx + 1);
        if (!line) continue;
        const msg = JSON.parse(line);
        const waiter = this.pending.get(msg.id);
        if (waiter) {
          this.pending.delete(msg.id);
          if (msg.ok) waiter.resolve(msg.data);
          else waiter.reject(new Error(msg.error));
        }
      }
    });
  }

  static computeIdempotencyKey(sessionId, leafEntryId, toolCallId, toolName, args) {
    const canonicalArgs = JSON.stringify(args, Object.keys(args || {}).sort());
    const digest = crypto
      .createHash("sha256")
      .update(`${sessionId}:${leafEntryId}:${toolCallId}:${toolName}:${canonicalArgs}`)
      .digest("hex");
    return { idempotencyKey: digest, canonicalArgs };
  }

  call(op, payload = {}) {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.proc.stdin.write(JSON.stringify({ id, op, ...payload }) + "\n");
    });
  }

  close() {
    this.proc.stdin.end();
    this.proc.kill();
  }
}
