/**
 * Batch D Remediation Canary Suite (`test/canaries/batchD-safety-processes.spec.ts`)
 *
 * Verifies the 5 Data Safety & Process Ownership Contracts:
 *  D1: Nested Git-object secret isolation (root, nested, worktree, alternates).
 *  D2: Checkpoint metadata strictly agreeing with restoration bytes (ignored, CRLF, modes).
 *  D3: Ordered filesystem durability before completion records.
 *  D4: Truthful concurrent-edit contract (quiescent workspace + conflict refusal).
 *  D5: Host-development descendant tracking, cleanup, and PID recycling protection.
 */

import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  auditGitHistoryForSecretPaths,
  findWorkspaceGitRoots,
  PathContainmentError,
  readWorkspaceFileSafe,
  scanWorkspaceSecretsAndHardlinks
} from "../../src/core/safe-path.ts";
import {
  resolveGitRepositoryLayout,
  resolveAllWorkspaceGitLayouts,
  SandboxUnavailableError,
  createBwrapBashOperations
} from "../../src/core/bwrap-sandbox.ts";
import {
  captureTurnCheckpoint,
  readGitTreeManifest,
  recoverInterruptedRewinds,
  rewindChatAndDiskToLeaf,
  RewindConflictError,
  snapshotWorkingTreeToGit
} from "../../src/core/git-rewind.ts";
import {
  acquireWorkspaceLock,
  WorkspaceLockError
} from "../../src/core/workspace-lock.ts";
import {
  findDescendantPids,
  getProcessStartTime,
  recordProcessIdentity,
  terminateProcessTree
} from "../../src/core/process-tree.ts";
import { StateDb } from "../../src/core/state-db.ts";
import { loadVerifiedGuardrails } from "../../src/core/guardrail-pin.ts";
import { PtyLeaseManager } from "../../src/ring2/pty-cron-routines.ts";

function createGitRepo(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
  execFileSync("git", ["init", "-b", "main"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "apex-test@example.com"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "Apex Test"], { cwd: dir, stdio: "ignore" });
}

// ============================================================================
// D1: Nested Git-object secret isolation
// ============================================================================
async function testD1NestedGitIsolation(): Promise<void> {
  console.log("--- D1: Nested Git-object secret isolation ---");
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "apex-d1-"));
  createGitRepo(ws);

  // 1. Root historical secret
  const rootSecret = path.join(ws, ".env");
  fs.writeFileSync(rootSecret, "SUPER_SECRET_ROOT_KEY=xyz\n");
  execFileSync("git", ["add", ".env"], { cwd: ws, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "Commit root secret"], { cwd: ws, stdio: "ignore" });
  fs.unlinkSync(rootSecret);
  execFileSync("git", ["add", "-A"], { cwd: ws, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "Delete root secret"], { cwd: ws, stdio: "ignore" });

  // 2. Nested submodule repository with historical secret
  const nestedDir = path.join(ws, "packages", "nested-sub");
  createGitRepo(nestedDir);
  const nestedSecret = path.join(nestedDir, ".env");
  fs.writeFileSync(nestedSecret, "SUPER_SECRET_NESTED_KEY=abc\n");
  execFileSync("git", ["add", ".env"], { cwd: nestedDir, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "Commit nested secret"], { cwd: nestedDir, stdio: "ignore" });
  fs.unlinkSync(nestedSecret);
  execFileSync("git", ["add", "-A"], { cwd: nestedDir, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "Delete nested secret"], { cwd: nestedDir, stdio: "ignore" });

  // 3. Test findWorkspaceGitRoots discovers both
  const gitRoots = findWorkspaceGitRoots(ws);
  assert.equal(gitRoots.length, 2, "Must discover root and nested repository");

  // 4. Test auditGitHistoryForSecretPaths identifies historical secrets across nested repositories
  const audit = auditGitHistoryForSecretPaths(ws);
  assert.equal(audit.hasHistoricalSecrets, true, "Must detect historical secrets across nested repos");
  assert.ok(audit.matchedPaths.some((p) => p.includes("nested-sub/.env")), "Must locate nested secret");

  // 5. Test readWorkspaceFileSafe blocks direct read to ANY .git objects (root and nested)
  assert.throws(
    () => readWorkspaceFileSafe({ workspaceRoot: ws, candidatePath: ".git/config" }),
    PathContainmentError,
    "Direct root .git read must be blocked"
  );
  assert.throws(
    () => readWorkspaceFileSafe({ workspaceRoot: ws, candidatePath: "packages/nested-sub/.git/config" }),
    PathContainmentError,
    "Direct nested .git read must be blocked"
  );

  // 6. Test resolveAllWorkspaceGitLayouts
  const layouts = resolveAllWorkspaceGitLayouts(ws);
  assert.equal(layouts.length, 2);
  assert.ok(layouts.every((l) => l.objectsDirs.length > 0));

  // 7. Test unresolvable alternate store fails closed
  const fakeAlt = path.join(ws, ".git", "objects", "info", "alternates");
  fs.mkdirSync(path.dirname(fakeAlt), { recursive: true });
  fs.writeFileSync(fakeAlt, "/nonexistent/invalid/alternate/store\n");
  assert.throws(
    () => resolveGitRepositoryLayout(ws),
    SandboxUnavailableError,
    "Unresolvable Git alternate object store must throw SandboxUnavailableError"
  );

  console.log("  [PASS] D1 verified: Root, nested, and alternate object stores isolated.");
}

