/**
 * Linux Kernel-Backed Process Ownership & Confinement Qualification Suite (Programme E3 / R07).
 *
 * Enforces ADR 0002 ("Require a kernel-owned execution boundary"):
 *  1. Natural leader exit: PID 1 termination in a PID namespace causes the Linux kernel to
 *     unconditionally kill all remaining processes in the namespace (including setsid / reparented).
 *  2. Control pipe cancellation: closing the host's control-pipe writer sends EOF to supervisor,
 *     triggering prompt termination before any finite fallback timeout, with zero host process signals.
 *  3. Parent death (--die-with-parent): unexpected parent death delivers PR_SET_PDEATHSIG (SIGKILL)
 *     to bwrap, tearing down the PID namespace and terminating all detached children.
 *  4. Reparenting containment: deeply nested and orphaned grandchildren reparent to namespace PID 1
 *     rather than host init (PID 1), and are synchronously reaped when namespace PID 1 terminates.
 *
 * Safety & Verification Invariants:
 *  - Uses owned Unix socket SO_PEERCRED to capture client PID, start time ticks, and PID namespace.
 *  - Never scans unrelated /proc directories (avoiding EACCES or false passes).
 *  - Never issues signals to arbitrary PIDs or process groups.
 *  - On failure: preserves primary assertion failure and retains the fixture directory and logs.
 *  - On non-Linux hosts (macOS darwin, Windows): reports explicit SKIPPED/UNVERIFIED status without false pass claims.
 */

import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildMinimalBwrapArgv, createBwrapBashOperations, probeBwrapFunctional } from "../../src/core/bwrap-sandbox.ts";
import { recordProcessIdentity, terminateProcessTree } from "../../src/core/process-tree.ts";

console.log("=== Linux Kernel Process Ownership Qualification (ADR 0002 / R07) ===");

if (process.platform !== "linux") {
  console.log("[TIER: LINUX PROCESS CONTAINMENT] Status: SKIPPED (NON_LINUX_HOST)");
  console.log(`  Current OS: ${process.platform} (${os.type()} ${os.release()})`);
  console.log("  Rationale: Linux PID namespaces, bubblewrap namespace containment, and SO_PEERCRED are Linux-specific.");
  console.log("  On Darwin/macOS, execution without VM supervisor is refused fail-closed (ADR 0002).");
  console.log("=== LINUX PROCESS CONTAINMENT: SKIPPED ON NON-LINUX HOST ===\n");
  process.exit(0);
}

// On Linux: verify functional bubblewrap before executing kernel namespace suite
const probe = probeBwrapFunctional();
if (!probe.ok) {
  console.error(`[TIER: LINUX PROCESS CONTAINMENT] FAILED: Linux host missing functional bubblewrap: ${probe.reason}`);
  console.error("Install bubblewrap (`apt-get install -y bwrap` or equivalent) to qualify Linux process ownership.");
  process.exit(1);
}

const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

interface OwnedIdentity {
  pid: number;
  start: string;
  nspid?: number[];
  namespace?: string;
  sessionId?: number;
}

function readOwnedChildStat(identity: OwnedIdentity): { alive: boolean; state: string } {
  try {
    const raw = fs.readFileSync(`/proc/${identity.pid}/stat`, "utf8");
    const right = raw.lastIndexOf(")");
    if (right < 0) return { alive: false, state: "X" };
    const fields = raw.slice(right + 1).trim().split(/\s+/);
    if (fields.length <= 19) return { alive: false, state: "X" };
    const startTicks = fields[19];
    const state = fields[0];
    if (startTicks !== identity.start) {
      // PID was recycled by another process!
      return { alive: false, state: "RECYCLED" };
    }
    const alive = state !== "Z" && state !== "X";
    return { alive, state };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ESRCH") {
      return { alive: false, state: "NONE" };
    }
    throw error;
  }
}

async function waitUntil(predicate: () => boolean, timeoutMs: number, pollIntervalMs = 25): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }
  return true;
}

interface IdentityServer {
  socketPath: string;
  identityFile: string;
  readyFile: string;
  getIdentity: () => Promise<OwnedIdentity>;
  close: () => Promise<void>;
}

