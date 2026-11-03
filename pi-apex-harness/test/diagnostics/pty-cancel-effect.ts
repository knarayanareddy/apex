/** Diagnostic only: can a stopped synthetic PTY write a marker afterward? */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadVerifiedGuardrails } from "../../src/core/guardrail-pin.ts";
import { PtyLeaseManager } from "../../src/ring2/pty-cron-routines.ts";

const ws = fs.mkdtempSync(path.join(os.tmpdir(), "apex-pty-cancel-effect-"));
const guardrails = loadVerifiedGuardrails().config;
let passed = false;
try {
  for (let i = 0; i < 30; i++) {
    const marker = path.join(ws, `marker-${i}`);
    const manager = new PtyLeaseManager({ workspaceRoot: ws, guardrails, sandboxMode: "workspace-write" });
    const lease = manager.start({ command: `sleep 2; printf synthetic > '${marker}'`, leaseMs: 10_000 });
    const session = (manager as any).sessions.get(lease.id);
    const sync = session.proc.stdio[3];
    let ended = false;
    sync.on("end", () => { ended = true; });
    const stop = manager.stop(lease.id);
    if (fs.existsSync(marker)) throw new Error("marker existed before stop returned");
    const deadline = Date.now() + 4500;
    while (!ended && !sync.destroyed && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
    const wrote = fs.existsSync(marker);
    const snapshot = manager.poll(lease.id);
    console.log("PTY_CANCEL_EFFECT", JSON.stringify({ iteration: i + 1, stopStatus: stop.status, finalStatus: snapshot.status, cleanupStatus: snapshot.cleanupStatus, syncEnded: ended || sync.destroyed, markerAfterStop: wrote }));
    manager.dispose();
    if (wrote) throw new Error(`PTY_CANCEL_EFFECT_AFTER_STOP: synthetic marker appeared on iteration ${i + 1}`);
    if (!ended && !sync.destroyed) throw new Error(`PTY_CANCEL_LIFETIME_UNVERIFIED: sync descriptor remained open on iteration ${i + 1}`);
  }
  passed = true;
} finally {
  if (passed) fs.rmSync(ws, { recursive: true, force: true });
  else console.error(`Cancel-effect fixture retained at: ${ws}`);
}
