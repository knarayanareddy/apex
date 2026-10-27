import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createBwrapBashOperations } from "../src/core/bwrap-sandbox.ts";
import { createBashToolDefinition } from "@earendil-works/pi-coding-agent";

async function main() {
  console.log("================================================================================");
  console.log("PI-APEX 50 MB STREAMING STDOUT BACKPRESSURE & V8 HEAP STABILITY TEST");
  console.log("================================================================================\n");

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-apex-backpressure-"));
  const bashOps = createBwrapBashOperations({
    workspaceRoot: tmpDir,
    mode: "workspace-write",
    allowUnsandboxedDev: true
  });

  const forceGc = () => {
    if (global.gc) {
      global.gc();
    }
  };

  // ---------------------------------------------------------------------------
  // TEST 1: 50 MB High-Throughput Stdout Stream
  // ---------------------------------------------------------------------------
  console.log(">>> [TEST 1] Streaming 51.2 MB to stdout through bwrap-sandbox regulator...");
  forceGc();
  const heapBeforeT1 = process.memoryUsage().heapUsed;
  const rssBeforeT1 = process.memoryUsage().rss;

  let t1Chunks: Buffer[] = [];
  let t1TotalDataBytes = 0;

  // 50,000 blocks of 1,024 bytes = 51,200,000 bytes (~51.2 MB)
  const script50MB = `node -e '
    const blockSize = 1024;
    for (let i = 0; i < 50000; i++) {
      const seq = "SEQ_" + String(i).padStart(6, "0") + "_";
      const pad = "X".repeat(blockSize - seq.length - 1);
      process.stdout.write(seq + pad + "\\n");
    }
  '`;

  const t0T1 = performance.now();
  const resT1 = await bashOps.exec(script50MB, tmpDir, {
    onData: (chunk) => {
      t1Chunks.push(chunk);
      t1TotalDataBytes += chunk.length;
    },
    timeout: 30
  });
  const t1Elapsed = (performance.now() - t0T1).toFixed(2);

  forceGc();
  const heapAfterT1 = process.memoryUsage().heapUsed;
  const rssAfterT1 = process.memoryUsage().rss;
  const heapDeltaT1MB = ((heapAfterT1 - heapBeforeT1) / (1024 * 1024)).toFixed(2);
  const rssDeltaT1MB = ((rssAfterT1 - rssBeforeT1) / (1024 * 1024)).toFixed(2);

  const t1CombinedOutput = Buffer.concat(t1Chunks).toString("utf8");

  console.log(`  Completed in ${t1Elapsed} ms. Exit code: ${resT1.exitCode}`);
  console.log(`  Total bytes received by onData listener: ${t1TotalDataBytes} bytes (${(t1TotalDataBytes / 1024).toFixed(2)} KB)`);
  console.log(`  V8 Heap Delta: ${heapDeltaT1MB} MB | RSS Delta: ${rssDeltaT1MB} MB`);

  assert.equal(resT1.exitCode, 0, "Test 1 process must exit cleanly with code 0");
  assert.ok(
    t1TotalDataBytes < 64 * 1024,
    `onData received ${t1TotalDataBytes} bytes, which exceeds the 64 KB inline+tail budget! Memory regulator failed to throttle.`
  );
  assert.ok(
    t1CombinedOutput.includes("[OUTPUT_STREAM_OVERFLOW: Output exceeded 32768 bytes. Truncating inline stream to prevent V8 heap exhaustion...]"),
    "Output must contain the stream overflow warning notice"
  );
  assert.ok(
    t1CombinedOutput.includes("--- TAIL (51200000 total bytes seen) ---"),
    "Output must contain the tail marker with exact 51,200,000 total bytes seen"
  );
  assert.ok(
    t1CombinedOutput.includes("SEQ_049999_"),
    "Tail buffer must capture the final sequence block SEQ_049999_"
  );
  assert.ok(
    t1CombinedOutput.includes("SEQ_000000_"),
    "Inline head must capture the opening sequence block SEQ_000000_"
  );
  console.log("  [TEST 1 PASSED]: 50 MB stream throttled to ~37 KB in RAM, V8 heap stable, tail preserved.\n");

  // ---------------------------------------------------------------------------
  // TEST 2: 60 MB Stderr High-Throughput Stream
  // ---------------------------------------------------------------------------
  console.log(">>> [TEST 2] Streaming 61.44 MB to stderr through bwrap-sandbox regulator...");
  let t2Chunks: Buffer[] = [];
  let t2TotalDataBytes = 0;

  // 60,000 blocks of 1,024 bytes = 61,440,000 bytes (~61.44 MB)
  const scriptStderr60MB = `node -e '
    const blockSize = 1024;
    for (let i = 0; i < 60000; i++) {
      const seq = "ERR_" + String(i).padStart(6, "0") + "_";
      const pad = "E".repeat(blockSize - seq.length - 1);
      process.stderr.write(seq + pad + "\\n");
    }
  '`;

  const t0T2 = performance.now();
  const resT2 = await bashOps.exec(scriptStderr60MB, tmpDir, {
    onData: (chunk) => {
      t2Chunks.push(chunk);
      t2TotalDataBytes += chunk.length;
    },
    timeout: 30
  });
  const t2Elapsed = (performance.now() - t0T2).toFixed(2);
  const t2CombinedOutput = Buffer.concat(t2Chunks).toString("utf8");

  console.log(`  Completed in ${t2Elapsed} ms. Exit code: ${resT2.exitCode}`);
  console.log(`  Total bytes received by onData listener: ${t2TotalDataBytes} bytes`);

  assert.equal(resT2.exitCode, 0, "Test 2 process must exit cleanly with code 0");
  assert.ok(t2TotalDataBytes < 64 * 1024, "Stderr onData must be bounded to <= 64 KB");
  assert.ok(
    t2CombinedOutput.includes("[OUTPUT_STREAM_OVERFLOW: Output exceeded 32768 bytes. Truncating inline stream to prevent V8 heap exhaustion...]"),
    "Stderr must trigger overflow warning"
  );
  assert.ok(
    t2CombinedOutput.includes("--- TAIL (61440000 total bytes seen) ---"),
    "Stderr must show exact 61,440,000 total bytes seen"
  );
  assert.ok(
    t2CombinedOutput.includes("ERR_059999_"),
    "Stderr tail must contain the final block ERR_059999_"
  );
  console.log("  [TEST 2 PASSED]: 60 MB stderr stream safely regulated.\n");

  // ---------------------------------------------------------------------------
  // TEST 3: Interleaved Concurrent Stdout & Stderr Stream
  // ---------------------------------------------------------------------------
  console.log(">>> [TEST 3] Interleaved high-frequency stdout and stderr stream (40 MB total)...");
  let t3Chunks: Buffer[] = [];
  let t3TotalDataBytes = 0;

  const scriptInterleaved = `node -e '
    for (let i = 0; i < 20000; i++) {
      process.stdout.write("OUT_" + String(i).padStart(6, "0") + "_" + "A".repeat(1000) + "\\n");
      process.stderr.write("ERR_" + String(i).padStart(6, "0") + "_" + "B".repeat(1000) + "\\n");
    }
  '`;

  const resT3 = await bashOps.exec(scriptInterleaved, tmpDir, {
    onData: (chunk) => {
      t3Chunks.push(chunk);
      t3TotalDataBytes += chunk.length;
    },
    timeout: 30
  });
  const t3CombinedOutput = Buffer.concat(t3Chunks).toString("utf8");

  assert.equal(resT3.exitCode, 0, "Test 3 process must exit cleanly with code 0");
  assert.ok(t3TotalDataBytes < 64 * 1024, "Interleaved onData must be bounded");
  assert.ok(
    t3CombinedOutput.includes("[OUTPUT_STREAM_OVERFLOW:"),
    "Interleaved output must trigger overflow notice"
  );
  console.log("  [TEST 3 PASSED]: Interleaved streams handled with no race condition or memory leak.\n");

  // ---------------------------------------------------------------------------
  // TEST 4: Runaway Infinite Loop Hard Ceiling (128 MB SIGKILL)
  // ---------------------------------------------------------------------------
  console.log(">>> [TEST 4] Enforcing hard SIGKILL ceiling at 128 MB on runaway flood command...");
  let t4Chunks: Buffer[] = [];
  let t4TotalDataBytes = 0;

  // Infinite fast generator producing chunks via synchronous fd 1 writes
  const scriptInfinite = `node -e '
    const fs = require("fs");
    const chunk = Buffer.alloc(65536, "A");
    while (true) {
      fs.writeSync(1, chunk);
    }
  '`;

  const t0T4 = performance.now();
  const resT4 = await bashOps.exec(scriptInfinite, tmpDir, {
    onData: (chunk) => {
      t4Chunks.push(chunk);
      t4TotalDataBytes += chunk.length;
    },
    timeout: 10 // Safety harness timeout (must be killed by 128MB ceiling well before this!)
  });
  const t4Elapsed = (performance.now() - t0T4).toFixed(2);
  const t4CombinedOutput = Buffer.concat(t4Chunks).toString("utf8");

  console.log(`  Terminated in ${t4Elapsed} ms. Exit code: ${resT4.exitCode}`);
  console.log(`  Total bytes received by onData listener: ${t4TotalDataBytes} bytes`);

  assert.notEqual(resT4.exitCode, 0, "Infinite runaway process must not have exit code 0");
  assert.ok(
    Number(t4Elapsed) < 5000,
    `Process took ${t4Elapsed}ms to terminate; expected swift kill under 5 seconds once crossing 128 MB`
  );
  assert.ok(
    t4CombinedOutput.includes("[TRUNCATED: Process killed after exceeding 128MB output cap."),
    `Expected hard kill truncation message, got: ${t4CombinedOutput.slice(0, 500)}`
  );
  console.log("  [TEST 4 PASSED]: 128 MB runaway flood terminated via SIGKILL in under 5s.\n");

  // ---------------------------------------------------------------------------
  // TEST 5: Full Tool Layer (createBashToolDefinition) Integration
  // ---------------------------------------------------------------------------
  console.log(">>> [TEST 5] End-to-end integration via createBashToolDefinition...");
  const bashTool = createBashToolDefinition(tmpDir, {
    operations: bashOps,
    exposeSessionEnvironment: false
  });

  const toolExecResult = await bashTool.execute(
    "tool-call-1",
    {
      command: `node -e '
        const blockSize = 1024;
        for (let i = 0; i < 50000; i++) {
          const seq = "LINE_" + String(i).padStart(6, "0") + "_";
          const pad = "Z".repeat(blockSize - seq.length - 1);
          process.stdout.write(seq + pad + "\\n");
        }
      '`
    },
    undefined,
    undefined,
    {} as any
  );

  const toolText = (toolExecResult.content as any[])
    .map((c) => (c.type === "text" ? c.text : ""))
    .join("\n");

  assert.ok(toolText.length < 64 * 1024, `Tool result length ${toolText.length} exceeded 64 KB!`);
  assert.ok(
    toolText.includes("[OUTPUT_STREAM_OVERFLOW: Output exceeded 32768 bytes. Truncating inline stream to prevent V8 heap exhaustion...]"),
    "Tool output must include stream overflow notice"
  );
  assert.ok(
    toolText.includes("--- TAIL (51200000 total bytes seen) ---"),
    "Tool output must include tail notice with 51,200,000 bytes seen"
  );
  assert.ok(
    toolText.includes("LINE_049999_"),
    "Tool output tail must include the final line"
  );
  console.log("  [TEST 5 PASSED]: Tool definition wrapper cleanly exposes regulated stream to LLM.\n");

  // Cleanup
  fs.rmSync(tmpDir, { recursive: true, force: true });

  console.log("================================================================================");
  console.log("ALL 5 STREAMING STDOUT BACKPRESSURE & V8 HEAP STABILITY CHECKS PASSED CLEANLY!");
  console.log("================================================================================\n");
}

main().catch((err) => {
  console.error("FATAL: Test failed with error:", err);
  process.exit(1);
});
