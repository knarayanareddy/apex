/** Test-owned parent: announce its PTY then wait to be killed by its test driver. */
import fs from "node:fs";
import path from "node:path";
import { loadVerifiedGuardrails } from "../../src/core/guardrail-pin.ts";
import { readProcStartTimeTicks } from "../../src/core/workspace-lock.ts";
import { PtyLeaseManager } from "../../src/ring2/pty-cron-routines.ts";

const [mode, ws] = process.argv.slice(2);
if (!ws || !["immediate", "started"].includes(mode)) throw new Error("invalid diagnostic arguments");
const marker = path.join(ws, "effect");
const manager = new PtyLeaseManager({ workspaceRoot: ws, guardrails: loadVerifiedGuardrails().config });
const lease = manager.start({ command: `echo production-ready; sleep 2; printf synthetic > '${marker}'`, leaseMs: 10_000 });
const startTicks = readProcStartTimeTicks(lease.pid);
if (!startTicks) throw new Error("cannot identify owned bubblewrap monitor");
if (mode === "started") {
  const deadline = Date.now() + 5000;
  while (!manager.poll(lease.id).replay.includes("production-ready") && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
  if (!manager.poll(lease.id).replay.includes("production-ready")) throw new Error("production payload not ready");
}
fs.writeSync(1, JSON.stringify({ pid: lease.pid, startTicks, mode }) + "\n");
// In immediate mode the event loop cannot send the supervisor's start byte.
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10_000);
throw new Error("test driver did not terminate the owned parent");
