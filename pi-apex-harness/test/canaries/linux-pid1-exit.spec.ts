/** Diagnostic: natural leader exit with a specifically identified setsid child. */
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildMinimalBwrapArgv } from "../../src/core/bwrap-sandbox.ts";

assert.equal(process.platform, "linux", "This diagnostic requires Linux PID namespaces");
const ws = fs.mkdtempSync(path.join(os.tmpdir(), "apex-pid1-exit-"));
const socketPath = path.join(ws, "peer.sock");
const serverReady = path.join(ws, "server-ready");
const identityFile = path.join(ws, "child-identity.json");
const ready = path.join(ws, "child-ready");
const done = path.join(ws, "child-finished");
const namespaceFile = path.join(ws, "child-pid-namespace");
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

// SO_PEERCRED reports this test-owned client's PID in the server's host PID
// namespace. No host process enumeration or unrelated process signaling is used.
const serverCode = [
  "import json,os,pathlib,socket,struct",
  "s=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM)",
  `s.bind(${JSON.stringify(socketPath)})`,
  "s.listen(1)",
  "s.settimeout(10)",
  `pathlib.Path(${JSON.stringify(serverReady)}).write_text('ready')`,
  "c,_=s.accept()",
  "c.settimeout(3)",
  "c.recv(1)",
  "pid,uid,gid=struct.unpack('3i',c.getsockopt(socket.SOL_SOCKET,socket.SO_PEERCRED,struct.calcsize('3i')))",
  "assert uid==os.getuid()",
  "raw=pathlib.Path('/proc/%d/stat'%pid).read_text()",
  "start=raw[raw.rfind(')')+1:].split()[19]",
  `pathlib.Path(${JSON.stringify(identityFile)}).write_text(json.dumps({'pid':pid,'start':start}))`,
  "c.sendall(b'1')",
  "c.close()",
  "s.close()"
].join("\n");
const server = spawn("python3", ["-c", serverCode], { stdio: ["ignore", "ignore", "pipe"] });
let serverError = "";
server.stderr?.on("data", (chunk) => { serverError += String(chunk).slice(0, 1024); });
const serverClosed = new Promise<number | null>((resolve) => server.once("close", resolve));

const childCode = [
  "import os,pathlib,socket,time",
  "os.setsid()",
  "s=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM)",
  `s.connect(${JSON.stringify(socketPath)})`,
  "s.sendall(b'x')",
  "assert s.recv(1)==b'1'",
  "s.close()",
  `pathlib.Path(${JSON.stringify(namespaceFile)}).write_text(os.readlink('/proc/self/ns/pid'))`,
  `pathlib.Path(${JSON.stringify(ready)}).write_text('ready')`,
  "time.sleep(4)",
  `pathlib.Path(${JSON.stringify(done)}).write_text('finished')`
].join(";");
const command = [
  `python3 -c ${quote(childCode)} </dev/null >/dev/null 2>&1 &`,
  `i=0; while [ ! -f ${quote(ready)} ] && [ "$i" -lt 100 ]; do sleep 0.05; i=$((i + 1)); done`,
  `[ -f ${quote(ready)} ] || exit 2`,
  "exit 0"
].join("\n");

interface OwnedIdentity { pid: number; start: string }
function ownedChildAlive(identity: OwnedIdentity): boolean {
  try {
    const raw = fs.readFileSync(`/proc/${identity.pid}/stat`, "utf8");
    const right = raw.lastIndexOf(")");
    if (right < 0) throw new Error("Malformed owned-child process stat");
    const fields = raw.slice(right + 1).trim().split(/\s+/);
    if (fields.length <= 19) throw new Error("Truncated owned-child process stat");
    return fields[19] === identity.start && fields[0] !== "Z" && fields[0] !== "X";
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ESRCH") return false;
    throw error;
  }
}
async function waitUntil(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return true;
}

let identity: OwnedIdentity | undefined;
let primaryError: unknown;
try {
  assert.ok(await waitUntil(() => fs.existsSync(serverReady), 3000), "The test-owned identity server must be ready");
  execFileSync("bwrap", buildMinimalBwrapArgv(command, ws, { workspaceRoot: ws, mode: "workspace-write" }), {
    stdio: "pipe", timeout: 11_000
  });
  assert.ok(fs.existsSync(ready), "The test-owned setsid child must have started");
  identity = JSON.parse(fs.readFileSync(identityFile, "utf8")) as OwnedIdentity;
  assert.ok(Number.isInteger(identity.pid) && identity.pid > 0 && /^\d+$/.test(identity.start));
  const namespace = fs.readFileSync(namespaceFile, "utf8").trim();
  assert.match(namespace, /^pid:\[\d+\]$/);
  assert.notEqual(namespace, fs.readlinkSync("/proc/self/ns/pid"), "The fixture must run inside a distinct PID namespace");
  assert.ok(await waitUntil(() => !ownedChildAlive(identity!), 1000), "Natural leader exit must stop the identified setsid child");
  assert.equal(fs.existsSync(done), false, "The setsid child must not finish after its leader exits");
  console.log("Linux PID namespace natural leader exit: PASS");
} catch (error) {
  primaryError = error;
} finally {
  try {
    const code = await serverClosed;
    if (code !== 0) throw new Error(`Test-owned identity server failed (${String(code)}): ${serverError}`);
    if (!identity && fs.existsSync(identityFile)) identity = JSON.parse(fs.readFileSync(identityFile, "utf8")) as OwnedIdentity;
    if (identity && !(await waitUntil(() => !ownedChildAlive(identity!), 6000))) {
      throw new Error("Test-owned setsid child remains alive after its bounded lifetime");
    }
  } catch (error) {
    if (primaryError) console.warn(`PID_PROBE_CLEANUP_UNVERIFIED: ${String(error)}`);
    else primaryError = error;
  }
}
if (primaryError) throw primaryError;