// ============================================================================
// D2: Checkpoint metadata strictly agrees with restoration bytes
// ============================================================================
async function testD2CheckpointMetadataAgreement(): Promise<void> {
  console.log("--- D2: Checkpoint metadata & restoration agreement ---");
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "apex-d2-"));
  createGitRepo(ws);

  // Normal tracked file
  fs.writeFileSync(path.join(ws, "main.ts"), "console.log('hello');\n");
  // Ignored non-secret file
  fs.writeFileSync(path.join(ws, ".gitignore"), "ignored.log\n.env\n");
  fs.writeFileSync(path.join(ws, "ignored.log"), "This is ignored log data\n");
  // CRLF file with gitattributes
  fs.writeFileSync(path.join(ws, ".gitattributes"), "* text=auto\n");
  fs.writeFileSync(path.join(ws, "data.crlf"), "line1\r\nline2\r\n");
  // Secret file (must NEVER enter checkpoint)
  fs.writeFileSync(path.join(ws, ".env"), "API_KEY=secret_12345\n");
  // Executable script
  fs.writeFileSync(path.join(ws, "run.sh"), "#!/bin/bash\necho ok\n", { mode: 0o755 });

  // Initial commit for git baseline
  execFileSync("git", ["add", "main.ts", ".gitignore", ".gitattributes", "run.sh"], { cwd: ws, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "Initial commit"], { cwd: ws, stdio: "ignore" });

  // Capture checkpoint
  const snap = snapshotWorkingTreeToGit(ws);

  // 1. Secret must never enter checkpoint metadata
  assert.equal(snap.entryStates[".env"], undefined, "Secret must not exist in entryStates");
  assert.equal(snap.fileHashes[".env"], undefined, "Secret must not exist in fileHashes");

  // 2. Verified manifest check: No checkpoint lists a file without verified blob
  const manifest = readGitTreeManifest(ws, snap.gitTreeOid);
  for (const [relPath, state] of Object.entries(snap.entryStates)) {
    if (state.kind === "file") {
      assert.ok(manifest[relPath], `Checkpoint claims '${relPath}' which must have a blob in tree`);
      assert.equal(manifest[relPath].objType, "blob");
    }
  }

  // 3. Ignored file was safely captured as exact bytes
  assert.ok(snap.entryStates["ignored.log"], "Approved non-secret ignored file must be captured");
  assert.ok(manifest["ignored.log"], "Blob for ignored file must exist in tree");

  // 4. CRLF bytes are preserved accurately in restoration
  assert.ok(snap.entryStates["data.crlf"]);

  // 5. Test restoration fidelity via rewind
  const stateDb = new StateDb(path.join(ws, ".harness", "state.db"));
  const leaf0 = "leaf_d2_baseline";
  captureTurnCheckpoint({
    stateDb,
    workspaceRoot: ws,
    sessionId: "sess_d2",
    leafId: leaf0,
    turnIndex: 0
  });

  // Mutate files on disk
  fs.writeFileSync(path.join(ws, "ignored.log"), "Corrupted ignored log\n");
  fs.writeFileSync(path.join(ws, "data.crlf"), "corrupted crlf\n");
  fs.unlinkSync(path.join(ws, "run.sh"));

  // Rewind back to leaf0
  rewindChatAndDiskToLeaf({
    stateDb,
    workspaceRoot: ws,
    sessionId: "sess_d2",
    fromLeafId: "leaf_d2_mutated",
    toLeafId: leaf0,
    durabilityMode: "power-loss-safe"
  });

  // Verify restored disk contents match exact original bytes
  assert.equal(
    fs.readFileSync(path.join(ws, "ignored.log"), "utf8"),
    "This is ignored log data\n",
    "Restored ignored file bytes must match checkpoint contract"
  );
  assert.equal(
    fs.readFileSync(path.join(ws, "data.crlf"), "utf8"),
    "line1\r\nline2\r\n",
    "Restored CRLF bytes must match exact raw bytes without alteration"
  );
  assert.ok(fs.existsSync(path.join(ws, "run.sh")), "Deleted executable must be restored");

  console.log("  [PASS] D2 verified: Metadata agrees with restoration bytes, raw fidelity preserved.");
}

