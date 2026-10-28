/**
 * End-to-End Security Canary Regression Suite (`test/canaries/security-canaries.spec.ts`)
 *
 * Verifies all 5 Critical Security Boundaries with strict dual controls:
 *   (A) Negative denial canary: confirms that violations / attacks fail closed.
 *   (B) Positive permitted control: confirms that authorized actions succeed cleanly.
 *
 * Boundaries:
 *  1. Cockpit Access Path, Token/Cookie Auth & DNS Rebinding Protection
 *  2. macOS Darwin Fail-Closed Confinement & Unconfined Dev Warnings
 *  3. BugBot & CI Engine Monotonic Containment & Read-Only CI Gate
 *  4. Workspace Read-Only Mutation Barrier & Tool Call Resolution Gate
 *  5. Operation WAL Spine Execution, Idempotency & Post-Commit Disk Hash Drift
 */

import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  createBwrapBashOperations,
  probeBwrapFunctional,
  resetBwrapProbeCacheForTesting,
  SandboxUnavailableError
} from "../../src/core/bwrap-sandbox.ts";
import { loadVerifiedGuardrails } from "../../src/core/guardrail-pin.ts";
import {
  createConfinedFileOperations,
  GuardDeniedError,
  resolveAndValidateWorkspacePath
} from "../../src/core/monotonic-guard.ts";
import { createRing0Harness } from "../../src/core/ring0-session.ts";
import { PathContainmentError } from "../../src/core/safe-path.ts";
import { PrivateSpillStore } from "../../src/core/spill-store.ts";
import { StateDb } from "../../src/core/state-db.ts";
import {
  assertNoUnresolvedOutcomeUnknown,
  computeBytesSha256,
  computeFileContentSha256,
  executeThroughWalSpine,
  markWalCallTreeTranscriptAppended,
  OutcomeUnknownLockError
} from "../../src/core/wal-recovery.ts";
import { BugBotAndCiEngine } from "../../src/ring2/bugbot-ci-loop.ts";
import { PtyLeaseManager } from "../../src/ring2/pty-cron-routines.ts";
import { createRing4Runtime } from "../../src/ring4/ring4-runtime.ts";
import { MissionControlServer } from "../../src/ring5/mission-control-server.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..");
const SURFACES_DIR = path.join(REPO_ROOT, "surfaces");

function createTmpWorkspace(prefix: string): { ws: string; surfaces: string; agentDir: string } {
  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), `pi-apex-canary-${prefix}-`));
  const ws = path.join(tmpBase, "repo");
  const surfaces = path.join(tmpBase, "surfaces");
  const agentDir = path.join(tmpBase, "agent");
  fs.mkdirSync(ws, { recursive: true });
  fs.mkdirSync(surfaces, { recursive: true });
  fs.mkdirSync(agentDir, { recursive: true, mode: 0o700 });

  for (const f of ["SYSTEM.md", "TOOL_GUIDANCE.md", "MEMORY.md", "EXPERIENCE.md", "SUBAGENTS.yaml"]) {
    const src = path.join(SURFACES_DIR, f);
    if (fs.existsSync(src)) {
      fs.copyFileSync(src, path.join(surfaces, f));
    }
  }
  fs.writeFileSync(path.join(ws, "AGENTS.md"), "# Canary Test Repo\n", "utf8");
  return { ws, surfaces, agentDir };
}

async function runHttpRequest(params: {
  url: string;
  method: string;
  headers?: Record<string, string>;
  body?: string;
}): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  const u = new URL(params.url);
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: u.hostname,
        port: u.port,
        path: u.pathname + u.search,
        method: params.method,
        headers: params.headers
      },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          body += chunk;
        });
        res.on("end", () => {
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body
          });
        });
      }
    );
    req.on("error", reject);
    if (params.body) req.write(params.body);
    req.end();
  });
}