function startIdentityServer(fixtureDir: string, tag: string): IdentityServer {
  const socketPath = path.join(fixtureDir, `peer-${tag}.sock`);
  const readyFile = path.join(fixtureDir, `server-ready-${tag}`);
  const identityFile = path.join(fixtureDir, `child-identity-${tag}.json`);

  const serverPy = [
    "import json,os,pathlib,socket,struct,sys",
    "s=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM)",
    `s.bind(${JSON.stringify(socketPath)})`,
    "s.listen(1)",
    "s.settimeout(10)",
    `pathlib.Path(${JSON.stringify(readyFile)}).write_text('ready')`,
    "try:",
    "    c,_=s.accept()",
    "    c.settimeout(5)",
    "    c.recv(1)",
    "    pid,uid,gid=struct.unpack('3i',c.getsockopt(socket.SOL_SOCKET,socket.SO_PEERCRED,struct.calcsize('3i')))",
    "    assert uid==os.getuid()",
    "    raw=pathlib.Path('/proc/%d/stat'%pid).read_text()",
    "    start=raw[raw.rfind(')')+1:].split()[19]",
    "    session_id=int(raw[raw.rfind(')')+1:].split()[3])",
    "    ns_link=os.readlink('/proc/%d/ns/pid'%pid)",
    "    status_lines=pathlib.Path('/proc/%d/status'%pid).read_text().splitlines()",
    "    nspid_line=next((l for l in status_lines if l.startswith('NSpid:')), None)",
    "    nspids=[int(x) for x in nspid_line.split()[1:]] if nspid_line else []",
    `    pathlib.Path(${JSON.stringify(identityFile)}).write_text(json.dumps({'pid':pid,'start':start,'namespace':ns_link,'nspid':nspids,'sessionId':session_id}))`,
    "    c.sendall(b'1')",
    "    c.close()",
    "finally:",
    "    s.close()"
  ].join("\n");

  const server = spawn("python3", ["-c", serverPy], { stdio: ["ignore", "ignore", "pipe"] });
  let stderr = "";
  server.stderr?.on("data", (chunk) => { stderr += String(chunk).slice(0, 1024); });
  const serverClosed = new Promise<number | null>((resolve) => server.once("close", resolve));

  return {
    socketPath,
    identityFile,
    readyFile,
    getIdentity: async () => {
      const ok = await waitUntil(() => fs.existsSync(identityFile), 5000);
      assert.ok(ok, `Timed out waiting for client identity in server '${tag}' (stderr: ${stderr})`);
      return JSON.parse(fs.readFileSync(identityFile, "utf8")) as OwnedIdentity;
    },
    close: async () => {
      try {
        server.kill("SIGTERM");
      } catch {}
      await serverClosed;
    }
  };
}

let primaryFailure: unknown;
const ws = fs.mkdtempSync(path.join(os.tmpdir(), "apex-linux-containment-"));
let passedAllGates = false;

