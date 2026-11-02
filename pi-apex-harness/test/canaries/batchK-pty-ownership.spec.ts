/**
 * Batch K Canary Suite: PTY Process Ownership & Verified Cleanup Boundary (Programme E3 / R07).
 *
 * Verifies:
 *  K1: Refusal to signal when ownership cannot be established (unknown identity).
 *  K2: Refusal to signal when PID recycling is detected.
 *  K3: Signal error handling (e.g. EPERM / failed signaling marks cleanup_unverified).
 *  K4: Process that remains alive after SIGKILL deadline (timeout marks cleanup_unverified).
 *  K5: Successful termination of real active process:
 *      - On Linux (confined with bwrap): process reaped, exits with snapshot_cleared.
 *      - On macOS Darwin (unconfined): reports cleanup_unverified.
 *  K6: Natural leader exit:
 *      - When command finishes naturally, reports leader_exited and cleanupStatus: unverified.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadVerifiedGuardrails } from "../../src/core/guardrail-pin.ts";
import { PtyLeaseManager, type ActivePtySession } from "../../src/ring2/pty-cron-routines.ts";
import { recordProcessIdentity, type ProcessIdentity } from "../../src/core/process-tree.ts";

console.log("=== Running Batch K: PTY Ownership & Verified Cleanup Tests ===");

const ws = fs.mkdtempSync(path.join(os.tmpdir(), "apex-batch-k-"));
const { config: guardrails } = loadVerifiedGuardrails();

let passed = false;

try {
  const ptyManager = new PtyLeaseManager({
    workspaceRoot: ws,
    guardrails,
    allowUnsandboxedDev: true
  });

  // Access private sessions map for rigorous fault-injection tests
  const sessionsMap = (ptyManager as unknown as { sessions: Map<string, ActivePtySession> }).sessions;
  const requestCleanupFn = (ptyManager as unknown as {
    requestCleanup: (s: ActivePtySession, status: "exited" | "lease_expired", remove: boolean) => void;
  }).requestCleanup.bind(ptyManager);

  // -------------------------------------------------------------------------
  // K1: Refusal to signal a process with unknown identity
  // -------------------------------------------------------------------------
  console.log("--- K1: Unknown process identity refusal ---");
  {
    const mockSession: ActivePtySession = {
      info: {
        id: "pty_test_unknown",
        title: "Unknown Identity",
        command: "sleep 1",
        cwd: ws,
        status: "running",
        pid: 999999, // Unowned / fake PID
        startedAtMs: Date.now(),
        leaseExpiresAtMs: Date.now() + 1000,
        cursor: 0,
        bufferCursor: 0,
        watchDisabled: false,
        watchHitsDelivered: 0
      },
      proc: { pid: 999999 } as any,
      procIdentity: { pid: 999999, startTime: null, bootId: "" }, // Unknown start time
      isConfined: false,
      buffer: "",
      leaseTimer: setTimeout(() => {}, 10_000),
      watchPatterns: [],
      lastWatchDeliveryMs: 0,
      watchStrikes: 0,
      watchMatchesLog: []
    };
    clearTimeout(mockSession.leaseTimer);
    sessionsMap.set(mockSession.info.id, mockSession);

    requestCleanupFn(mockSession, "exited", false);
    assert.equal(
      mockSession.info.status,
      "cleanup_unverified",
      "Process with unknown identity must produce cleanup_unverified"
    );
    assert.equal(mockSession.info.cleanupStatus, "unverified");
    console.log("  [PASS] K1: Unknown process identity refused without signaling.");
  }

  // -------------------------------------------------------------------------
  // K2: Refusal to signal when PID recycling is detected
  // -------------------------------------------------------------------------
  console.log("--- K2: Recycled PID detection and signal refusal ---");
  {
    const currentPid = process.pid;
    const recycledIdentity: ProcessIdentity = {
      pid: currentPid,
      startTime: "invalid_ticks_from_previous_epoch_12345",
      bootId: "boot_xyz"
    };

    const recycledSession: ActivePtySession = {
      info: {
        id: "pty_test_recycled",
        title: "Recycled Identity",
        command: "sleep 1",
        cwd: ws,
        status: "running",
        pid: currentPid,
        startedAtMs: Date.now(),
        leaseExpiresAtMs: Date.now() + 1000,
        cursor: 0,
        bufferCursor: 0,
        watchDisabled: false,
        watchHitsDelivered: 0
      },
      proc: { pid: currentPid } as any,
      procIdentity: recycledIdentity,
      isConfined: false,
      buffer: "",
      leaseTimer: setTimeout(() => {}, 10_000),
      watchPatterns: [],
      lastWatchDeliveryMs: 0,
      watchStrikes: 0,
      watchMatchesLog: []
    };
    clearTimeout(recycledSession.leaseTimer);
    sessionsMap.set(recycledSession.info.id, recycledSession);

    requestCleanupFn(recycledSession, "exited", false);
    assert.equal(
      recycledSession.info.status,
      "cleanup_unverified",
      "Recycled PID must refuse signal and report cleanup_unverified"
    );
    assert.equal(recycledSession.info.cleanupStatus, "unverified");
    console.log("  [PASS] K2: Recycled PID detected and refused without signaling.");
  }

  // -------------------------------------------------------------------------
  // K3: Failed signaling error handling
  // -------------------------------------------------------------------------
  console.log("--- K3: Failed signaling error handling ---");
  {
    const currentPid = process.pid;
    const validIdentity = recordProcessIdentity(currentPid);

    const signalFailSession: ActivePtySession = {
      info: {
        id: "pty_test_signal_fail",
        title: "Signal Fail",
        command: "sleep 1",
        cwd: ws,
        status: "running",
        pid: currentPid,
        startedAtMs: Date.now(),
        leaseExpiresAtMs: Date.now() + 1000,
        cursor: 0,
        bufferCursor: 0,
        watchDisabled: false,
        watchHitsDelivered: 0
      },
      proc: { pid: currentPid } as any,
      procIdentity: validIdentity,
      isConfined: true, // test confined Linux path checkReap
      buffer: "",
      leaseTimer: setTimeout(() => {}, 10_000),
      watchPatterns: [],
      lastWatchDeliveryMs: 0,
      watchStrikes: 0,
      watchMatchesLog: []
    };
    clearTimeout(signalFailSession.leaseTimer);
    sessionsMap.set(signalFailSession.info.id, signalFailSession);

    const origKill = process.kill;
    (process as any).kill = (pid: number, signal?: string | number) => {
      if (pid === currentPid && (signal === "SIGTERM" || signal === "SIGKILL")) {
        const err = new Error("EPERM: operation not permitted") as NodeJS.ErrnoException;
        err.code = "EPERM";
        throw err;
      }
      return origKill.call(process, pid, signal as any);
    };

    try {
      requestCleanupFn(signalFailSession, "exited", false);
      // Wait for async cleanup to settle
      const deadline = Date.now() + 2500;
      while (Date.now() < deadline && signalFailSession.info.cleanupStatus === "pending") {
        await new Promise((r) => setTimeout(r, 50));
      }
      assert.equal(
        signalFailSession.info.status,
        "cleanup_unverified",
        "Failed signal must result in cleanup_unverified"
      );
      assert.equal(signalFailSession.info.cleanupStatus, "unverified");
      console.log("  [PASS] K3: Signal failure handled cleanly as cleanup_unverified.");
    } finally {
      process.kill = origKill;
    }
  }

  // -------------------------------------------------------------------------
  // K4: Process that remains alive after SIGKILL deadline (timeout)
  // -------------------------------------------------------------------------
  console.log("--- K4: Process remaining alive reports unverified ---");
  {
    const currentPid = process.pid;
    const validIdentity = recordProcessIdentity(currentPid);

    const aliveSession: ActivePtySession = {
      info: {
        id: "pty_test_stuck",
        title: "Stuck Process",
        command: "sleep 100",
        cwd: ws,
        status: "running",
        pid: currentPid,
        startedAtMs: Date.now(),
        leaseExpiresAtMs: Date.now() + 1000,
        cursor: 0,
        bufferCursor: 0,
        watchDisabled: false,
        watchHitsDelivered: 0
      },
      proc: { pid: currentPid } as any,
      procIdentity: validIdentity,
      isConfined: true, // triggers checkReap loop
      buffer: "",
      leaseTimer: setTimeout(() => {}, 10_000),
      watchPatterns: [],
      lastWatchDeliveryMs: 0,
      watchStrikes: 0,
      watchMatchesLog: []
    };
    clearTimeout(aliveSession.leaseTimer);
    sessionsMap.set(aliveSession.info.id, aliveSession);

    const origKill = process.kill;
    (process as any).kill = (pid: number, signal?: string | number) => {
      if (pid === currentPid) {
        if (signal === "SIGTERM" || signal === "SIGKILL") {
          return true; // pretend signal delivered
        }
        if (signal === 0) {
          return true; // process stubbornly remains alive
        }
      }
      return origKill.call(process, pid, signal as any);
    };

    try {
      requestCleanupFn(aliveSession, "lease_expired", false);
      assert.equal(aliveSession.info.status, "cleanup_pending", "Lease expiry is not verified until cleanup finishes");
      // Wait for 2x 1000ms deadlines in checkReap
      const deadline = Date.now() + 2500;
      while (Date.now() < deadline && aliveSession.info.cleanupStatus === "pending") {
        await new Promise((r) => setTimeout(r, 50));
      }
      assert.equal(
        aliveSession.info.status,
        "cleanup_unverified",
        "Process remaining alive past SIGKILL deadline must report cleanup_unverified"
      );
      assert.equal(aliveSession.info.cleanupStatus, "unverified");
      console.log("  [PASS] K4: Stuck/unverified process reported as cleanup_unverified.");
    } finally {
      process.kill = origKill;
    }
  }

  // -------------------------------------------------------------------------
  // A permission error during the post-signal probe is not evidence of exit.
  {
    const identity = recordProcessIdentity(process.pid);
    assert.ok(identity.startTime);
    const session = {
      info: { id: "pty_probe_eperm", status: "running" },
      proc: { pid: process.pid }, procIdentity: identity, isConfined: true
    } as unknown as ActivePtySession;
    const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
    const originalKill = process.kill;
    let signalled = false;
    Object.defineProperty(process, "platform", { value: "linux", configurable: true });
    process.kill = ((pid: number, signal?: NodeJS.Signals | number) => {
      assert.equal(pid, process.pid);
      if (signal === "SIGTERM") { signalled = true; return true; }
      if (signal === 0 && signalled) {
        const error = new Error("synthetic EPERM") as NodeJS.ErrnoException;
        error.code = "EPERM";
        throw error;
      }
      assert.equal(signal, 0, "No real signal may be sent to the test process");
      return originalKill.call(process, pid, 0);
    }) as typeof process.kill;
    try {
      requestCleanupFn(session, "exited", false);
      assert.equal(session.info.status, "cleanup_unverified");
      assert.equal(session.info.cleanupStatus, "unverified");
    } finally {
      process.kill = originalKill;
      Object.defineProperty(process, "platform", platformDescriptor);
    }
  }

  // K5: Real process lifecycle and termination
  // -------------------------------------------------------------------------
  console.log("--- K5: Real spawned PTY process termination ---");
  {
    const lease = ptyManager.start({
      command: "sleep 10",
      leaseMs: 5000
    });
    assert.ok(lease.pid > 0);
    const initialPoll = ptyManager.poll(lease.id);
    assert.equal(initialPoll.status, "running");

    // Call stop() to trigger verified termination
    ptyManager.stop(lease.id);

    const deadline = Date.now() + 3000;
    let finalPoll = ptyManager.poll(lease.id);
    while (Date.now() < deadline && (finalPoll.status === "cleanup_pending" || finalPoll.cleanupStatus === "pending")) {
      await new Promise((r) => setTimeout(r, 50));
      finalPoll = ptyManager.poll(lease.id);
    }

    if (process.platform === "linux") {
      assert.equal(
        finalPoll.status,
        "exited",
        "On Linux with bwrap kernel boundary, termination must verify cleanup"
      );
      assert.equal(finalPoll.cleanupStatus, "snapshot_cleared");

      let stillAlive = true;
      try {
        process.kill(lease.pid, 0);
      } catch (err: any) {
        if (err.code === "ESRCH") stillAlive = false;
      }
      assert.equal(stillAlive, false, "Target process must be confirmed reaped/dead");
    } else {
      assert.equal(
        finalPoll.status,
        "cleanup_unverified",
        "On macOS Darwin, unconfined PTY exit must report cleanup_unverified"
      );
      assert.equal(finalPoll.cleanupStatus, "unverified");
    }
    console.log("  [PASS] K5: Real process spawned and terminated cleanly.");
  }

  // -------------------------------------------------------------------------
  // K6: Real spawned PTY process natural exit
  // -------------------------------------------------------------------------
  console.log("--- K6: Real spawned PTY process natural exit ---");
  {
    const naturalLease = ptyManager.start({
      command: "echo test-k6-natural",
      leaseMs: 5000
    });
    assert.ok(naturalLease.pid > 0);
    await new Promise((r) => setTimeout(r, 200));

    const poll = ptyManager.poll(naturalLease.id);
    assert.equal(
      poll.status,
      "leader_exited",
      "Natural leader exit must be reported as leader_exited"
    );
    assert.equal(
      poll.cleanupStatus,
      "unverified",
      "Natural leader exit does not verify reparented descendants"
    );
    console.log("  [PASS] K6: Natural leader exit reported as leader_exited and unverified.");
  }

  ptyManager.dispose();
  passed = true;
  console.log("=== ALL BATCH K TESTS PASSED CLEANLY ===");
} finally {
  if (passed) fs.rmSync(ws, { recursive: true, force: true });
  else console.error(`Batch K failure evidence retained at: ${ws}`);
}

// A passing assertion set is not a passing suite if owned handles keep Node alive.
// This watchdog is unreferenced: it only runs if another resource prevents exit.
const exitWatchdog = setTimeout(() => {
  const node = process as typeof process & {
    _getActiveHandles(): Array<{ constructor: { name: string }; pid?: number; destroyed?: boolean; readable?: boolean; writable?: boolean }>;
  };
  const handles = node._getActiveHandles().map((handle) => ({
    type: handle.constructor.name,
    pid: handle.pid,
    destroyed: handle.destroyed,
    readable: handle.readable,
    writable: handle.writable
  }));
  const report = process.report.getReport() as { libuv?: Array<{ type?: string; is_referenced?: boolean; [key: string]: unknown }> };
  const referencedLibuv = report.libuv?.filter((handle) => handle.is_referenced) ?? [];
  console.error("BATCH_K_EXIT_TIMEOUT", JSON.stringify({ resources: process.getActiveResourcesInfo(), handles, referencedLibuv }));
  throw new Error("BATCH_K_EXIT_TIMEOUT: test assertions finished but the process did not exit");
}, 15_000);
exitWatchdog.unref();