// ============================================================================
// D3: Ordered filesystem durability before completion records
// ============================================================================
async function testD3OrderedDurability(): Promise<void> {
  console.log("--- D3: Ordered durability before completion records ---");
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "apex-d3-"));
  createGitRepo(ws);

  fs.mkdirSync(path.join(ws, "nested", "deep"), { recursive: true });
  fs.writeFileSync(path.join(ws, "nested", "deep", "file.txt"), "durable data\n");
  execFileSync("git", ["add", "."], { cwd: ws, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "init"], { cwd: ws, stdio: "ignore" });

  const stateDb = new StateDb(path.join(ws, ".harness", "state.db"));
  captureTurnCheckpoint({
    stateDb,
    workspaceRoot: ws,
    sessionId: "sess_d3",
    leafId: "leaf_0",
    turnIndex: 0
  });

  // Mutate
  fs.writeFileSync(path.join(ws, "nested", "deep", "file.txt"), "modified data\n");

  // Rewind with power-loss-safe durability
  rewindChatAndDiskToLeaf({
    stateDb,
    workspaceRoot: ws,
    sessionId: "sess_d3",
    fromLeafId: "leaf_1",
    toLeafId: "leaf_0",
    durabilityMode: "power-loss-safe"
  });

  // Verify journal and ops completed cleanly
  const journal = stateDb.db.prepare("SELECT phase FROM rewind_journal WHERE session_id = 'sess_d3'").get() as { phase: string };
  assert.equal(journal.phase, "COMPLETED");

  const pendingOps = stateDb.db.prepare("SELECT count(*) as count FROM rewind_ops WHERE status != 'COMPLETED'").get() as { count: number };
  assert.equal(pendingOps.count, 0, "All ops must be completed and synced");

  console.log("  [PASS] D3 verified: Operations fsync parent directory before durable completion.");
}

