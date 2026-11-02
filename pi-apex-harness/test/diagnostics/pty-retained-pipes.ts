/** Diagnostic only: compare inherited pipe lifetime with and without bubblewrap. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { loadVerifiedGuardrails } from "../../src/core/guardrail-pin.ts";
import { PtyLeaseManager } from "../../src/ring2/pty-cron-routines.ts";

const ws = fs.mkdtempSync(path.join(os.tmpdir(), "apex-pty-pipe-control-"));
const guardrails = loadVerifiedGuardrails().config;
let passed = false;
try {
  for (const mode of ["danger-full-access", "workspace-write"] as const) {
    const manager = new PtyLeaseManager({ workspaceRoot: ws, guardrails, sandboxMode: mode });
    const lease = manager.start({ command: "sleep 3 & echo synthetic-pipe-control", leaseMs: 10_000 });
    const session = (manager as any).sessions.get(lease.id);
    const proc = session.proc;
    const closed = once(proc, "close");
    await once(proc, "exit");
    const active = (process as any)._getActiveHandles();
    const streams = ["stdin", "stdout", "stderr"].map((name) => {
      const stream = proc[name];
      return { name, active: active.includes(stream), destroyed: stream?.destroyed, fd: stream?._handle?.fd };
    });
    console.log("PTY_PIPE_CONTROL", JSON.stringify({ mode, pid: proc.pid, exitCode: proc.exitCode, signalCode: proc.signalCode, streams }));
    await closed;
    manager.dispose();
  }
  passed = true;
} finally {
  if (passed) fs.rmSync(ws, { recursive: true, force: true });
  else console.error(`Pipe-control fixture retained at: ${ws}`);
}