async function main(): Promise<void> {
  const t0 = performance.now();
  console.log("================================================================================");
  console.log("Running Pi-Apex 5-Boundary Security Canaries & Dual Controls");
  console.log("================================================================================");

  const checks: string[] = [];

  // ===========================================================================
  // Boundary 1: Cockpit HTTP & SSE Authentication + DNS Rebinding & Origin Protection
  // ===========================================================================
  {
    console.log("\n[Boundary 1] Testing Cockpit Access Paths, Token/Cookie Auth & DNS Rebinding...");
    const { ws, surfaces, agentDir } = createTmpWorkspace("b1-cockpit");
    const controller = await createRing4Runtime({
      workspaceRoot: ws,
      surfacesDir: surfaces,
      agentDir,
      allowUnsandboxedDev: true
    });

    // 1A (0) Default construction canary: zero auth options provided (requireAuth defaults true, token auto-generated)
    const defaultServer = new MissionControlServer({
      controller,
      workspaceRoot: ws,
      port: 0
    });
    const defaultInfo = await defaultServer.start();
    try {
      const defaultUnauthPost = await runHttpRequest({
        url: `${defaultInfo.url}/api/plan/toggle`,
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: true })
      });
      assert.equal(
        defaultUnauthPost.status,
        401,
        "Default MissionControlServer construction must reject unauthenticated POST with 401"
      );
      const defaultAuthPost = await runHttpRequest({
        url: `${defaultInfo.url}/api/plan/toggle`,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${defaultInfo.token}`
        },
        body: JSON.stringify({ enabled: true })
      });
      assert.equal(
        defaultAuthPost.status,
        200,
        "Default MissionControlServer construction must permit POST with generated token"
      );
    } finally {
      await defaultServer.stop();
    }

    const canaryToken = "canary-auth-secret-token-" + crypto.randomBytes(16).toString("hex");
    const server = new MissionControlServer({
      controller,
      workspaceRoot: ws,
      host: "127.0.0.1",
      port: 0,
      authToken: canaryToken,
      requireAuth: true
    });
    const info = await server.start();
    const baseUrl = `http://127.0.0.1:${info.port}`;

    try {
      // 1A (i) Negative Denial Canary: Unauthenticated POST to /api/plan/toggle -> 401
      const unauthPost = await runHttpRequest({
        url: `${baseUrl}/api/plan/toggle`,
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: true })
      });
      assert.equal(unauthPost.status, 401, "Unauthenticated POST /api/plan/toggle must return 401");
      const unauthPostJson = JSON.parse(unauthPost.body);
      assert.ok(unauthPostJson.error && unauthPostJson.error.includes("Unauthorized"));

      // 1A (ii) Negative Denial Canary: Unauthenticated GET to /api/status -> 401
      const unauthGet = await runHttpRequest({
        url: `${baseUrl}/api/status`,
        method: "GET"
      });
      assert.equal(unauthGet.status, 401, "Unauthenticated GET /api/status must return 401");

      // 1A (iii) Negative Denial Canary: Unauthenticated GET to /api/events (SSE) -> 401
      const unauthSse = await runHttpRequest({
        url: `${baseUrl}/api/events`,
        method: "GET"
      });
      assert.equal(unauthSse.status, 401, "Unauthenticated SSE /api/events must return 401");

      // 1A (iv) Negative Denial Canary: DNS Rebinding attack with malicious Host header -> 403
      const rebindingAttack = await runHttpRequest({
        url: `${baseUrl}/api/status`,
        method: "GET",
        headers: {
          Host: "attacker-controlled-domain.evil",
          Authorization: `Bearer ${canaryToken}`
        }
      });
      assert.equal(rebindingAttack.status, 403, "DNS rebinding Host header must return 403");

      // 1A (v) Negative Denial Canary: Malicious Cross-Origin header does NOT get wildcard access
      const corsAttack = await runHttpRequest({
        url: `${baseUrl}/api/status`,
        method: "OPTIONS",
        headers: {
          Origin: "http://attacker-controlled.site"
        }
      });
      assert.notEqual(corsAttack.headers["access-control-allow-origin"], "*", "Wildcard CORS must never be returned");
      assert.notEqual(
        corsAttack.headers["access-control-allow-origin"],
        "http://attacker-controlled.site",
        "Disallowed origin must not receive Access-Control-Allow-Origin header"
      );

      // 1B (i) Positive Permitted Control: Authenticated POST with Bearer token -> 200
      const authPost = await runHttpRequest({
        url: `${baseUrl}/api/plan/toggle`,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${canaryToken}`
        },
        body: JSON.stringify({ enabled: true })
      });
      assert.equal(authPost.status, 200, "Authenticated POST with Bearer token must return 200");
      const authPostJson = JSON.parse(authPost.body);
      assert.equal(authPostJson.planModeActive, true);

      // 1B (ii) Positive Permitted Control: Authenticated GET /api/status with Bearer token -> 200
      const authStatus = await runHttpRequest({
        url: `${baseUrl}/api/status`,
        method: "GET",
        headers: {
          Authorization: `Bearer ${canaryToken}`
        }
      });
      assert.equal(authStatus.status, 200, "Authenticated GET /api/status with Bearer token must return 200");

      // 1B (iii) Positive Permitted Control: Browser Handshake /?token=... sets HttpOnly cookie & redirects
      const handshakeRes = await runHttpRequest({
        url: `${baseUrl}/?token=${canaryToken}`,
        method: "GET"
      });
      assert.equal(handshakeRes.status, 302, "Handshake GET /?token=... must return 302 redirect");
      const setCookie = handshakeRes.headers["set-cookie"]?.[0] ?? "";
      assert.ok(setCookie.includes("apex_session=" + canaryToken), "Must set apex_session cookie with token");
      assert.ok(setCookie.includes("HttpOnly"), "Session cookie must have HttpOnly flag");
      assert.ok(setCookie.includes("SameSite=Strict"), "Session cookie must have SameSite=Strict flag");
      assert.equal(handshakeRes.headers["location"], "/", "Must redirect to / to strip token from URL");

      // 1B (iv) Positive Permitted Control: Authenticated SSE /api/events with Cookie -> 200
      const cookieSse = await new Promise<{ status: number; connectedFrame: string }>((resolve, reject) => {
        const req = http.request(
          {
            hostname: "127.0.0.1",
            port: info.port,
            path: "/api/events",
            method: "GET",
            headers: {
              Cookie: `apex_session=${canaryToken}`
            }
          },
          (res) => {
            let buf = "";
            res.setEncoding("utf8");
            res.on("data", (chunk) => {
              buf += chunk;
              if (buf.includes("data:")) {
                res.destroy();
                resolve({ status: res.statusCode ?? 0, connectedFrame: buf });
              }
            });
          }
        );
        req.on("error", (err) => {
          if ((err as any).code === "ECONNRESET") return;
          reject(err);
        });
        req.end();
      });
      assert.equal(cookieSse.status, 200, "Cookie-authenticated SSE stream must return 200");
      assert.ok(cookieSse.connectedFrame.includes("connected"), "SSE stream must yield connected frame");

      checks.push("Boundary 1: Cockpit Token/Cookie Auth + Rebinding 403 + SSE Cookie Gate: PASS");
      console.log("  [PASS] Boundary 1 verified (5 negative denials + 4 positive controls).");
    } finally {
      await server.stop();
      await controller.dispose();
    }
  }

  // ===========================================================================
  // Boundary 2: macOS Darwin Fail-Closed Confinement & Unconfined Dev Warnings
  // ===========================================================================
  {
    console.log("\n[Boundary 2] Testing Darwin Fail-Closed Execution & Dev Override...");
    const { ws } = createTmpWorkspace("b2-darwin");
    resetBwrapProbeCacheForTesting();

    // 2A. Negative Denial Canary: On Darwin with allowUnsandboxedDev: false -> SandboxUnavailableError
    if (process.platform === "darwin") {
      const strictBashOps = createBwrapBashOperations({
        workspaceRoot: ws,
        mode: "workspace-write",
        unshareNet: true,
        allowUnsandboxedDev: false
      });

      let strictThrew = false;
      try {
        await strictBashOps.exec("echo 'should-not-run'", ws, {
          onData: () => {}
        });
      } catch (err) {
        strictThrew = true;
        assert.ok(
          err instanceof SandboxUnavailableError,
          `Expected SandboxUnavailableError, got ${String(err)}`
        );
        assert.ok(
          (err as Error).message.includes("bubblewrap is not supported on macOS darwin") ||
            (err as Error).message.includes("SANDBOX_UNAVAILABLE"),
          "Error message must clearly identify darwin confinement limitation"
        );
      }
      assert.equal(strictThrew, true, "Darwin bash must fail closed when allowUnsandboxedDev: false");

      // 2A (ii) Pre-dispatch confinement refusal in WAL: Darwin refusal records ABORTED_CLEAN, not OUTCOME_UNKNOWN
      const walDir = path.join(ws, ".harness");
      fs.mkdirSync(walDir, { recursive: true });
      const b2StateDb = new StateDb(path.join(walDir, "b2-state.db"), "crash-safe");
      const b2SpillStore = new PrivateSpillStore({
        rootDir: path.join(walDir, "spill"),
        maxInlineBytes: 1024,
        maxInlineLines: 100,
        previewBytes: 256,
        cleanupDays: 7
      });

      let b2WalThrew = false;
      try {
        await executeThroughWalSpine({
          stateDb: b2StateDb,
          spillStore: b2SpillStore,
          sessionId: "session-canary-b2",
          leafId: "leaf-b2-0",
          toolCallId: "call_b2_strict_bash",
          toolName: "bash",
          mutabilityClass: "OPAQUE_EXTERNAL",
          args: { command: "echo 'blocked'" },
          executeEffect: async () => {
            await strictBashOps.exec("echo 'blocked'", ws, { onData: () => {} });
            return { rawText: "blocked" };
          }
        });
      } catch (err) {
        b2WalThrew = true;
        assert.ok(err instanceof SandboxUnavailableError);
      }
      assert.equal(b2WalThrew, true, "executeThroughWalSpine must rethrow SandboxUnavailableError");

      const b2Rows = b2StateDb.db
        .prepare("SELECT status, error_text FROM wal_intents WHERE tool_call_id = 'call_b2_strict_bash'")
        .all() as Array<{ status: string; error_text: string }>;
      assert.equal(b2Rows.length, 1);
      assert.equal(b2Rows[0].status, "ABORTED_CLEAN", "Confinement refusal must be recorded as ABORTED_CLEAN");
      assert.ok(b2Rows[0].error_text.includes("SANDBOX_UNAVAILABLE"));

      // Verify session is NOT locked and subsequent read proceeds cleanly
      assertNoUnresolvedOutcomeUnknown(b2StateDb, "session-canary-b2");
      const b2ReadRes = await executeThroughWalSpine({
        stateDb: b2StateDb,
        spillStore: b2SpillStore,
        sessionId: "session-canary-b2",
        leafId: "leaf-b2-0",
        toolCallId: "call_b2_subsequent_read",
        toolName: "read",
        mutabilityClass: "PURE_READ",
        args: { path: "AGENTS.md" },
        executeEffect: async () => ({ rawText: "read-succeeded-ok" })
      });
      assert.equal(b2ReadRes.finalText, "read-succeeded-ok");
      b2StateDb.close();

      // 2B. Positive Permitted Control: On Darwin with allowUnsandboxedDev: true -> executes with visible warning
      const devBashOps = createBwrapBashOperations({
        workspaceRoot: ws,
        mode: "workspace-write",
        unshareNet: true,
        allowUnsandboxedDev: true
      });

      let collectedOutput = "";
      const result = await devBashOps.exec("echo 'darwin-control-ok'", ws, {
        onData: (data) => {
          collectedOutput += data.toString();
        }
      });
      assert.equal(result.exitCode, 0, "allowUnsandboxedDev: true must permit execution on darwin");
      assert.ok(collectedOutput.includes("darwin-control-ok"), "Command output must be delivered");

      checks.push("Boundary 2: macOS Darwin Fail-Closed Denial + Dev Override Execution: PASS");
      console.log("  [PASS] Boundary 2 verified (fail-closed denial + permitted dev control).");
    } else {
      checks.push("Boundary 2: Non-darwin platform (skipped darwin-specific probe): PASS");
      console.log("  [SKIP] Boundary 2 darwin checks on non-darwin OS.");
    }
  }

  // ===========================================================================
  // Boundary 3: BugBot & CI Engine Monotonic Containment & Read-Only CI Gate
  // ===========================================================================
  {
    console.log("\n[Boundary 3] Testing CI Engine Read-Only Mode & Path Containment...");
    const { ws } = createTmpWorkspace("b3-ci");
    const { config: guardrails } = loadVerifiedGuardrails();
    const stateDb = new StateDb(path.join(ws, ".harness", "state.db"), "crash-safe");

    const bashOps = createBwrapBashOperations({
      workspaceRoot: ws,
      mode: "workspace-write",
      unshareNet: true,
      allowUnsandboxedDev: true
    });

    // 3A (i) Negative Denial Canary: CI execution denied in read-only sandbox mode
    const readOnlyCiEngine = new BugBotAndCiEngine({
      workspaceRoot: ws,
      db: stateDb.db,
      guardrails,
      bashOps,
      sandboxMode: "read-only"
    });

    let readOnlyCiBlocked = false;
    try {
      await readOnlyCiEngine.runCiVerificationLoop({
        command: "echo 'illegal-ci-run'",
        maxAttempts: 1
      });
    } catch (err) {
      readOnlyCiBlocked = true;
      assert.ok(
        (err as Error).message.includes("CI execution denied in read-only sandbox mode") ||
          (err as Error).message.includes("CI_COMMAND_DENIED"),
        `Expected CI_COMMAND_DENIED, got: ${(err as Error).message}`
      );
    }
    assert.equal(readOnlyCiBlocked, true, "CI engine must reject commands in read-only sandbox mode");

    // 3A (ii) Negative Denial Canary: Path containment boundary blocks paths outside workspace
    let pathOutsideBlocked = false;
    try {
      resolveAndValidateWorkspacePath("/etc/passwd", ws, "read", guardrails);
    } catch (err) {
      pathOutsideBlocked = true;
      assert.ok(
        err instanceof PathContainmentError || err instanceof GuardDeniedError,
        `Expected path containment error, got: ${String(err)}`
      );
    }
    assert.equal(pathOutsideBlocked, true, "Path outside workspace must be blocked by containment guard");

    // 3A (iii) Negative Denial Canary: learnReviewRule denied in read-only mode (cannot modify REVIEW_RULES.md)
    let learnRuleBlocked = false;
    try {
      readOnlyCiEngine.learnReviewRule({
        id: "NO_TAMPER",
        title: "Block Tampering",
        glob: "**/*",
        forbiddenPattern: "tamper",
        body: "Never tamper",
        priority: 1
      });
    } catch (err) {
      learnRuleBlocked = true;
      assert.ok(err instanceof GuardDeniedError, `Expected GuardDeniedError, got ${String(err)}`);
      assert.ok((err as Error).message.includes("read-only sandbox mode"));
    }
    assert.equal(learnRuleBlocked, true, "learnReviewRule must throw GuardDeniedError in read-only sandbox mode");
    assert.equal(fs.existsSync(path.join(ws, "REVIEW_RULES.md")), false, "REVIEW_RULES.md must NOT be created");

    // 3A (iv) Negative Denial Canary: PTY lease manager denies process start in read-only mode
    const ptyManagerReadOnly = new PtyLeaseManager({
      workspaceRoot: ws,
      guardrails,
      sandboxMode: "read-only",
      allowUnsandboxedDev: true
    });
    let ptyReadOnlyBlocked = false;
    try {
      ptyManagerReadOnly.start({ command: "echo pty-test" });
    } catch (err) {
      ptyReadOnlyBlocked = true;
      assert.ok(err instanceof GuardDeniedError, `Expected GuardDeniedError, got ${String(err)}`);
      assert.ok((err as Error).message.includes("PTY_COMMAND_DENIED"));
    }
    assert.equal(ptyReadOnlyBlocked, true, "PTY start must be denied in read-only mode");

    // 3A (v) Negative Denial Canary: PTY lease manager fails closed on Darwin without allowUnsandboxedDev
    if (process.platform === "darwin") {
      const ptyManagerStrict = new PtyLeaseManager({
        workspaceRoot: ws,
        guardrails,
        sandboxMode: "workspace-write",
        allowUnsandboxedDev: false
      });
      let ptyStrictBlocked = false;
      try {
        ptyManagerStrict.start({ command: "echo pty-darwin-strict" });
      } catch (err) {
        ptyStrictBlocked = true;
        assert.ok(err instanceof SandboxUnavailableError, `Expected SandboxUnavailableError, got ${String(err)}`);
      }
      assert.equal(ptyStrictBlocked, true, "PTY start must fail closed on darwin without allowUnsandboxedDev");
    }

    // 3B. Positive Permitted Control: CI execution permitted in workspace-write mode
    const permittedCiEngine = new BugBotAndCiEngine({
      workspaceRoot: ws,
      db: stateDb.db,
      guardrails,
      bashOps,
      sandboxMode: "workspace-write"
    });

    const ciResult = await permittedCiEngine.runCiVerificationLoop({
      command: "echo 'ci-verification-success'",
      maxAttempts: 1
    });
    assert.equal(ciResult.passed, true, "CI command within workspace in workspace-write mode must pass");
    assert.ok(ciResult.attempts[0].stdout.includes("ci-verification-success"));

    stateDb.close();
    checks.push("Boundary 3: BugBot CI Read-Only Gate + Path Containment + Permitted Run: PASS");
    console.log("  [PASS] Boundary 3 verified (read-only denial + path containment + permitted CI run).");
  }

  // ===========================================================================
  // Boundary 4: Workspace Read-Only Mutation Barrier & Tool Call Resolution Gate
  // ===========================================================================
  {
    console.log("\n[Boundary 4] Testing Read-Only Mode Mutation & Tool Interception Gates...");
    const { ws, surfaces } = createTmpWorkspace("b4-readonly");
    const { config: guardrails } = loadVerifiedGuardrails();

    // 4A (i) Negative Denial Canary: File operations mutation boundary throws in read-only mode
    const confinedOps = createConfinedFileOperations({
      workspaceRoot: ws,
      cfg: guardrails,
      durabilityMode: "crash-safe",
      mode: "read-only"
    });

    let writeBlocked = false;
    try {
      await confinedOps.writeOps.writeFile(path.join(ws, "forbidden.txt"), "should-not-write");
    } catch (err) {
      writeBlocked = true;
      assert.ok(err instanceof GuardDeniedError, `Expected GuardDeniedError, got: ${String(err)}`);
      assert.ok((err as Error).message.includes("read-only sandbox mode"));
    }
    assert.equal(writeBlocked, true, "writeOps.writeFile must fail in read-only mode");

    let mkdirBlocked = false;
    try {
      await confinedOps.writeOps.mkdir(path.join(ws, "forbidden-dir"));
    } catch (err) {
      mkdirBlocked = true;
      assert.ok(err instanceof GuardDeniedError, `Expected GuardDeniedError, got: ${String(err)}`);
      assert.ok((err as Error).message.includes("read-only sandbox mode"));
    }
    assert.equal(mkdirBlocked, true, "writeOps.mkdir must fail in read-only mode");

    // 4A (ii) Negative Denial Canary: Tool call interceptor blocks write in read-only mode
    let pathResolveBlocked = false;
    try {
      resolveAndValidateWorkspacePath("forbidden.txt", ws, "write", guardrails, "read-only");
    } catch (err) {
      pathResolveBlocked = true;
      assert.ok(err instanceof GuardDeniedError, `Expected GuardDeniedError, got: ${String(err)}`);
      assert.ok((err as Error).message.includes("write access denied in read-only sandbox mode"));
    }
    assert.equal(pathResolveBlocked, true, "resolveAndValidateWorkspacePath must deny write access in read-only mode");

    // 4B. Positive Permitted Control: File operations in workspace-write mode succeed
    const permittedOps = createConfinedFileOperations({
      workspaceRoot: ws,
      cfg: guardrails,
      durabilityMode: "crash-safe",
      mode: "workspace-write"
    });

    await permittedOps.writeOps.writeFile(path.join(ws, "permitted.txt"), "permitted-content-ok");
    assert.equal(fs.existsSync(path.join(ws, "permitted.txt")), true, "File must be created on disk");
    const readBack = await permittedOps.readOps.readFile(path.join(ws, "permitted.txt"));
    assert.equal(readBack.toString("utf8"), "permitted-content-ok");

    checks.push("Boundary 4: Workspace Read-Only Mutation Gate + Tool Resolver Gate + Write Control: PASS");
    console.log("  [PASS] Boundary 4 verified (mutation denial + resolver gate + permitted write control).");
  }

  // ===========================================================================
  // Boundary 5: Operation WAL Spine Execution, Idempotency & Post-Commit Hash Drift
  // ===========================================================================
  {
    console.log("\n[Boundary 5] Testing Operation WAL Spine, Idempotency & Post-Commit Drift...");
    const { ws } = createTmpWorkspace("b5-wal");
    const harnessDir = path.join(ws, ".harness");
    fs.mkdirSync(harnessDir, { recursive: true });
    const stateDb = new StateDb(path.join(harnessDir, "state.db"), "crash-safe");
    const spillStore = new PrivateSpillStore({
      rootDir: path.join(harnessDir, "spill"),
      maxInlineBytes: 1024,
      maxInlineLines: 100,
      previewBytes: 256,
      cleanupDays: 7
    });

    const targetFile = path.join(ws, "wal-target.txt");
    const initialContent = "step-1: initial verified payload";
    const initialBytes = Buffer.from(initialContent, "utf8");

    // 5B (i) Positive Permitted Control: executeThroughWalSpine transitions INTENT_LOGGED -> EXECUTING -> EFFECT_COMMITTED
    let effectExecutionCount = 0;
    const walRes1 = await executeThroughWalSpine({
      stateDb,
      spillStore,
      sessionId: "session-canary-wal",
      leafId: "leaf-canary-0",
      toolCallId: "call_wal_step_1",
      toolName: "write",
      mutabilityClass: "LOCAL_REVERSIBLE",
      args: { path: "wal-target.txt", content: initialContent },
      localReversibleSpec: {
        targetPath: targetFile,
        expectedAfterBytes: initialBytes
      },
      executeEffect: async () => {
        effectExecutionCount += 1;
        fs.writeFileSync(targetFile, initialBytes);
        return { rawText: `Wrote ${initialBytes.length} bytes to wal-target.txt` };
      }
    });

    assert.equal(effectExecutionCount, 1);
    assert.equal(walRes1.fromCache, false);
    const walRow1 = stateDb.getWalRow(walRes1.idempotencyKey)!;
    assert.equal(walRow1.status, "EFFECT_COMMITTED");
    assert.equal(walRow1.after_content_sha256, computeBytesSha256(initialBytes));

    // Assert zero unresolved outcome-unknown rows on healthy completion
    assertNoUnresolvedOutcomeUnknown(stateDb, "session-canary-wal");

    // 5B (ii) Positive Permitted Control: Replaying unchanged tool call returns fromCache: true
    const walReplay = await executeThroughWalSpine({
      stateDb,
      spillStore,
      sessionId: "session-canary-wal",
      leafId: "leaf-canary-0",
      toolCallId: "call_wal_step_1",
      toolName: "write",
      mutabilityClass: "LOCAL_REVERSIBLE",
      args: { path: "wal-target.txt", content: initialContent },
      localReversibleSpec: {
        targetPath: targetFile,
        expectedAfterBytes: initialBytes
      },
      executeEffect: async () => {
        effectExecutionCount += 1;
        throw new Error("SHOULD_NOT_EXECUTE: must return from idempotency cache");
      }
    });
    assert.equal(walReplay.fromCache, true, "Idempotency cache hit must return cached result");
    assert.equal(effectExecutionCount, 1, "Effect must NOT be re-executed on idempotency hit");

    // 5B (iii) Positive Permitted Control: Nested tool execution stores parent_tool_call_id and completes to TRANSCRIPT_APPENDED
    const rootCallId = "audit-3";
    const nestedCallId = "audit-3/1";
    const rootRes = await executeThroughWalSpine({
      stateDb,
      spillStore,
      sessionId: "session-canary-wal",
      leafId: "leaf-canary-0",
      toolCallId: rootCallId,
      parentToolCallId: null,
      toolName: "batch_execute",
      mutabilityClass: "PURE_READ",
      args: { actions: ["read"] },
      executeEffect: async () => ({ rawText: "root executed" })
    });
    const nestedRes = await executeThroughWalSpine({
      stateDb,
      spillStore,
      sessionId: "session-canary-wal",
      leafId: "leaf-canary-0",
      toolCallId: nestedCallId,
      parentToolCallId: "audit-3",
      toolName: "read",
      mutabilityClass: "PURE_READ",
      args: { path: "AGENTS.md" },
      executeEffect: async () => ({ rawText: "nested executed" })
    });

    const rootRowBefore = stateDb.getWalRow(rootRes.idempotencyKey)!;
    const nestedRowBefore = stateDb.getWalRow(nestedRes.idempotencyKey)!;
    assert.equal(rootRowBefore.parent_tool_call_id, null);
    assert.equal(nestedRowBefore.parent_tool_call_id, "audit-3", "Nested tool call must record parent_tool_call_id in WAL");
    assert.equal(rootRowBefore.status, "EFFECT_COMMITTED");
    assert.equal(nestedRowBefore.status, "EFFECT_COMMITTED");

    // Calling markWalCallTreeTranscriptAppended on the root call ID marks both root and all descendants
    markWalCallTreeTranscriptAppended(stateDb, "session-canary-wal", rootCallId, rootRes.idempotencyKey);

    const rootRowAfter = stateDb.getWalRow(rootRes.idempotencyKey)!;
    const nestedRowAfter = stateDb.getWalRow(nestedRes.idempotencyKey)!;
    assert.equal(rootRowAfter.status, "TRANSCRIPT_APPENDED", "Root tool call must transition to TRANSCRIPT_APPENDED");
    assert.equal(nestedRowAfter.status, "TRANSCRIPT_APPENDED", "Nested descendant tool call must transition to TRANSCRIPT_APPENDED");

    // 5A (i) Negative Denial Canary: Tamper with disk post-commit -> drift triggers OUTCOME_UNKNOWN lock!
    fs.writeFileSync(targetFile, "tampered-content-by-unconfined-actor");

    let driftDetected = false;
    try {
      await executeThroughWalSpine({
        stateDb,
        spillStore,
        sessionId: "session-canary-wal",
        leafId: "leaf-canary-0",
        toolCallId: "call_wal_step_1",
        toolName: "write",
        mutabilityClass: "LOCAL_REVERSIBLE",
        args: { path: "wal-target.txt", content: initialContent },
        localReversibleSpec: {
          targetPath: targetFile,
          expectedAfterBytes: initialBytes
        },
        executeEffect: async () => {
          throw new Error("SHOULD_NOT_REACH_EFFECT");
        }
      });
    } catch (err) {
      driftDetected = true;
      assert.ok(
        err instanceof OutcomeUnknownLockError,
        `Expected OutcomeUnknownLockError on drift, got: ${String(err)}`
      );
      assert.ok((err as Error).message.includes("OUTCOME_UNKNOWN_SESSION_LOCK"));
    }
    assert.equal(driftDetected, true, "Disk hash drift must throw OutcomeUnknownLockError");

    const driftedRow = stateDb.getWalRow(walRes1.idempotencyKey)!;
    assert.equal(driftedRow.status, "OUTCOME_UNKNOWN", "Status must transition to OUTCOME_UNKNOWN on hash drift");
    assert.ok(driftedRow.error_text && driftedRow.error_text.includes("DISK_HASH_DRIFT_POST_COMMIT"));

    // 5A (ii) Negative Denial Canary: Subsequent dispatch locked fail-closed by OUTCOME_UNKNOWN
    let subsequentLocked = false;
    try {
      assertNoUnresolvedOutcomeUnknown(stateDb, "session-canary-wal");
    } catch (err) {
      subsequentLocked = true;
      assert.ok(err instanceof OutcomeUnknownLockError);
    }
    assert.equal(subsequentLocked, true, "Session must remain locked fail-closed while OUTCOME_UNKNOWN is unresolved");

    stateDb.close();
    checks.push("Boundary 5: Operation WAL Spine + Idempotency Replay + Disk Drift Lock: PASS");
    console.log("  [PASS] Boundary 5 verified (spine execution + cache replay + drift detection & session lock).");
  }

  // ===========================================================================
  // Summary
  // ===========================================================================
  const totalElapsed = (performance.now() - t0).toFixed(2);
  console.log("\n================================================================================");
  console.log(`Security Canary Acceptance Suite Complete (${totalElapsed} ms)`);
  console.log("================================================================================");
  for (const c of checks) {
    console.log(`  [PASS] ${c}`);
  }
  console.log(`\nALL ${checks.length} SECURITY CANARY CHECKS PASSED.`);
}

main().catch((err) => {
  console.error("\n[SECURITY_CANARY_FAILURE]", err);
  process.exit(1);
});