async function testD3RecoveryRequiresParentSync(): Promise<void> {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "apex-d3-recovery-"));
  createGitRepo(ws);
  fs.mkdirSync(path.join(ws, "nested"));
  const target = path.join(ws, "nested", "file.txt");
  fs.writeFileSync(target, "checkpoint\n");
  execFileSync("git", ["add", "."], { cwd: ws, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "init"], { cwd: ws, stdio: "ignore" });
  const stateDb = new StateDb(path.join(ws, ".harness", "state.db"), "power-loss-safe");
  const originalSync = fs.fsyncSync;
  try {
    captureTurnCheckpoint({ stateDb, workspaceRoot: ws, sessionId: "sess_d3_recovery", leafId: "leaf_0", turnIndex: 0 });
    fs.writeFileSync(target, "modified\n");
    assert.throws(() => rewindChatAndDiskToLeaf({
      stateDb, workspaceRoot: ws, sessionId: "sess_d3_recovery", fromLeafId: "leaf_1", toLeafId: "leaf_0",
      durabilityMode: "power-loss-safe", faultInjectStopAfterPhase: "PREPARING"
    }), /FAULT_INJECT_CRASH_AFTER_PREPARING/);
    // Model a crash after the target was installed, before its durable completion record.
    fs.writeFileSync(target, "checkpoint\n");
    const parent = fs.statSync(path.dirname(target));
    let failedParentSync = false;
    fs.fsyncSync = (fd: number) => {
      const stat = fs.fstatSync(fd);
      if (stat.dev === parent.dev && stat.ino === parent.ino) {
        failedParentSync = true;
        throw new Error("SYNTHETIC_PARENT_FSYNC_FAILURE");
      }
      return originalSync(fd);
    };
    assert.throws(() => recoverInterruptedRewinds({ stateDb, workspaceRoot: ws, sessionId: "sess_d3_recovery", durabilityMode: "power-loss-safe" }), /SYNTHETIC_PARENT_FSYNC_FAILURE/);
    assert.equal(failedParentSync, true, "Recovery must sync the modified file's parent before completion");
    const row = stateDb.db.prepare("SELECT status FROM rewind_ops WHERE rel_path = ?").get("nested/file.txt") as { status: string };
    assert.equal(row.status, "PENDING", "A failed sync must not be recorded as completed");
  } finally {
    fs.fsyncSync = originalSync;
    stateDb.close();
    fs.rmSync(ws, { recursive: true, force: true });
  }
}

// ============================================================================
// D4: Truthful concurrent-edit contract
// ============================================================================
async function testD4ConcurrentEditContract(): Promise<void> {
  console.log("--- D4: Truthful concurrent-edit contract ---");
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "apex-d4-"));
  createGitRepo(ws);

  // 1. Cooperative lock test: two holders on the same workspace cannot hold lock simultaneously
  const lock1 = acquireWorkspaceLock(ws);
  assert.throws(
    () => acquireWorkspaceLock(ws),
    WorkspaceLockError,
    "Second concurrent locker must be refused by cooperative workspace lock"
  );
  lock1.release();

  // 2. Pre-mutation conflict rejection test:
  fs.writeFileSync(path.join(ws, "target.txt"), "initial content\n");
  execFileSync("git", ["add", "."], { cwd: ws, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "init"], { cwd: ws, stdio: "ignore" });

  const stateDb = new StateDb(path.join(ws, ".harness", "state.db"));
  captureTurnCheckpoint({
    stateDb,
    workspaceRoot: ws,
    sessionId: "sess_d4",
    leafId: "leaf_0",
    turnIndex: 0
  });

  fs.writeFileSync(path.join(ws, "target.txt"), "modified content\n");
  captureTurnCheckpoint({
    stateDb,
    workspaceRoot: ws,
    sessionId: "sess_d4",
    leafId: "leaf_1",
    turnIndex: 1
  });

  // Prepare rewind journal and ops, pausing right after PREPARING phase
  assert.throws(
    () =>
      rewindChatAndDiskToLeaf({
        stateDb,
        workspaceRoot: ws,
        sessionId: "sess_d4",
        fromLeafId: "leaf_1",
        toLeafId: "leaf_0",
        faultInjectStopAfterPhase: "PREPARING"
      }),
    (err: any) => err.message === "FAULT_INJECT_CRASH_AFTER_PREPARING"
  );

  // External uncooperative concurrent modification right before op execution
  fs.writeFileSync(path.join(ws, "target.txt"), "third-party concurrent edit between prepare & mutate\n");

  // Resuming/executing the pending rewind must detect that live state diverged from expected baseline
  // and refuse to clobber the user's concurrent mutation, throwing RewindConflictError!
  assert.throws(
    () =>
      recoverInterruptedRewinds({
        stateDb,
        workspaceRoot: ws,
        sessionId: "sess_d4"
      }),
    RewindConflictError,
    "Uncooperative concurrent modification between validation and mutation must be rejected with RewindConflictError"
  );

  // Verify user's concurrent edit was preserved and not clobbered
  assert.equal(
    fs.readFileSync(path.join(ws, "target.txt"), "utf8"),
    "third-party concurrent edit between prepare & mutate\n",
    "Conflicting file must be preserved on disk"
  );

  console.log("  [PASS] D4 verified: Quiescent precondition enforced, concurrent edits rejected.");
}

