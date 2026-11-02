/** Diagnostic only: compare bubblewrap monitor exit with sandbox --sync-fd EOF. */
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Duplex } from "node:stream";
import { buildMinimalBwrapArgv } from "../../src/core/bwrap-sandbox.ts";

const ws = fs.mkdtempSync(path.join(os.tmpdir(), "apex-bwrap-sync-control-"));
let passed = false;
try {
  for (const mode of ["natural", "immediate-cancel", "ready-cancel"] as const) {
    const command = mode === "natural" ? "sleep 2 & echo ready" : "echo ready; sleep 2";
    const args = buildMinimalBwrapArgv(command, ws, { workspaceRoot: ws, mode: "workspace-write" });
    args.splice(args.lastIndexOf("--"), 0, "--sync-fd", "3");
    const start = Date.now();
    const child = spawn("bwrap", args, { cwd: ws, env: {}, stdio: ["ignore", "pipe", "pipe", "pipe"] });
    const sync = child.stdio[3]!;
    if (!(sync instanceof Duplex)) throw new Error("sync pipe is not duplex");
    const times: Record<string, number> = {};
    const exit = once(child, "exit").then(() => { times.monitorExitMs = Date.now() - start; });
    const eof = once(sync, "end").then(() => { times.syncEofMs = Date.now() - start; });
    const close = once(child, "close").then(() => { times.closeMs = Date.now() - start; });
    sync.resume();
    let stdout = "";
    let stderr = "";
    child.stdout!.on("data", (data: Buffer) => { stdout += data.toString(); });
    child.stderr!.on("data", (data: Buffer) => { stderr += data.toString(); });
    if (mode === "ready-cancel") {
      const deadline = Date.now() + 5000;
      while (!stdout.includes("ready") && child.exitCode === null && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
      if (!stdout.includes("ready")) throw new Error(`ready marker absent: ${stderr}`);
    }
    if (mode !== "natural") child.kill("SIGTERM"); // Only the child spawned above.
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        Promise.all([exit, eof, close]),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`SYNC_PROBE_TIMEOUT ${JSON.stringify({ mode, times, stderr })}`)), 8000); })
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
    console.log("BWRAP_SYNC_CONTROL", JSON.stringify({ mode, pid: child.pid, ...times, exitCode: child.exitCode, signalCode: child.signalCode }));
  }
  passed = true;
} finally {
  if (passed) fs.rmSync(ws, { recursive: true, force: true });
  else console.error(`Sync-control fixture retained at: ${ws}`);
}
