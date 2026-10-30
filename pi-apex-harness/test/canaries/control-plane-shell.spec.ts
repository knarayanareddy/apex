import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildMinimalBwrapArgv, SandboxUnavailableError } from "../../src/core/bwrap-sandbox.ts";
import { readWorkspaceFileSafe, PathContainmentError, MAX_CONTROL_PLANE_SCAN_ENTRIES } from "../../src/core/safe-path.ts";

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
const privateSpill = path.join(harness, "spill", "session-foreign", "private");
fs.mkdirSync(path.dirname(privateSpill), { recursive: true });
fs.writeFileSync(privateSpill, "synthetic-foreign-spill");
const alias = path.join(ws, "innocent.txt");
fs.linkSync(privateSpill, alias);
assert.throws(() => readWorkspaceFileSafe({ workspaceRoot: ws, candidatePath: alias, sessionId: "other" }), PathContainmentError, "A workspace alias must not bypass spill authorization");
assert.throws(() => buildMinimalBwrapArgv("true", ws, { workspaceRoot: ws }), SandboxUnavailableError, "Shell must fail closed when private control-plane files have hardlinks");
const originalOpenDir = fs.opendirSync;
const originalLstat = fs.lstatSync;
try {
  (fs as any).opendirSync = (...args: any[]) => {
    if (args[0] === path.join(harness, "spill")) throw Object.assign(new Error("injected EACCES"), { code: "EACCES" });
    return (originalOpenDir as any)(...args);
  };
  assert.throws(() => readWorkspaceFileSafe({ workspaceRoot: ws, candidatePath: alias, sessionId: "other" }), /incomplete secret inventory/, "Incomplete control-plane scan must deny multi-link reads");
  assert.throws(() => buildMinimalBwrapArgv("true", ws, { workspaceRoot: ws }), /Control-plane directory read error/, "Incomplete control-plane scan must deny shell");
} finally {
  (fs as any).opendirSync = originalOpenDir;
}
try {
  let readCount = 0;
  let closed = false;
  const fakeEntry = { name: "synthetic", isDirectory: () => false, isFile: () => true };
  (fs as any).opendirSync = (...args: any[]) => {
    if (args[0] === path.join(harness, "spill")) return { readSync: () => { readCount++; return fakeEntry; }, closeSync: () => { closed = true; } };
    return (originalOpenDir as any)(...args);
  };
  (fs as any).lstatSync = (...args: any[]) => {
    if (args[0] === path.join(harness, "spill", "synthetic")) return { isFile: () => true, nlink: 1 };
    return (originalLstat as any)(...args);
  };
  assert.throws(() => buildMinimalBwrapArgv("true", ws, { workspaceRoot: ws }), /Control-plane entry limit/, "Oversized control-plane scans must fail closed");
  assert.ok(readCount >= MAX_CONTROL_PLANE_SCAN_ENTRIES - 2 && readCount <= MAX_CONTROL_PLANE_SCAN_ENTRIES + 1, "The stream must stop at the global entry budget");
  assert.equal(closed, true, "The directory stream must be closed on budget exhaustion");
} finally {
  (fs as any).opendirSync = originalOpenDir;
  (fs as any).lstatSync = originalLstat;
}
const nestedLinkWs = fs.mkdtempSync(path.join(os.tmpdir(), "apex-control-plane-nested-link-"));
const outsideSpill = fs.mkdtempSync(path.join(os.tmpdir(), "apex-control-plane-external-spill-"));
fs.mkdirSync(path.join(nestedLinkWs, ".harness"));
fs.writeFileSync(path.join(outsideSpill, "private"), "synthetic-spill");
fs.symlinkSync(outsideSpill, path.join(nestedLinkWs, ".harness", "spill"));
const linkedAlias = path.join(nestedLinkWs, "spill-alias");
fs.linkSync(path.join(outsideSpill, "private"), linkedAlias);
assert.throws(() => readWorkspaceFileSafe({ workspaceRoot: nestedLinkWs, candidatePath: linkedAlias }), PathContainmentError, "Symlinked spill directories must not bypass alias checks");
assert.throws(() => buildMinimalBwrapArgv("true", nestedLinkWs, { workspaceRoot: nestedLinkWs }), SandboxUnavailableError, "Symlinked control-plane descendants must fail closed");
console.log("control-plane shell mask arguments: PASS");
