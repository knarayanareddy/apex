import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { PrivateSpillStore } from "../../src/core/spill-store.ts";
import { normalizeWalToolResult, isReceiptDeliveryCompliant } from "../../src/core/wal-recovery.ts";
import { readWorkspaceFileSafe, PathContainmentError } from "../../src/core/safe-path.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..");

async function testF1BenchmarkVerificationFailure(): Promise<void> {
  console.log("--- Testing F1: Fatal Benchmark Verification Failures ---");

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "apex-f1-bench-"));
  const passingSuitePath = path.join(tmpDir, "passing-suite.json");
  const failingSuitePath = path.join(tmpDir, "failing-suite.json");

  const passingSuite = [
    {
      id: "f1-passing-task",
      title: "Passing Benchmark Task",
      issueDescription: "A passing task to verify permitted exit",
      scope: "core",
      seedFiles: {
        "index.js": "module.exports = 42;\n"
      },
      testCommand: "node -e 'process.exit(0)'",
      deterministicResponder: {
        experienceCueSubstring: "cue",
        cleanResolvedPatches: []
      }
    }
  ];

  const failingSuite = [
    {
      id: "f1-failing-task",
      title: "Failing Benchmark Task",
      issueDescription: "An intentionally failing task to verify fatal rejection",
      scope: "core",
      seedFiles: {
        "index.js": "module.exports = 0;\n"
      },
      testCommand: "node -e 'process.exit(1)'",
      deterministicResponder: {
        experienceCueSubstring: "cue",
        cleanResolvedPatches: []
      }
    }
  ];

  fs.writeFileSync(passingSuitePath, JSON.stringify(passingSuite, null, 2), "utf8");
  fs.writeFileSync(failingSuitePath, JSON.stringify(failingSuite, null, 2), "utf8");

  try {
    // 1. Negative control: failing task must cause bench-cli to exit with code 2 and emit diagnostic
    let failedCleanly = false;
    let failStderr = "";
    try {
      execFileSync(
        "node",
        [
          "--experimental-strip-types",
          path.join(REPO_ROOT, "src", "cli", "bench-cli.ts"),
          "--suite",
          failingSuitePath,
          "--no-ab",
          "--allow-unsandboxed-dev"
        ],
        { cwd: REPO_ROOT, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }
      );
    } catch (err: any) {
      failedCleanly = true;
      assert.equal(err.status, 2, `Expected exit status 2 on benchmark verification failure, got ${err.status}`);
      failStderr = err.stderr ?? "";
      assert.match(
        failStderr,
        /BENCHMARK_VERIFICATION_FAILED/,
        "Benchmark stderr must emit BENCHMARK_VERIFICATION_FAILED diagnostic"
      );
    }
    assert.equal(failedCleanly, true, "Intentional verification failure must propagate nonzero exit code!");
    console.log("  [NEGATIVE CONTROL PASS] Intentionally failing benchmark task exited with code 2 and emitted diagnostic.");

    // 2. Permitted control: passing task must exit with code 0 and emit valid report
    const passStdout = execFileSync(
      "node",
      [
        "--experimental-strip-types",
        path.join(REPO_ROOT, "src", "cli", "bench-cli.ts"),
        "--suite",
        passingSuitePath,
        "--no-ab",
        "--allow-unsandboxed-dev"
      ],
      { cwd: REPO_ROOT, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }
    );
    assert.match(passStdout, /Pi-Apex Personal SWE Eval & Prompt-Cache Benchmark/, "Expected report heading in benchmark stdout");
    console.log("  [PERMITTED CONTROL PASS] Passing benchmark task exited with code 0 and generated benchmark report.");
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

async function testF2SecretScanLatencyBenchmark(): Promise<void> {
  console.log("--- Testing F2: Secret-Scan Latency & Invalidation Soundness ---");

  // Run the dedicated benchmark-secret-scan script
  const scriptPath = path.join(REPO_ROOT, "scripts", "benchmark-secret-scan.ts");
  const output = execFileSync(
    "node",
    ["--experimental-strip-types", scriptPath],
    { cwd: REPO_ROOT, encoding: "utf8" }
  );

  assert.match(output, /Small Workspace \(50 dirs, 200 files\)/);
  assert.match(output, /Large Workspace \(400 dirs, 2,000 files\)/);
  assert.match(output, /\[SOUND INVALIDATION PASS\] Dynamically created secret detected immediately/);
  assert.match(output, /SECRET SCAN BENCHMARK COMPLETED SUCCESSFULLY/);

  console.log("  [PERMITTED & NEGATIVE PASS] Secret scan benchmark passed with measured percentiles and dynamic invalidation soundness.");
}

async function testF3PreserveOversizedStructuredFidelity(): Promise<void> {
  console.log("--- Testing F3: Preserve Oversized Structured-Result Fidelity ---");

  const tmpWs = fs.mkdtempSync(path.join(os.tmpdir(), "apex-f3-ws-"));
  const spillDir = path.join(tmpWs, ".harness", "spill");
  const spillStore = new PrivateSpillStore({
    rootDir: spillDir,
    maxInlineBytes: 1024,
    maxInlineLines: 20,
    previewBytes: 256
  });

  const sessionId = "session-f3-test-" + crypto.randomUUID();
  const oversizedText1 = "AlphaSection_".repeat(2000); // ~26 KB
  const oversizedText2 = "OmegaSection_".repeat(2000); // ~26 KB
  const rawImageBase64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

  const rawContent = [
    { type: "text" as const, text: oversizedText1 },
    { type: "image" as const, data: rawImageBase64, mimeType: "image/png" },
    { type: "text" as const, text: oversizedText2 }
  ];

  try {
    const normalized = normalizeWalToolResult({
      sessionId,
      spillStore,
      content: rawContent
    });

    // Verify delivery is normalized and bounded inline
    assert.equal(normalized.spilled, true, "Result must be marked spilled");
    assert.equal(normalized.spillFallbackUsed, false, "Spill fallback must not be used on healthy disk");
    assert.equal(isReceiptDeliveryCompliant(normalized, spillStore), true, "Normalized receipt must be delivery compliant");

    // Negative control: inline content must NOT contain the 26 KB raw text directly
    for (const block of normalized.content) {
      if (block.type === "text") {
        assert.ok(
          Buffer.byteLength(block.text, "utf8") < 2048,
          `Inline text block must be bounded, got ${Buffer.byteLength(block.text, "utf8")} bytes`
        );
        assert.ok(!block.text.includes(oversizedText1), "Inline block must not contain un-spilled raw text");
        assert.ok(!block.text.includes(oversizedText2), "Inline block must not contain un-spilled raw text");
      } else if (block.type === "image") {
        // Image block preserved in place without corruption
        assert.equal(block.data, rawImageBase64, "Binary image data must match original exactly");
        assert.equal(block.mimeType, "image/png", "MimeType must match original exactly");
      }
    }
    console.log("  [NEGATIVE CONTROL PASS] Inline context received strictly bounded notices; raw oversized text prevented from context.");

    // Permitted control: retrieve spilled structured JSON through handle and verify exact fidelity
    const primaryNotice = normalized.finalText;
    const match = primaryNotice.match(/\[FULL STRUCTURED CONTENT PRESERVED: (.*?)\]/);
    assert.ok(match && match[1], "Primary delivery notice must include structured spill file path");
    const structSpillPath = match[1]!;

    assert.ok(fs.existsSync(structSpillPath), `Structured spill file must exist at ${structSpillPath}`);

    // Mode check: 0600 private permissions
    const stat = fs.statSync(structSpillPath);
    assert.equal(stat.mode & 0o777, 0o600, "Spill file must have 0600 permissions");

    // Authorized read via safe-path beneath workspace root
    const relSpillPath = path.relative(tmpWs, structSpillPath);
    const readBytes = readWorkspaceFileSafe({
      workspaceRoot: tmpWs,
      candidatePath: relSpillPath,
      sessionId
    });
    const parsedBlocks = JSON.parse(readBytes.toString("utf8")) as any[];

    assert.equal(parsedBlocks.length, 3, "Spilled structured content must preserve all 3 blocks");
    assert.equal(parsedBlocks[0].type, "text");
    assert.equal(parsedBlocks[0].text, oversizedText1, "Block 0 text must match byte-for-byte");
    assert.equal(parsedBlocks[1].type, "image");
    assert.equal(parsedBlocks[1].data, rawImageBase64, "Block 1 image data must match byte-for-byte");
    assert.equal(parsedBlocks[1].mimeType, "image/png");
    assert.equal(parsedBlocks[2].type, "text");
    assert.equal(parsedBlocks[2].text, oversizedText2, "Block 2 text must match byte-for-byte");

    console.log("  [PERMITTED CONTROL PASS] Spilled structured content retrieved and verified byte-for-byte across text and binary image blocks.");

    // Negative control: unauthorized cross-session read must be denied
    assert.throws(
      () => {
        readWorkspaceFileSafe({
          workspaceRoot: tmpWs,
          candidatePath: relSpillPath,
          sessionId: "unauthorized-session-id"
        });
      },
      (err: any) => {
        return err instanceof PathContainmentError && /cross-session spill read denied/.test(err.message);
      },
      "Cross-session read of private spill file must be denied"
    );
    console.log("  [NEGATIVE CONTROL PASS] Cross-session read of private spill file rejected by PathContainmentError.");
  } finally {
    fs.rmSync(tmpWs, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  console.log("=== Running Batch F Canary Suites (F1, F2, F3) ===\n");
  await testF1BenchmarkVerificationFailure();
  console.log();
  await testF2SecretScanLatencyBenchmark();
  console.log();
  await testF3PreserveOversizedStructuredFidelity();
  console.log("\n=== ALL BATCH F CANARY TESTS PASSED ===");
}

main().catch((err) => {
  console.error("Batch F canary tests failed:", err);
  process.exit(1);
});