try {
  // =========================================================================
  // Gate 1: Natural Leader Exit with setsid Child (Public bashOps Path)
  // =========================================================================
  console.log("\n[Gate 1] Testing natural leader exit with setsid child via public bashOps...");
  {
    const srv = startIdentityServer(ws, "g1");
    assert.ok(await waitUntil(() => fs.existsSync(srv.readyFile), 3000), "Identity server must be ready");

    const childReady = path.join(ws, "g1-child-ready");
    const childDone = path.join(ws, "g1-child-done");

    const childPy = [
      "import os,pathlib,socket,time",
      "os.setsid()",
      "s=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM)",
      `s.connect(${JSON.stringify(srv.socketPath)})`,
      "s.sendall(b'x')",
      "assert s.recv(1)==b'1'",
      "s.close()",
      `pathlib.Path(${JSON.stringify(childReady)}).write_text('ready')`,
      "time.sleep(10)",
      `pathlib.Path(${JSON.stringify(childDone)}).write_text('finished')`
    ].join(";");

    const command = [
      `python3 -c ${quote(childPy)} </dev/null >/dev/null 2>&1 &`,
      `i=0; while [ ! -f ${quote(childReady)} ] && [ "$i" -lt 100 ]; do sleep 0.05; i=$((i + 1)); done`,
      `[ -f ${quote(childReady)} ] || exit 2`,
      "exit 0"
    ].join("\n");

    const bashOps = createBwrapBashOperations({
      workspaceRoot: ws,
      mode: "workspace-write",
      unshareNet: true
    });

    const res = await bashOps.exec(command, ws, { onData: () => {} });
    assert.equal(res.exitCode, 0, "Natural leader exit must return exitCode 0");

    const identity = await srv.getIdentity();
    assert.ok(Number.isInteger(identity.pid) && identity.pid > 0);
    assert.ok(Array.isArray(identity.nspid) && identity.nspid.length >= 2, "Child must be inside nested PID namespace");
    assert.notEqual(identity.namespace, fs.readlinkSync("/proc/self/ns/pid"), "Child must be in distinct PID namespace");

    // Once the leader (bwrap / command) exited, the kernel terminates the setsid child
    const terminated = await waitUntil(() => !readOwnedChildStat(identity).alive, 2000);
    assert.ok(terminated, "Natural leader exit must terminate the setsid child via kernel PID namespace reclamation");
    assert.equal(fs.existsSync(childDone), false, "Setsid child must not run to completion");
    await srv.close();
    console.log("  [PASS] Gate 1: Natural leader exit terminates detached setsid child.");
  }

  // =========================================================================
  // Gate 2: Production Process Cancellation via AbortSignal (Public bashOps Path)
  // =========================================================================
  console.log("\n[Gate 2] Testing production process cancellation via AbortSignal on public bashOps path...");
  {
    const srv = startIdentityServer(ws, "g2");
    assert.ok(await waitUntil(() => fs.existsSync(srv.readyFile), 3000), "Identity server must be ready");

    const childReady = path.join(ws, "g2-child-ready");
    const childDone = path.join(ws, "g2-child-done");

    const childPy = [
      "import os,pathlib,socket,time",
      "os.setsid()",
      "s=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM)",
      `s.connect(${JSON.stringify(srv.socketPath)})`,
      "s.sendall(b'x')",
      "assert s.recv(1)==b'1'",
      "s.close()",
      `pathlib.Path(${JSON.stringify(childReady)}).write_text('ready')`,
      "time.sleep(25)",
      `pathlib.Path(${JSON.stringify(childDone)}).write_text('finished')`
    ].join(";");

    const command = [
      `python3 -c ${quote(childPy)} </dev/null >/dev/null 2>&1 &`,
      `i=0; while [ ! -f ${quote(childReady)} ] && [ "$i" -lt 100 ]; do sleep 0.05; i=$((i + 1)); done`,
      `[ -f ${quote(childReady)} ] || exit 2`,
      "sleep 30"
    ].join("\n");

    const bashOps = createBwrapBashOperations({
      workspaceRoot: ws,
      mode: "workspace-write",
      unshareNet: true
    });

    const controller = new AbortController();
    const execPromise = bashOps.exec(command, ws, {
      signal: controller.signal,
      onData: () => {}
    });

    assert.ok(await waitUntil(() => fs.existsSync(childReady), 5000), "Child must be ready");
    const identity = await srv.getIdentity();
    assert.ok(readOwnedChildStat(identity).alive, "Child must be alive before cancellation");

    // Trigger production cancellation
    controller.abort();
    const res = await execPromise;
    assert.equal(res.exitCode, 137, "Cancelled execution must resolve with exitCode 137");

    // Verify setsid child is terminated promptly by kernel namespace reclamation
    const terminated = await waitUntil(() => !readOwnedChildStat(identity).alive, 2500);
    assert.ok(terminated, "Production cancellation must terminate the setsid child via kernel PID namespace reclamation");
    assert.equal(fs.existsSync(childDone), false, "Setsid child must not run to completion");
    await srv.close();
    console.log("  [PASS] Gate 2: Production AbortSignal cancellation terminates detached setsid child.");
  }

  // =========================================================================
  // Gate 2B: Production Timeout via options.timeout (Public bashOps Path)
  // =========================================================================
  console.log("\n[Gate 2B] Testing production timeout via options.timeout on public bashOps path...");
  {
    const srv = startIdentityServer(ws, "g2b");
    assert.ok(await waitUntil(() => fs.existsSync(srv.readyFile), 3000), "Identity server must be ready");

    const childReady = path.join(ws, "g2b-child-ready");
    const childDone = path.join(ws, "g2b-child-done");

    const childPy = [
      "import os,pathlib,socket,time",
      "os.setsid()",
      "s=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM)",
      `s.connect(${JSON.stringify(srv.socketPath)})`,
      "s.sendall(b'x')",
      "assert s.recv(1)==b'1'",
      "s.close()",
      `pathlib.Path(${JSON.stringify(childReady)}).write_text('ready')`,
      "time.sleep(25)",
      `pathlib.Path(${JSON.stringify(childDone)}).write_text('finished')`
    ].join(";");

    const command = [
      `python3 -c ${quote(childPy)} </dev/null >/dev/null 2>&1 &`,
      `i=0; while [ ! -f ${quote(childReady)} ] && [ "$i" -lt 100 ]; do sleep 0.05; i=$((i + 1)); done`,
      `[ -f ${quote(childReady)} ] || exit 2`,
      "sleep 30"
    ].join("\n");

    const bashOps = createBwrapBashOperations({
      workspaceRoot: ws,
      mode: "workspace-write",
      unshareNet: true
    });

    const execPromise = bashOps.exec(command, ws, {
      timeout: 1,
      onData: () => {}
    });

    assert.ok(await waitUntil(() => fs.existsSync(childReady), 5000), "Child must be ready");
    const identity = await srv.getIdentity();
    assert.ok(readOwnedChildStat(identity).alive, "Child must be alive before timeout");

    const res = await execPromise;
    assert.equal(res.exitCode, 124, "Timed-out execution must resolve with exitCode 124");

    const terminated = await waitUntil(() => !readOwnedChildStat(identity).alive, 2500);
    assert.ok(terminated, "Production timeout must terminate the setsid child via kernel PID namespace reclamation");
    assert.equal(fs.existsSync(childDone), false, "Setsid child must not run to completion");
    await srv.close();
    console.log("  [PASS] Gate 2B: Production timeout terminates detached setsid child.");
  }

  // =========================================================================
  // Gate 3: Parent Death Containment (--die-with-parent)
  // =========================================================================
  console.log("\n[Gate 3] Testing parent death containment (--die-with-parent)...");
  {
    const srv = startIdentityServer(ws, "g3");
    assert.ok(await waitUntil(() => fs.existsSync(srv.readyFile), 3000), "Identity server must be ready");

    const childReady = path.join(ws, "g3-child-ready");
    const childDone = path.join(ws, "g3-child-done");

    const childPy = [
      "import os,pathlib,socket,time",
      "os.setsid()",
      "s=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM)",
      `s.connect(${JSON.stringify(srv.socketPath)})`,
      "s.sendall(b'x')",
      "assert s.recv(1)==b'1'",
      "s.close()",
      `pathlib.Path(${JSON.stringify(childReady)}).write_text('ready')`,
      "time.sleep(20)",
      `pathlib.Path(${JSON.stringify(childDone)}).write_text('finished')`
    ].join(";");

    const intermediaryScript = [
      "import subprocess,time",
      `p=subprocess.Popen(['bwrap', '--unshare-pid', '--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp', '--ro-bind', '/usr', '/usr', '--ro-bind', '/bin', '/bin', '--ro-bind', '/lib', '/lib', '--ro-bind-try', '/lib64', '/lib64', '--bind', ${JSON.stringify(ws)}, ${JSON.stringify(ws)}, '--die-with-parent', '--', 'python3', '-c', ${JSON.stringify(childPy)}])`,
      "time.sleep(30)"
    ].join("\n");

    const intermediary = spawn("python3", ["-c", intermediaryScript], { stdio: "ignore" });
    assert.ok(await waitUntil(() => fs.existsSync(childReady), 5000), "Descendant must be ready");
    const identity = await srv.getIdentity();
    assert.ok(readOwnedChildStat(identity).alive, "Descendant must be alive before parent death");

    // Abruptly kill the intermediary parent process with SIGKILL
    intermediary.kill("SIGKILL");

    // The Linux kernel sends PR_SET_PDEATHSIG to bwrap; bwrap terminates, killing the PID namespace!
    const terminated = await waitUntil(() => !readOwnedChildStat(identity).alive, 2500);
    assert.ok(terminated, "Parent death must trigger PR_SET_PDEATHSIG and terminate descendant in PID namespace");
    assert.equal(fs.existsSync(childDone), false, "Descendant must not run to completion");
    await srv.close();
    console.log("  [PASS] Gate 3: Parent death cleans up all descendants via --die-with-parent.");
  }

  // =========================================================================
  // Gate 4: Reparenting in PID Namespace (Grandchild Containment)
  // =========================================================================
  console.log("\n[Gate 4] Testing reparenting and detached grandchild containment...");
  {
    const srv = startIdentityServer(ws, "g4");
    assert.ok(await waitUntil(() => fs.existsSync(srv.readyFile), 3000), "Identity server must be ready");

    const grandchildReady = path.join(ws, "g4-grandchild-ready");
    const grandchildDone = path.join(ws, "g4-grandchild-done");

    // Process A (bwrap PID 1) forks Process B. Process B forks Process C (grandchild, setsid), then B immediately exits.
    // Process C reparents to Process A (namespace PID 1).
    // When Process A exits, Process C must be terminated by kernel!
    const reparentFile = path.join(ws, "reparent-g4.py");
    const reparentScript = [
      "import os, pathlib, socket, time",
      "p2 = os.fork()",
      "if p2 == 0:",
      "    p3 = os.fork()",
      "    if p3 == 0:",
      "        os.setsid()",
      "        s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)",
      `        s.connect(${JSON.stringify(srv.socketPath)})`,
      "        s.sendall(b'x')",
      "        assert s.recv(1) == b'1'",
      "        s.close()",
      `        pathlib.Path(${JSON.stringify(grandchildReady)}).write_text('ready')`,
      "        time.sleep(20)",
      `        pathlib.Path(${JSON.stringify(grandchildDone)}).write_text('finished')`,
      "        os._exit(0)",
      "    os._exit(0)", // B exits immediately, orphaning C!
      "os.waitpid(p2, 0)",
      "i = 0",
      `while not pathlib.Path(${JSON.stringify(grandchildReady)}).exists() and i < 100:`,
      "    time.sleep(0.05)",
      "    i += 1",
      "time.sleep(0.2)",
      "os._exit(0)" // A exits, which must trigger kernel cleanup of reparented grandchild C!
    ].join("\n");
    fs.writeFileSync(reparentFile, reparentScript, { mode: 0o755 });

    const command = [
      `python3 ${quote(reparentFile)}`,
      "exit 0"
    ].join("\n");

    const bashOps = createBwrapBashOperations({
      workspaceRoot: ws,
      mode: "workspace-write",
      unshareNet: true
    });

    const res = await bashOps.exec(command, ws, { onData: () => {} });
    assert.equal(res.exitCode, 0, "Reparenting leader exit must resolve exitCode 0");

    const identity = await srv.getIdentity();
    assert.ok(Number.isInteger(identity.pid) && identity.pid > 0);

    // Verify orphaned/reparented grandchild C is terminated when namespace PID 1 exits
    const terminated = await waitUntil(() => !readOwnedChildStat(identity).alive, 2000);
    assert.ok(terminated, "Namespace PID 1 exit must terminate reparented grandchild");
    assert.equal(fs.existsSync(grandchildDone), false, "Grandchild must not complete");
    await srv.close();
    console.log("  [PASS] Gate 4: Orphaned and reparented grandchild reaped by PID namespace.");
  }

  // =========================================================================
  // Gate 5: Process Ownership Identity Controls & Fail-Closed Refusal
  // =========================================================================
  console.log("\n[Gate 5] Testing ownership refusal and negative controls...");
  {
    const originalKill = process.kill;
    const attemptedSignals: string[] = [];
    const currentIdentity = recordProcessIdentity(process.pid);
    assert.ok(currentIdentity.startTime, "The current process identity must be measurable for this control");

    process.kill = ((pid: number, signal?: NodeJS.Signals | number) => {
      if (signal === 0) {
        if (pid === process.pid) return originalKill(pid, 0);
        const err = new Error("No such process") as NodeJS.ErrnoException;
        err.code = "ESRCH";
        throw err;
      }
      attemptedSignals.push(`${pid}:${signal}`);
      return true;
    }) as typeof process.kill;

    try {
      // 5A: Refuse signaling when process start identity is unknown/null
      const unknownResult = await terminateProcessTree(process.pid, { ...currentIdentity, startTime: null });
      assert.equal(unknownResult.success, false, "Unknown identity must report failure");
      assert.deepEqual(attemptedSignals, [], "Unknown identity must never receive a signal");

      // 5B: Refuse signaling when process PID was recycled
      const fakeRecycledIdentity = {
        pid: process.pid,
        startTime: "FakeRecycledStartTime_99999",
        bootId: currentIdentity.bootId
      };
      const recycledResult = await terminateProcessTree(process.pid, fakeRecycledIdentity);
      assert.equal(recycledResult.success, false, "Recycled process must report failure");
      assert.equal(recycledResult.recycledDetected, true, "Must detect recycled PID");
      assert.deepEqual(attemptedSignals, [], "Recycled process must never receive a signal");
    } finally {
      process.kill = originalKill;
    }

    console.log("  [PASS] Gate 5: Ownership refusal and negative signal controls verified.");
  }

  passedAllGates = true;
  console.log("\n=== ALL 5 LINUX PROCESS OWNERSHIP GATES PASSED CLEANLY ===\n");
} catch (error) {
  primaryFailure = error;
} finally {
  if (passedAllGates) {
    try {
      fs.rmSync(ws, { recursive: true, force: true });
    } catch {}
  } else {
    console.error(`\n[TIER: LINUX PROCESS CONTAINMENT] FAILED: primary assertion failure: ${String(primaryFailure)}`);
    console.error(`[TIER: LINUX PROCESS CONTAINMENT] EVIDENCE RETAINED: fixture preserved at: ${ws}`);
  }
}

if (primaryFailure) {
  throw primaryFailure;
}