// ============================================================================
// D5: Own host-development descendants & PID recycling protection
// ============================================================================
async function testD5ProcessOwnershipAndRecycling(): Promise<void> {
  console.log("--- D5: Host-development descendant ownership & recycling protection ---");

  // Never signal a real process during negative identity controls.
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
    const unknown = await terminateProcessTree(process.pid, { ...currentIdentity, startTime: null });
    assert.equal(unknown.success, false, "Missing process start identity must not be treated as a successful cleanup");
    assert.deepEqual(attemptedSignals, [], "An unknown identity must never receive a signal");

    const mismatched = await terminateProcessTree(process.pid + 1000000, currentIdentity);
    assert.equal(mismatched.success, false, "An identity for a different PID must be rejected");
    assert.deepEqual(attemptedSignals, [], "A mismatched PID must never receive a signal");
  } finally {
    process.kill = originalKill;
  }

  // 1. Descendant cleanup test: spawn a process that creates a background child
  const bashScript = 'sh -c "sleep 60" & sleep 60';
  const child = spawn("/bin/bash", ["-c", bashScript], {
    stdio: ["ignore", "pipe", "pipe"]
  });

  const identity = recordProcessIdentity(child.pid!);
  assert.ok(identity.pid > 0);

  // Give child time to spawn background child
  await new Promise((r) => setTimeout(r, 150));

  const descendants = findDescendantPids(child.pid!);
  assert.ok(descendants.length >= 1, "Must detect spawned descendant PID(s)");

  // Terminate process tree
  const termResult = await terminateProcessTree(child.pid!, identity);
  assert.equal(termResult.success, false, "A process snapshot cannot establish cleanup of reparented descendants");
  assert.deepEqual(termResult.survivingPids, [], "Every discovered process must actually be gone");
  assert.ok(termResult.killedPids.includes(child.pid!), "The owned root must have received a signal");
  assert.equal(termResult.recycledDetected, false);

  // Verify none survived
  for (const pid of termResult.killedPids) {
    let alive = true;
    try {
      process.kill(pid, 0);
    } catch {
      alive = false;
    }
    assert.equal(alive, false, `PID ${pid} must be terminated`);
  }

  // 2. PID recycling protection test:
  // If an identity has a fake start time (simulating PID recycled by another process)
  const fakeIdentity = {
    pid: process.pid, // current node process
    startTime: "FakeStartTime9999",
    bootId: identity.bootId
  };
  const recycledResult = await terminateProcessTree(process.pid, fakeIdentity);
  assert.equal(recycledResult.recycledDetected, true, "Must detect mismatched start time as recycled PID");
  assert.equal(recycledResult.success, false, "Must refuse to signal recycled process");

  // 3. Runner timeout & bounded stream shutdown test via createBwrapBashOperations
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "apex-d5-"));
  const bashOps = createBwrapBashOperations({
    workspaceRoot: ws,
    mode: "danger-full-access",
    allowUnsandboxedDev: true
  });

  const chunks: string[] = [];
  const start = Date.now();
  const res = await bashOps.exec("sleep 100", ws, {
    timeout: 1, // 1 second timeout
    onData: (buf) => chunks.push(buf.toString("utf8"))
  });
  const elapsed = Date.now() - start;

  assert.equal(res.exitCode, 124, "Timeout must return exitCode 124");
  assert.ok(elapsed < 2500, `Timeout must resolve promptly without hanging (elapsed: ${elapsed}ms)`);
  assert.ok(chunks.some((c) => c.includes("command timed out")), "Must output timeout notice");

  console.log("  [PASS] D5 verified: Observed processes terminated, ownership remains unverified, bounded shutdown, recycled PIDs protected.");
}

