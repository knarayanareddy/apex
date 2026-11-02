/**
 * Batch H — Tool Admission Contract & Turn Bounding Verification (R03 & R04)
 * (`test/canaries/batchH-tool-admission.spec.ts`).
 *
 * Verifies:
 *  - H1: Authoritative default-deny tool allowlist and explicit denylist before WAL dispatch.
 *  - H2: Principal, workspace containment, and session identity binding.
 *  - H3: Nested execution depth bounding (depth 0, 1 permitted; depth >= 2 rejected fail-closed).
 *  - H4: Turn-level tool limits and cumulative session limits exhaustion.
 *  - H5: Immediate cancellation via AbortSignal and turn duration timeout.
 *  - H6: End-to-end integration with Ring 0 harness and WAL `ABORTED_CLEAN` recording.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  ToolAdmissionController,
  ToolAdmissionError
} from "../../src/core/tool-admission.ts";
import { createRing0Harness } from "../../src/core/ring0-session.ts";
import { StateDb } from "../../src/core/state-db.ts";

function setupWorkspace(testName: string): { ws: string; surfaces: string; cleanup: () => void } {
  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), `apex-batchH-${testName}-`));
  const ws = path.join(tmpBase, "ws");
  fs.mkdirSync(ws, { recursive: true });

  const surfaces = path.join(tmpBase, "surfaces");
  fs.mkdirSync(surfaces, { recursive: true });
  fs.writeFileSync(path.join(surfaces, "SYSTEM.md"), "You are Apex.");
  fs.writeFileSync(path.join(surfaces, "EXPERIENCE.md"), "# Experience\n");
  fs.writeFileSync(path.join(surfaces, "MEMORY.md"), "# Memory\n");
  fs.writeFileSync(path.join(surfaces, "AGENTS.md"), "# Agents\n");

  const cleanup = () => {
    try {
      fs.rmSync(tmpBase, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  };

  return { ws, surfaces, cleanup };
}

async function runBatchHTests(): Promise<void> {
  console.log("=== Running Batch H: Tool Admission Contract & Turn Bounds (R03 & R04) ===");

  // =========================================================================
  // H1: Authoritative Default-Deny Allowlist & Denylist
  // =========================================================================
  {
    console.log("--- H1: Default-deny allowlist & explicit denylist ---");
    const { ws, cleanup } = setupWorkspace("h1");
    try {
      const controller = new ToolAdmissionController({
        workspaceRoot: ws,
        sessionId: "session-h1",
        allowedTools: ["read", "codemode", "tool_search"],
        deniedTools: ["dangerous_raw_exec"]
      });

      // Allowed tool passes
      const readDecision = controller.admit({
        toolName: "read",
        toolCallId: "call_read_1"
      });
      assert.equal(readDecision.allowed, true);

      // Unadmitted tool fails closed
      const writeDecision = controller.admit({
        toolName: "write",
        toolCallId: "call_write_1"
      });
      assert.equal(writeDecision.allowed, false);
      assert.match(writeDecision.reason!, /TOOL_NOT_ADMITTED/);

      // Unknown tool fails closed
      const unknownDecision = controller.admit({
        toolName: "unknown_external_tool",
        toolCallId: "call_unknown_1"
      });
      assert.equal(unknownDecision.allowed, false);
      assert.match(unknownDecision.reason!, /TOOL_NOT_ADMITTED/);

      // Denied tool fails closed
      const deniedDecision = controller.admit({
        toolName: "dangerous_raw_exec",
        toolCallId: "call_denied_1"
      });
      assert.equal(deniedDecision.allowed, false);
      assert.match(deniedDecision.reason!, /TOOL_DENIED/);

      // assertAdmitted throws ToolAdmissionError
      assert.throws(
        () =>
          controller.assertAdmitted({
            toolName: "bash",
            toolCallId: "call_bash_1"
          }),
        (err: unknown) => {
          return (
            err instanceof ToolAdmissionError &&
            err.code === "TOOL_NOT_ADMITTED" &&
            err.toolName === "bash"
          );
        }
      );

      console.log("  [PASS] H1 verified: Default-deny allowlist and denylist enforced at host authority.");
    } finally {
      cleanup();
    }
  }

  // =========================================================================
  // H2: Principal, Workspace Containment & Session Binding
  // =========================================================================
  {
    console.log("--- H2: Principal, workspace containment & session binding ---");
    const { ws, cleanup } = setupWorkspace("h2");
    try {
      const controller = new ToolAdmissionController({
        workspaceRoot: ws,
        sessionId: "session-active-123"
      });

      // Valid session and workspace
      assert.equal(
        controller.admit({
          workspaceRoot: ws,
          sessionId: "session-active-123",
          toolName: "read",
          toolCallId: "call_1"
        }).allowed,
        true
      );

      // Mismatched workspace rejected
      const foreignWsDecision = controller.admit({
        workspaceRoot: "/private/var/folders/other-ws",
        sessionId: "session-active-123",
        toolName: "read",
        toolCallId: "call_2"
      });
      assert.equal(foreignWsDecision.allowed, false);
      assert.match(foreignWsDecision.reason!, /WORKSPACE_MISMATCH/);

      // Stale / mismatched session rejected
      const staleSessionDecision = controller.admit({
        workspaceRoot: ws,
        sessionId: "session-stale-999",
        toolName: "read",
        toolCallId: "call_3"
      });
      assert.equal(staleSessionDecision.allowed, false);
      assert.match(staleSessionDecision.reason!, /SESSION_MISMATCH/);

      // Switch session cleanly updates identity and allows subsequent valid calls
      controller.switchSession("session-switched-456");
      const switchedDecision = controller.admit({
        workspaceRoot: ws,
        sessionId: "session-switched-456",
        toolName: "read",
        toolCallId: "call_4"
      });
      assert.equal(switchedDecision.allowed, true);

      // Old session now rejected
      assert.equal(
        controller.admit({
          workspaceRoot: ws,
          sessionId: "session-active-123",
          toolName: "read",
          toolCallId: "call_5"
        }).allowed,
        false
      );

      // Authoritative default-deny when no allowlist is supplied: unexpected tools fail closed
      const unlistedDecision = controller.admit({
        workspaceRoot: ws,
        sessionId: "session-switched-456",
        toolName: "unexpected_malicious_tool",
        toolCallId: "call_unlisted"
      });
      assert.equal(unlistedDecision.allowed, false);
      assert.match(unlistedDecision.reason!, /TOOL_NOT_ADMITTED/);

      console.log("  [PASS] H2 verified: Workspace and session binding enforced strictly.");
    } finally {
      cleanup();
    }
  }

  // =========================================================================
  // H3: Nested Execution Depth Bounding (R04)
  // =========================================================================
  {
    console.log("--- H3: Nested execution depth bounding ---");
    const { ws, cleanup } = setupWorkspace("h3");
    try {
      const controller = new ToolAdmissionController({
        workspaceRoot: ws,
        sessionId: "session-h3",
        limits: { maxNestedDepth: 1 }
      });

      // Depth 0: Direct top-level call
      const d0 = controller.admit({
        toolName: "read",
        toolCallId: "call_root"
      });
      assert.equal(d0.allowed, true);
      assert.equal(d0.depth, 0);

      // Depth 1: Codemode sub-call
      const d1 = controller.admit({
        toolName: "read",
        toolCallId: "call_root/sub_0",
        parentToolCallId: "call_root"
      });
      assert.equal(d1.allowed, true);
      assert.equal(d1.depth, 1);

      // Depth 2: Disallowed recursive / sub-sub call
      const d2 = controller.admit({
        toolName: "read",
        toolCallId: "call_root/sub_0/sub_deep_1",
        parentToolCallId: "call_root/sub_0"
      });
      assert.equal(d2.allowed, false);
      assert.equal(d2.depth, 2);
      assert.match(d2.reason!, /NESTED_DEPTH_EXCEEDED/);

      console.log("  [PASS] H3 verified: Nested execution depth capped at configured bound.");
    } finally {
      cleanup();
    }
  }

  // =========================================================================
  // H4: Turn Tool Limits & Cumulative Session Limits (R04)
  // =========================================================================
  {
    console.log("--- H4: Turn & session limits exhaustion ---");
    const { ws, cleanup } = setupWorkspace("h4");
    try {
      const controller = new ToolAdmissionController({
        workspaceRoot: ws,
        sessionId: "session-h4",
        limits: {
          maxToolCallsPerTurn: 3,
          maxTotalToolCalls: 5
        }
      });

      // Turn 1: 3 calls admitted
      assert.equal(controller.admit({ toolName: "read", toolCallId: "c1" }).allowed, true);
      assert.equal(controller.admit({ toolName: "read", toolCallId: "c2" }).allowed, true);
      assert.equal(controller.admit({ toolName: "read", toolCallId: "c3" }).allowed, true);

      // Turn 1: 4th call exhausted
      const turnExhausted = controller.admit({ toolName: "read", toolCallId: "c4" });
      assert.equal(turnExhausted.allowed, false);
      assert.match(turnExhausted.reason!, /TURN_TOOL_LIMIT_EXCEEDED/);

      // Next turn: onTurnStart resets turn count
      controller.onTurnEnd();
      controller.onTurnStart();

      // Turn 2: 2 calls admitted (total session calls: 3 + 2 = 5)
      assert.equal(controller.admit({ toolName: "read", toolCallId: "c5" }).allowed, true);
      assert.equal(controller.admit({ toolName: "read", toolCallId: "c6" }).allowed, true);

      // Turn 2: 3rd call in turn 2 exceeds cumulative session limit (5)
      const sessionExhausted = controller.admit({ toolName: "read", toolCallId: "c7" });
      assert.equal(sessionExhausted.allowed, false);
      assert.match(sessionExhausted.reason!, /SESSION_TOOL_LIMIT_EXCEEDED/);

      console.log("  [PASS] H4 verified: Per-turn and cumulative session limits enforced.");
    } finally {
      cleanup();
    }
  }

  // =========================================================================
  // H5: Cancellation & Turn Duration Timeout
  // =========================================================================
  {
    console.log("--- H5: Cancellation & turn duration timeout ---");
    const { ws, cleanup } = setupWorkspace("h5");
    try {
      const controller = new ToolAdmissionController({
        workspaceRoot: ws,
        sessionId: "session-h5",
        limits: { maxTurnDurationMs: 50 }
      });

      // Pre-aborted signal rejected immediately
      const abortCtrl = new AbortController();
      abortCtrl.abort();
      const cancelDecision = controller.admit({
        toolName: "read",
        toolCallId: "c_cancel",
        signal: abortCtrl.signal
      });
      assert.equal(cancelDecision.allowed, false);
      assert.match(cancelDecision.reason!, /TOOL_EXECUTION_CANCELLED/);

      // Turn timeout: wait 60ms to exceed 50ms limit
      await new Promise((resolve) => setTimeout(resolve, 60));
      const timeoutDecision = controller.admit({
        toolName: "read",
        toolCallId: "c_timeout"
      });
      assert.equal(timeoutDecision.allowed, false);
      assert.match(timeoutDecision.reason!, /TURN_TIMEOUT_EXCEEDED/);

      console.log("  [PASS] H5 verified: Cancellation and duration timeouts enforced.");
    } finally {
      cleanup();
    }
  }

  // =========================================================================
  // H6: Ring 0 Harness Integration & WAL ABORTED_CLEAN Invariant
  // =========================================================================
  {
    console.log("--- H6: Ring 0 harness integration & WAL ABORTED_CLEAN recording ---");
    const { ws, surfaces, cleanup } = setupWorkspace("h6");
    try {
      const harness = await createRing0Harness({
        workspaceRoot: ws,
        surfacesDir: surfaces,
        allowUnsandboxedDev: true,
        allowedTools: ["read"] // Restrict to only "read"
      });

      try {
        const readTool = harness.session.agent.state.tools.find((t) => t.name === "read");
        assert.ok(readTool, "read tool must exist");

        const writeTool = harness.session.agent.state.tools.find((t) => t.name === "write");
        assert.ok(writeTool, "write tool must exist in registry");

        // Permitted call succeeds through WAL spine
        fs.writeFileSync(path.join(ws, "hello.txt"), "apex-test");
        const readRes = await readTool.execute("call_ok", { path: "hello.txt" });
        assert.equal(Boolean(readRes.isError), false);

        // Denied call rejected fail-closed before mutation
        await assert.rejects(
          () => writeTool.execute("call_blocked", { path: "unauthorized.txt", content: "forbidden" }),
          (err: unknown) => {
            return (
              err instanceof ToolAdmissionError &&
              err.code === "TOOL_NOT_ADMITTED" &&
              err.toolName === "write"
            );
          }
        );

        // Verify unauthorized file was NEVER written to disk
        assert.equal(fs.existsSync(path.join(ws, "unauthorized.txt")), false);

        // Verify WAL intent was recorded as ABORTED_CLEAN
        const rows = harness.stateDb.db
          .prepare(`SELECT status, tool_name, error_text FROM wal_intents WHERE tool_name = 'write'`)
          .all() as Array<{ status: string; tool_name: string; error_text: string }>;

        assert.ok(rows.length > 0, "WAL row for denied write must exist");
        assert.equal(rows[0]!.status, "ABORTED_CLEAN");
        assert.match(rows[0]!.error_text, /TOOL_NOT_ADMITTED/);

        console.log("  [PASS] H6 verified: Denied action produces ABORTED_CLEAN in WAL and zero side effects.");
      } finally {
        harness.dispose();
      }
    } finally {
      cleanup();
    }
  }

  // =========================================================================
  // H7: Public-Path Default-Deny & Nested Bound Negative Regression
  // =========================================================================
  {
    console.log("--- H7: Default harness unconfigured allowlist & nested depth rejection ---");
    const { ws, surfaces, cleanup } = setupWorkspace("h7");
    try {
      const harness = await createRing0Harness({
        workspaceRoot: ws,
        surfacesDir: surfaces,
        allowUnsandboxedDev: true
        // Note: NO allowedTools specified; authoritative default-deny must still guard unrecognized tools!
      });

      try {
        // 1. Registered tools are permitted
        assert.equal(harness.admissionController.isToolAllowed("read"), true);
        assert.equal(harness.admissionController.isToolAllowed("bash"), true);
        assert.equal(harness.admissionController.isToolAllowed("write"), true);
        assert.equal(harness.admissionController.isToolAllowed("edit"), true);
        assert.equal(harness.admissionController.isToolAllowed("codemode"), true);

        // 2. Unregistered/injected tool fails closed with TOOL_NOT_ADMITTED
        assert.equal(harness.admissionController.isToolAllowed("unauthorized_shell_injector"), false);
        const deniedDecision = harness.admissionController.admit({
          toolName: "unauthorized_shell_injector",
          toolCallId: "call_inj_1"
        });
        assert.equal(deniedDecision.allowed, false);
        assert.match(deniedDecision.reason!, /TOOL_NOT_ADMITTED/);

        // assertAdmitted throws ToolAdmissionError
        assert.throws(
          () =>
            harness.admissionController.assertAdmitted({
              toolName: "unauthorized_shell_injector",
              toolCallId: "call_inj_2"
            }),
          (err: unknown) =>
            err instanceof ToolAdmissionError &&
            err.code === "TOOL_NOT_ADMITTED" &&
            err.toolName === "unauthorized_shell_injector"
        );

        // 3. Nested tool execution exceeding depth limit (depth 2) fails closed
        const nestedExceeded = harness.admissionController.admit({
          toolName: "read",
          toolCallId: "call_top/sub_1/sub_deep_2",
          parentToolCallId: "call_top/sub_1"
        });
        assert.equal(nestedExceeded.allowed, false);
        assert.equal(nestedExceeded.depth, 2);
        assert.match(nestedExceeded.reason!, /NESTED_DEPTH_EXCEEDED/);

        assert.throws(
          () =>
            harness.admissionController.assertAdmitted({
              toolName: "read",
              toolCallId: "call_top/sub_1/sub_deep_2",
              parentToolCallId: "call_top/sub_1"
            }),
          (err: unknown) =>
            err instanceof ToolAdmissionError &&
            err.code === "NESTED_DEPTH_EXCEEDED"
        );

        console.log("  [PASS] H7 verified: Default harness enforces default-deny and rejects nested depth > 1.");
      } finally {
        harness.dispose();
      }
    } finally {
      cleanup();
    }
  }

  console.log("\n=== ALL BATCH H TOOL ADMISSION TESTS PASSED CLEANLY ===");
}

runBatchHTests().catch((err) => {
  console.error("Batch H FAILED:", err);
  process.exit(1);
});
