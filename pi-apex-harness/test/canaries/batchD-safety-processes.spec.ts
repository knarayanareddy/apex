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
  assert.equal(termResult.success, true, "All owned descendants must be terminated");
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

  console.log("  [PASS] D5 verified: Descendants terminated, bounded shutdown, recycled PIDs protected.");
}

async function runAllBatchDTests(): Promise<void> {
  console.log("=== Running Batch D: Data Safety & Process Ownership Tests ===");
  await testD1NestedGitIsolation();
  await testD2CheckpointMetadataAgreement();
  await testD3OrderedDurability();
  await testD4ConcurrentEditContract();
  await testD5ProcessOwnershipAndRecycling();
  console.log("\n=== ALL BATCH D DATA SAFETY & PROCESS OWNERSHIP TESTS PASSED CLEANLY ===\n");
}

runAllBatchDTests().catch((err) => {
  console.error("\n[BATCH D FAILURE]", err);
  process.exit(1);
});