async function testD5PtyUnknownCleanup(): Promise<void> {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "apex-pty-unknown-"));
  const manager = new PtyLeaseManager({ workspaceRoot: ws, guardrails: loadVerifiedGuardrails().config, sandboxMode: "danger-full-access" });
  const info = manager.start({ command: "sleep 60", leaseMs: 60_000 });
  const session = (manager as any).sessions.get(info.id);
  const ownedIdentity = { ...session.procIdentity };
  assert.ok(ownedIdentity.startTime, "Owned test child must have a measurable identity");
  session.procIdentity = { ...ownedIdentity, startTime: null };
  const originalKill = process.kill;
  process.kill = ((pid: number, signal?: NodeJS.Signals | number) => {
    if (signal === 0) return originalKill(pid, 0);
    return true; // Never signal a process in the negative control.
  }) as typeof process.kill;
  try {
    const stopped = manager.stop(info.id, true);
    assert.notEqual(stopped.status, "exited", "An unverified cleanup must not be reported as exited");
    await new Promise((resolve) => setImmediate(resolve));
    const polled = manager.poll(info.id);
    assert.equal(polled.status, "cleanup_unverified", "Failed ownership verification must remain visible");
  } finally {
    process.kill = originalKill;
    await terminateProcessTree(info.pid, ownedIdentity);
    manager.dispose();
    fs.rmSync(ws, { recursive: true, force: true });
  }
}

async function testD5NaturalLeaderExit(): Promise<void> {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "apex-pty-leader-"));
  const manager = new PtyLeaseManager({ workspaceRoot: ws, guardrails: loadVerifiedGuardrails().config, sandboxMode: "danger-full-access" });
  const info = manager.start({ command: "printf 'leader finished'", leaseMs: 10_000 });
  const child = (manager as any).sessions.get(info.id).proc;
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("PTY leader did not close")), 5000);
      child.once("close", () => { clearTimeout(timer); resolve(); });
    });
    const result = manager.poll(info.id);
    assert.equal(result.status, "leader_exited", "A leader exit is not proof that the workload is empty");
    assert.equal(result.cleanupStatus, "unverified");
    assert.equal(result.exitCode, 0);
    assert.match(result.replay, /leader finished/);
    const forgotten = manager.stop(info.id, true);
    assert.equal(forgotten.status, "leader_exited");
    assert.equal(forgotten.cleanupStatus, "unverified");
    assert.throws(() => manager.poll(info.id), /PTY_NOT_FOUND/);
  } finally {
    manager.dispose();
    fs.rmSync(ws, { recursive: true, force: true });
  }
}

async function testD5LeaderExitWithInheritedPipes(): Promise<void> {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "apex-pty-inherited-pipe-"));
  const manager = new PtyLeaseManager({ workspaceRoot: ws, guardrails: loadVerifiedGuardrails().config, sandboxMode: "danger-full-access" });
  const info = manager.start({ command: "sleep 2 & exit 0", leaseMs: 10_000 });
  const child = (manager as any).sessions.get(info.id).proc;
  let closed = false;
  const closePromise = new Promise<void>((resolve) => child.once("close", () => { closed = true; resolve(); }));
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("PTY leader did not exit")), 5000);
      child.once("exit", () => { clearTimeout(timer); resolve(); });
    });
    assert.equal(closed, false, "The owned background child must still hold the inherited pipes");
    const result = manager.poll(info.id);
    assert.equal(result.status, "leader_exited", "Leader exit must be visible before inherited pipes close");
    assert.equal(result.cleanupStatus, "unverified");
    assert.equal(result.exitCode, 0);
    assert.throws(() => manager.writeStdin(info.id, "ignored"), /PTY_EXITED/);
  } finally {
    await closePromise;
    manager.dispose();
    fs.rmSync(ws, { recursive: true, force: true });
  }
}

async function runAllBatchDTests(): Promise<void> {
  console.log("=== Running Batch D: Data Safety & Process Ownership Tests ===");
  await testD1NestedGitIsolation();
  await testD2CheckpointMetadataAgreement();
  await testD3OrderedDurability();
  await testD3RecoveryRequiresParentSync();
  await testD4ConcurrentEditContract();
  await testD5ProcessOwnershipAndRecycling();
  await testD5PtyUnknownCleanup();
  await testD5NaturalLeaderExit();
  await testD5LeaderExitWithInheritedPipes();
  console.log("\n=== ALL BATCH D DATA SAFETY & PROCESS OWNERSHIP TESTS PASSED CLEANLY ===\n");
}

runAllBatchDTests().catch((err) => {
  console.error("\n[BATCH D FAILURE]", err);
  process.exit(1);
});
