import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildMinimalBwrapArgv, SandboxUnavailableError } from "../../src/core/bwrap-sandbox.ts";

const ws = fs.mkdtempSync(path.join(os.tmpdir(), "apex-control-plane-mask-"));
const harness = path.join(fs.realpathSync(ws), ".harness");
fs.mkdirSync(harness);
fs.writeFileSync(path.join(harness, "cockpit-pairing.json"), "synthetic-bearer");
for (const mode of ["read-only", "workspace-write"] as const) {
  const argv = buildMinimalBwrapArgv("true", ws, { workspaceRoot: ws, mode });
  assert.ok(argv.some((arg, i) => arg === "--tmpfs" && argv[i + 1] === harness), `${mode}: control plane must be masked`);
  assert.ok(!argv.some((arg, i) => arg === "--ro-bind" && argv[i + 1] === harness), `${mode}: control plane must not be exposed`);
}
const symlinkWs = fs.mkdtempSync(path.join(os.tmpdir(), "apex-control-plane-link-"));
fs.symlinkSync(harness, path.join(symlinkWs, ".harness"));
assert.throws(() => buildMinimalBwrapArgv("true", symlinkWs, { workspaceRoot: symlinkWs }), SandboxUnavailableError);
console.log("control-plane shell mask arguments: PASS");
