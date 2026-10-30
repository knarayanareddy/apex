/** Diagnostic: observe natural leader exit and a test-owned setsid child. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildMinimalBwrapArgv } from "../../src/core/bwrap-sandbox.ts";

assert.equal(process.platform, "linux", "This diagnostic requires Linux PID namespaces");
const ws = fs.mkdtempSync(path.join(os.tmpdir(), "apex-pid1-exit-"));
const ready = path.join(ws, "child-ready");
const done = path.join(ws, "child-finished");
const namespaceFile = path.join(ws, "child-pid-namespace");
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
const child = [
  "import os,time,pathlib",
  "os.setsid()",
  `pathlib.Path(${JSON.stringify(namespaceFile)}).write_text(os.readlink('/proc/self/ns/pid'))`,
  `pathlib.Path(${JSON.stringify(ready)}).write_text('ready')`,
  "time.sleep(4)",
  `pathlib.Path(${JSON.stringify(done)}).write_text('finished')`
].join(";");
const command = [
  `python3 -c ${quote(child)} </dev/null >/dev/null 2>&1 &`,
  `i=0; while [ ! -f ${quote(ready)} ] && [ "$i" -lt 100 ]; do sleep 0.05; i=$((i + 1)); done`,
  `[ -f ${quote(ready)} ] || exit 2`,
  "exit 0"
].join("\n");

function namespaceMembers(namespace: string): number[] {
  const members: number[] = [];
  for (const entry of fs.readdirSync("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      if (process.getuid && fs.statSync(`/proc/${entry}`).uid !== process.getuid()) continue;
      if (fs.readlinkSync(`/proc/${entry}/ns/pid`) === namespace) members.push(Number(entry));
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ESRCH") throw error;
    }
  }
  return members;
}

let namespace = "";
try {
  execFileSync("bwrap", buildMinimalBwrapArgv(command, ws, { workspaceRoot: ws, mode: "workspace-write" }), {
    stdio: "pipe", timeout: 11_000
  });
  assert.ok(fs.existsSync(ready), "The test-owned setsid child must have started");
  namespace = fs.readFileSync(namespaceFile, "utf8").trim();
  assert.match(namespace, /^pid:\[\d+\]$/);
  assert.notEqual(namespace, fs.readlinkSync("/proc/self/ns/pid"), "The fixture must run inside a distinct PID namespace");
  const deadline = Date.now() + 1000;
  while (namespaceMembers(namespace).length && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.deepEqual(namespaceMembers(namespace), [], "Natural leader exit must leave no namespace members");
  assert.equal(fs.existsSync(done), false, "The setsid child must not outlive its leader");
  console.log("Linux PID namespace natural leader exit: PASS");
} finally {
  // Do not signal host PIDs. The test-owned child exits on its own after four
  // seconds; retain the workspace as evidence if cleanup cannot be observed.
  if (!namespace && fs.existsSync(namespaceFile)) namespace = fs.readFileSync(namespaceFile, "utf8").trim();
  if (/^pid:\[\d+\]$/.test(namespace)) {
    const deadline = Date.now() + 6000;
    while (namespaceMembers(namespace).length && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    if (namespaceMembers(namespace).length) throw new Error("Test-owned PID namespace remains populated");
  }
}
