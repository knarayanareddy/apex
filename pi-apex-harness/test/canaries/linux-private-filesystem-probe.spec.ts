/** Diagnostic only: confirm kernel cross-device hardlink behavior on this runner. */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

assert.equal(process.platform, "linux", "This probe requires a Linux runner");
const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "apex-device-workspace-"));
const privateRoot = fs.mkdtempSync("/dev/shm/apex-device-private-");
let passed = false;
try {
  fs.chmodSync(privateRoot, 0o700);
  const source = path.join(privateRoot, "synthetic-private-state");
  const privateAlias = path.join(privateRoot, "same-device-control");
  const workspaceAlias = path.join(workspace, "workspace-alias");
  fs.writeFileSync(source, "synthetic-private-marker", { flag: "wx", mode: 0o600 });
  assert.notEqual(fs.statSync(workspace).dev, fs.statSync(privateRoot).dev, "The test requires genuinely different devices");
  fs.linkSync(source, privateAlias);
  assert.equal(fs.readFileSync(privateAlias, "utf8"), "synthetic-private-marker", "Same-device hardlinks must work as a positive control");
  assert.throws(() => fs.linkSync(source, workspaceAlias), (error: unknown) => (error as NodeJS.ErrnoException).code === "EXDEV", "Cross-device hardlinks must fail with EXDEV");
  assert.equal(fs.existsSync(workspaceAlias), false);
  console.log("CROSS_DEVICE_HARDLINK_DIAGNOSTIC: same-device link allowed; cross-device link rejected with EXDEV; storage is ephemeral");
  passed = true;
} finally {
  // Keep failed fixtures as evidence; successful fixtures are test-owned.
  if (passed) {
    fs.rmSync(privateRoot, { recursive: true, force: true });
    fs.rmSync(workspace, { recursive: true, force: true });
  }
}
