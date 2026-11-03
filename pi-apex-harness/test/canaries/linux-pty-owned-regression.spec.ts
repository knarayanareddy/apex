/** Linux-only public PTY regression: cancellation must reclaim the whole namespace. */
import assert from "node:assert/strict";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadVerifiedGuardrails } from "../../src/core/guardrail-pin.ts";
import { probeBwrapFunctional } from "../../src/core/bwrap-sandbox.ts";
import { PtyLeaseManager } from "../../src/ring2/pty-cron-routines.ts";

if (process.platform !== "linux") {
  console.log("Linux PTY ownership regression: SKIPPED (non-Linux)");
  process.exit(0);
}
assert.ok(probeBwrapFunctional().ok, "Linux PTY regression requires functional bubblewrap");
const ws = fs.mkdtempSync(path.join(os.tmpdir(), "apex-pty-owned-regression-"));
const guardrails = loadVerifiedGuardrails().config;
let passed = false;
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
try {
  for (const mode of ["immediate", "started"] as const) {
    for (let i = 0; i < 8; i++) {
      const marker = path.join(ws, `${mode}-${i}`);
      const manager = new PtyLeaseManager({ workspaceRoot: ws, guardrails });
      const lease = manager.start({ command: `echo ptystarted; sleep 2; printf synthetic > '${marker}'`, leaseMs: 10_000 });
      const session = (manager as any).sessions.get(lease.id);
      const closed = once(session.proc, "close");
      if (mode === "started") {
        const deadline = Date.now() + 5000;
        while (!manager.poll(lease.id).replay.includes("ptystarted") && Date.now() < deadline) await delay(20);
        assert.ok(manager.poll(lease.id).replay.includes("ptystarted"), "positive control: payload must actually start");
      }
      manager.stop(lease.id);
      let timer: NodeJS.Timeout | undefined;
      try {
        await Promise.race([closed, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`PTY_CLOSE_TIMEOUT: ${mode} ${i}`)), 5000); })]);
      } finally { if (timer) clearTimeout(timer); }
      assert.equal(fs.existsSync(marker), false, `stopped PTY produced a later effect: ${mode} ${i}`);
      const poll = manager.poll(lease.id);
      assert.equal(poll.status, "exited", `cleanup was not verified: ${mode} ${i}`);
      assert.equal(poll.cleanupStatus, "snapshot_cleared");
      manager.dispose();
      console.log("PTY_OWNED_REGRESSION", JSON.stringify({ mode, iteration: i + 1, marker: false, status: poll.status }));
    }
  }
  // The untrusted payload must not inherit or reopen the supervisor control fd.
  {
    const manager = new PtyLeaseManager({ workspaceRoot: ws, guardrails });
    const script = [
      "import os",
      "try:",
      " os.fstat(3); print('PAYLOAD_CONTROL_EXPOSED')",
      "except OSError:",
      " print('PAYLOAD_CONTROL_CLOSED')",
      "try:",
      " fd=os.open('/proc/1/fd/3',os.O_RDONLY); os.close(fd); print('SUPERVISOR_CONTROL_EXPOSED')",
      "except OSError:",
      " print('SUPERVISOR_CONTROL_DENIED')"
    ].join("\n");
    const lease = manager.start({ command: `python3 -c ${quote(script)}`, leaseMs: 10_000 });
    const session = (manager as any).sessions.get(lease.id);
    const closed = once(session.proc, "close");
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([closed, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("PTY_CONTROL_ISOLATION_TIMEOUT")), 5000); })]);
    } finally { if (timer) clearTimeout(timer); }
    const poll = manager.poll(lease.id);
    assert.equal(poll.exitCode, 0);
    assert.ok(poll.replay.includes("PAYLOAD_CONTROL_CLOSED"));
    assert.ok(poll.replay.includes("SUPERVISOR_CONTROL_DENIED"));
    assert.ok(!poll.replay.includes("CONTROL_EXPOSED"));
    manager.dispose();
    console.log("PTY_SUPERVISOR_CONTROL_ISOLATION: PASS");
  }
  passed = true;
  console.log("Linux PTY production-path cancellation regression: PASS");
} finally {
  if (passed) fs.rmSync(ws, { recursive: true, force: true });
  else console.error(`PTY production-path regression fixture retained at: ${ws}`);
}
