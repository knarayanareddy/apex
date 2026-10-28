/**
 * Batch-5 Remediation Verification Suite (`test/canaries/batch5-regressions.spec.ts`)
 *
 * Verifies the three reproduced security & robustness findings:
 *  1. Checkpoint creation must reject incomplete secret inventories (depth 36 hardlink canary).
 *  2. Structured content must determine its own text budget (empty rawText / summary with oversized content).
 *  3. Normalize pre-upgrade committed cache results (EFFECT_COMMITTED / TRANSCRIPT_APPENDED replay bounds).
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  GuardDeniedError,
  resolveAndValidateWorkspacePath
} from "../../src/core/monotonic-guard.ts";
import {
  PathContainmentError,
  readWorkspaceFileSafe,
  scanWorkspaceSecretsAndHardlinks
} from "../../src/core/safe-path.ts";
import {
  captureTurnCheckpoint,
  CheckpointSecurityError,
  rewindChatAndDiskToLeaf,
  scanWorkspaceEntryStates,
  snapshotWorkingTreeToGit
} from "../../src/core/git-rewind.ts";
import { PrivateSpillStore } from "../../src/core/spill-store.ts";
import { StateDb } from "../../src/core/state-db.ts";
import {
  executeThroughWalSpine,
  normalizeWalToolResult,
  reconcileWalOnStartup,
  type WalContentBlock
} from "../../src/core/wal-recovery.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function createGitRepo(prefix: string): string {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `apex-batch5-${prefix}-`));
  execFileSync("git", ["init", "-b", "main"], { cwd: tmpDir, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "apex-test@example.com"], { cwd: tmpDir, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "Apex Test"], { cwd: tmpDir, stdio: "ignore" });
  return tmpDir;
}

// ============================================================================
// FIX 1: Checkpoint creation must reject incomplete secret inventories
// ============================================================================
async function runFinding1CheckpointCompletenessTests(): Promise<void> {
  console.log("\n[Finding 1] Testing Checkpoint Completeness Against Incomplete Secret Inventories...");

  // Setup fresh Git workspace
  const repo = createGitRepo("chkpt-inc");
  const stateDb = new StateDb(path.join(repo, ".harness", "state.db"), "power-loss-safe");

  // Create deep nesting: node_modules/<36 nested dirs>/.env
  let deepDir = path.join(repo, "node_modules");
  for (let i = 1; i <= 36; i++) {
    deepDir = path.join(deepDir, `level_${i}`);
  }
  fs.mkdirSync(deepDir, { recursive: true });

  const syntheticMarker = `SYNTHETIC_MARKER_CHECKPOINT_SECURITY_SECRET_${crypto.randomBytes(16).toString("hex")}`;
  const envFile = path.join(deepDir, ".env");
  fs.writeFileSync(envFile, syntheticMarker, { mode: 0o600 });

  // Compute marker's blob OID WITHOUT writing it to git object storage
  const markerOid = execFileSync("git", ["hash-object", "--stdin"], {
    cwd: repo,
    input: syntheticMarker,
    encoding: "utf8"
  }).trim();

  // Create innocent hardlink alias at root
  const innocentFile = path.join(repo, "innocent.txt");
  fs.linkSync(envFile, innocentFile);

  // Assert secret scan is incomplete
  const scan = scanWorkspaceSecretsAndHardlinks(repo);
  assert.equal(scan.complete, false, "Secret scan must be incomplete at depth 36");
  assert.ok(scan.incompleteReasons.length > 0, "Scan must report incomplete reasons");

  // Assert guarded alias read is denied
  let readBlocked = false;
  try {
    readWorkspaceFileSafe({ workspaceRoot: repo, candidatePath: "innocent.txt" });
  } catch (err: unknown) {
    if (err instanceof GuardDeniedError || err instanceof PathContainmentError) {
      readBlocked = true;
    }
  }
  assert.equal(readBlocked, true, "Guarded alias read of innocent.txt must be denied");

  // Assert scanWorkspaceEntryStates throws CheckpointSecurityError
  let scanEntryStatesBlocked = false;
  try {
    scanWorkspaceEntryStates(repo);
  } catch (err: unknown) {
    if (err instanceof CheckpointSecurityError || (err instanceof GuardDeniedError && (err as any).code === "CHECKPOINT_SECRET_SCAN_INCOMPLETE")) {
      scanEntryStatesBlocked = true;
    }
  }
  assert.equal(scanEntryStatesBlocked, true, "scanWorkspaceEntryStates must throw CheckpointSecurityError when scan is incomplete");

  // Assert normal checkpoint creation throws CheckpointSecurityError
  let checkpointBlocked = false;
  try {
    snapshotWorkingTreeToGit(repo);
  } catch (err: unknown) {
    if (err instanceof CheckpointSecurityError || (err instanceof GuardDeniedError && (err as any).code === "CHECKPOINT_SECRET_SCAN_INCOMPLETE")) {
      checkpointBlocked = true;
    }
  }
  assert.equal(checkpointBlocked, true, "snapshotWorkingTreeToGit must throw CheckpointSecurityError");

  // Assert captureTurnCheckpoint throws and creates no row
  let turnCheckpointBlocked = false;
  try {
    captureTurnCheckpoint({
      stateDb,
      workspaceRoot: repo,
      sessionId: "session_f1",
      leafId: "leaf_f1_incomplete",
      turnIndex: 1
    });
  } catch (err: unknown) {
    if (err instanceof CheckpointSecurityError || (err instanceof GuardDeniedError && (err as any).code === "CHECKPOINT_SECRET_SCAN_INCOMPLETE")) {
      turnCheckpointBlocked = true;
    }
  }
  assert.equal(turnCheckpointBlocked, true, "captureTurnCheckpoint must throw CheckpointSecurityError");

  const cpRow = stateDb.db
    .prepare("SELECT * FROM git_checkpoints WHERE session_id = ? AND leaf_id = ?")
    .get("session_f1", "leaf_f1_incomplete");
  assert.equal(cpRow, undefined, "No successful checkpoint row must be created in stateDb");

  // Assert pre-rewind safety snapshot creation also refuses
  stateDb.db.prepare(`INSERT INTO git_checkpoints (
    session_id, leaf_id, turn_index, git_tree_oid, file_hashes_json, entry_states_json, created_at_ms
  ) VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
    "session_f1", "leaf_to", 0, "4b825dc642cb6eb9a060e54bf8d69288fbee4904", "{}", "{}", Date.now()
  );

  let safetySnapshotBlocked = false;
  try {
    // Attempt rewind which triggers snapshotWorkingTreeToGit for safety snapshot
    rewindChatAndDiskToLeaf({
      stateDb,
      workspaceRoot: repo,
      sessionManager: {
        branch: () => {},
        appendCustomEntry: () => "leaf_anchor",
        getSessionFile: () => undefined
      } as any,
      sessionId: "session_f1",
      fromLeafId: "leaf_from",
      toLeafId: "leaf_to"
    });
  } catch (err: unknown) {
    if (err instanceof CheckpointSecurityError || (err instanceof GuardDeniedError && (err as any).code === "CHECKPOINT_SECRET_SCAN_INCOMPLETE")) {
      safetySnapshotBlocked = true;
    }
  }
  assert.equal(safetySnapshotBlocked, true, "Rewind safety snapshot must refuse with CheckpointSecurityError");

  // Assert workspace bytes remain completely unchanged
  assert.equal(fs.readFileSync(envFile, "utf8"), syntheticMarker);
  assert.equal(fs.readFileSync(innocentFile, "utf8"), syntheticMarker);

  // Assert synthetic secret blob was NOT written into Git object storage
  let catFileSucceeded = false;
  try {
    execFileSync("git", ["cat-file", "-e", markerOid], { cwd: repo, stdio: "ignore" });
    catFileSucceeded = true;
  } catch {
    catFileSucceeded = false;
  }
  assert.equal(catFileSucceeded, false, "Synthetic secret blob must NOT exist in Git object storage (git cat-file -e <oid> must fail)");

  // --------------------------------------------------------------------------
  // Positive Controls
  // --------------------------------------------------------------------------
  // Control 1: Complete inventory + public files -> checkpoint succeeds
  const cleanRepo = createGitRepo("chkpt-clean");
  const cleanDb = new StateDb(path.join(cleanRepo, ".harness", "state.db"), "power-loss-safe");
  fs.writeFileSync(path.join(cleanRepo, "app.ts"), "console.log('clean');\n");
  fs.mkdirSync(path.join(cleanRepo, "src"), { recursive: true });
  fs.writeFileSync(path.join(cleanRepo, "src", "math.ts"), "export const pi = 3.14;\n");

  const cleanScan = scanWorkspaceSecretsAndHardlinks(cleanRepo);
  assert.equal(cleanScan.complete, true, "Clean repo scan must be complete");

  const cleanSnap = snapshotWorkingTreeToGit(cleanRepo);
  assert.ok(cleanSnap.gitTreeOid, "Clean repo snapshot must produce gitTreeOid");
  assert.ok(cleanSnap.fileHashes["app.ts"], "app.ts must be indexed");
  assert.ok(cleanSnap.fileHashes["src/math.ts"], "src/math.ts must be indexed");

  captureTurnCheckpoint({
    stateDb: cleanDb,
    workspaceRoot: cleanRepo,
    sessionId: "session_clean",
    leafId: "leaf_clean_1",
    turnIndex: 1
  });
  const savedCp = cleanDb.db
    .prepare("SELECT * FROM git_checkpoints WHERE session_id = ? AND leaf_id = ?")
    .get("session_clean", "leaf_clean_1") as any;
  assert.ok(savedCp, "Checkpoint row must exist for clean repo");
  assert.equal(savedCp.git_tree_oid, cleanSnap.gitTreeOid);

  // Control 2: Complete inventory + known secret files / hardlinks are excluded from Git checkpoint
  const secretRepo = createGitRepo("chkpt-secret-excl");
  fs.writeFileSync(path.join(secretRepo, "public.txt"), "public content\n");
  fs.writeFileSync(path.join(secretRepo, ".env"), "KNOWN_SECRET=123\n");
  fs.linkSync(path.join(secretRepo, ".env"), path.join(secretRepo, "alias.txt"));

  const secScan = scanWorkspaceSecretsAndHardlinks(secretRepo);
  assert.equal(secScan.complete, true, "Shallow secret scan must be complete");

  const secSnap = snapshotWorkingTreeToGit(secretRepo);
  assert.ok(secSnap.fileHashes["public.txt"], "public.txt must be included");
  assert.equal(secSnap.fileHashes[".env"], undefined, ".env must be excluded from checkpoint");
  assert.equal(secSnap.fileHashes["alias.txt"], undefined, "alias.txt must be excluded from checkpoint");

  console.log("  [PASS] Finding 1: Checkpoint creation rejects incomplete secret inventories fail-closed.");
}

// ============================================================================
// FIX 2: Structured content must determine its own text budget
// ============================================================================
async function runFinding2StructuredContentBudgetTests(): Promise<void> {
  console.log("\n[Finding 2] Testing Structured Content Text Budgeting & Normalization Matrix...");

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "apex-batch5-wal-budget-"));
  const spillStore = new PrivateSpillStore({ rootDir: path.join(tmpDir, "spills"), maxInlineBytes: 256, maxInlineLines: 10 });
  const oversizedText = "A".repeat(20_000);
  const smallText = "Hello, world!";
  const dummyImage: WalContentBlock = {
    type: "image",
    data: "aW1hZ2VkYXRh",
    mimeType: "image/png"
  };

  // Test Matrix Definitions
  const scenarios: Array<{
    name: string;
    rawText: string | undefined;
    content: WalContentBlock[];
    simulateEnospc?: boolean;
    expectSpill: boolean;
  }> = [
    {
      name: "Missing rawText + Oversized text content",
      rawText: undefined,
      content: [{ type: "text", text: oversizedText }],
      expectSpill: true
    },
    {
      name: "Empty string rawText + Oversized text content",
      rawText: "",
      content: [{ type: "text", text: oversizedText }],
      expectSpill: true
    },
    {
      name: "Short summary rawText + Oversized text content",
      rawText: "Summary of 20KB data",
      content: [{ type: "text", text: oversizedText }],
      expectSpill: true
    },
    {
      name: "Matching text rawText + Oversized text content",
      rawText: oversizedText,
      content: [{ type: "text", text: oversizedText }],
      expectSpill: true
    },
    {
      name: "Short summary + Multiple oversized text blocks around image",
      rawText: "Multi-block summary",
      content: [
        { type: "text", text: "Prefix: " + oversizedText },
        dummyImage,
        { type: "text", text: "Suffix: " + oversizedText }
      ],
      expectSpill: true
    },
    {
      name: "Empty string rawText + Multibyte Unicode text",
      rawText: "",
      content: [{ type: "text", text: "🚀🔥💻".repeat(2500) }], // ~30,000 UTF-8 bytes
      expectSpill: true
    },
    {
      name: "Legacy text only + No structured content",
      rawText: oversizedText,
      content: [],
      expectSpill: true
    },
    {
      name: "Simulated ENOSPC with empty rawText + Oversized text content",
      rawText: "",
      content: [{ type: "text", text: oversizedText }],
      simulateEnospc: true,
      expectSpill: true
    },
    {
      name: "Small permitted result (Control)",
      rawText: smallText,
      content: [{ type: "text", text: smallText }, dummyImage],
      expectSpill: false
    }
  ];

  for (const sc of scenarios) {
    const store = sc.simulateEnospc
      ? new PrivateSpillStore({
          rootDir: path.join(tmpDir, "spills-enospc"),
          maxInlineBytes: 256,
          maxInlineLines: 10,
          simulateWriteFailure: true
        })
      : spillStore;

    const norm = normalizeWalToolResult({
      sessionId: "session_f2",
      spillStore: store,
      rawText: sc.rawText,
      content: sc.content.length > 0 ? sc.content : undefined
    });

    if (sc.expectSpill) {
      assert.ok(
        norm.spilled || norm.spillFallbackUsed,
        `Scenario "${sc.name}" must be bounded (spilled or fallback)`
      );

      // Verify aggregate delivered text follows delivery bound
      const textBlocks = norm.content.filter((b): b is { type: "text"; text: string } => b.type === "text");
      const aggregateDeliveredText = textBlocks.map((b) => b.text).join("\n");
      const aggregateBytes = Buffer.byteLength(aggregateDeliveredText, "utf8");

      assert.ok(
        aggregateBytes < 12_000,
        `Scenario "${sc.name}" aggregate delivered text (${aggregateBytes} bytes) must be bounded notice/preview, not oversized original!`
      );

      // Verify content cannot retain the original oversized text while finalText is bounded
      assert.ok(
        !aggregateDeliveredText.includes(oversizedText),
        `Scenario "${sc.name}" content must not retain the original 20,000 bytes`
      );

      // Verify image blocks remain intact
      const hasOriginalImage = sc.content.some((b) => b.type === "image");
      if (hasOriginalImage) {
        const imageBlock = norm.content.find((b) => b.type === "image");
        assert.ok(imageBlock, `Scenario "${sc.name}" must preserve image blocks`);
        assert.equal((imageBlock as any).data, dummyImage.data);
      }
    } else {
      assert.equal(norm.spilled, false);
      assert.equal(norm.spillFallbackUsed, false);
      assert.equal(norm.finalText, smallText);
      assert.equal(norm.content.length, 2);
    }
  }

  // --------------------------------------------------------------------------
  // RAW Recovery Pipeline Verification
  // --------------------------------------------------------------------------
  const stateDb = new StateDb(path.join(tmpDir, "raw-state.db"), "power-loss-safe");
  let effectCounter = 0;
  const rawSpineRes = await executeThroughWalSpine({
    stateDb,
    spillStore,
    sessionId: "session_raw_f2",
    leafId: "leaf_raw_1",
    toolCallId: "call_raw_f2",
    toolName: "test_oversized_tool",
    mutabilityClass: "OPAQUE_EXTERNAL",
    args: {},
    executeEffect: async () => {
      effectCounter++;
      return {
        rawText: "",
        content: [{ type: "text", text: oversizedText }, dummyImage]
      };
    }
  });

  assert.equal(effectCounter, 1, "Effect must execute exactly once");
  assert.ok(rawSpineRes.spilled || rawSpineRes.spillFallbackUsed, "Spine result must be bounded");
  assert.ok(Buffer.byteLength(rawSpineRes.content[0]?.type === "text" ? (rawSpineRes.content[0] as any).text : "", "utf8") < 4096);

  // Assert image is intact in spine output
  const outImage = rawSpineRes.content.find((b) => b.type === "image");
  assert.ok(outImage, "Spine result must preserve image block");

  console.log("  [PASS] Finding 2: Structured content text budgeting & normalization matrix verified.");
}

// ============================================================================
// FIX 3: Normalize pre-upgrade committed cache results
// ============================================================================
async function runFinding3PreUpgradeCacheTests(): Promise<void> {
  console.log("\n[Finding 3] Testing Normalization of Pre-Upgrade Committed Cache Results...");

  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "apex-batch5-upgrade-cache-"));
  const dbPath = path.join(tmpBase, "state.db");
  const spillsDir = path.join(tmpBase, "spills");
  let stateDb = new StateDb(dbPath, "power-loss-safe");
  let spillStore = new PrivateSpillStore({ rootDir: spillsDir, maxInlineBytes: 256, maxInlineLines: 10 });

  const oversizedText = "B".repeat(20_000);
  const dummyImage: WalContentBlock = {
    type: "image",
    data: "Y2FjaGVpbWFnZQ==",
    mimeType: "image/jpeg"
  };

  const cacheTestCases: Array<{
    name: string;
    status: "EFFECT_COMMITTED" | "TRANSCRIPT_APPENDED";
    seededResultJson: string;
    expectImage: boolean;
    simulateSpillFailure?: boolean;
  }> = [
    {
      name: "EFFECT_COMMITTED with oversized structured text",
      status: "EFFECT_COMMITTED",
      seededResultJson: JSON.stringify({
        finalText: oversizedText,
        content: [{ type: "text", text: oversizedText }]
      }),
      expectImage: false
    },
    {
      name: "TRANSCRIPT_APPENDED with oversized structured text",
      status: "TRANSCRIPT_APPENDED",
      seededResultJson: JSON.stringify({
        finalText: oversizedText,
        content: [{ type: "text", text: oversizedText }]
      }),
      expectImage: false
    },
    {
      name: "Legacy text-only receipt (no content array)",
      status: "EFFECT_COMMITTED",
      seededResultJson: JSON.stringify({
        finalText: oversizedText
      }),
      expectImage: false
    },
    {
      name: "Mixed text/image legacy structured receipt",
      status: "EFFECT_COMMITTED",
      seededResultJson: JSON.stringify({
        finalText: "Summary",
        content: [{ type: "text", text: oversizedText }, dummyImage]
      }),
      expectImage: true
    },
    {
      name: "Simulated spill failure on pre-upgrade cache replay",
      status: "EFFECT_COMMITTED",
      seededResultJson: JSON.stringify({
        finalText: oversizedText,
        content: [{ type: "text", text: oversizedText }]
      }),
      expectImage: false,
      simulateSpillFailure: true
    }
  ];

  for (let i = 0; i < cacheTestCases.length; i++) {
    const tc = cacheTestCases[i];
    const toolCallId = `call_cached_${i}`;
    let effectInvocations = 0;

    // 1. Seed genuine completed operation with external effect counter
    const initialRes = await executeThroughWalSpine({
      stateDb,
      spillStore,
      sessionId: "session_cache_f3",
      leafId: "leaf_cache_1",
      toolCallId,
      parentToolCallId: "parent_call_root",
      toolName: "test_cache_tool",
      mutabilityClass: "OPAQUE_EXTERNAL",
      args: { i },
      executeEffect: async () => {
        effectInvocations++;
        return { rawText: "Initial seed effect" };
      }
    });

    const idempotencyKey = initialRes.idempotencyKey;
    assert.equal(effectInvocations, 1, "Initial execution must increment effect count");

    // Seed the target pre-upgrade result format and status
    stateDb.db
      .prepare(`UPDATE wal_intents SET status = ?, result_json = ?, updated_at_ms = ? WHERE idempotency_key = ?`)
      .run(tc.status, tc.seededResultJson, Date.now() - 5000, idempotencyKey);

    const activeSpillStore = tc.simulateSpillFailure
      ? new PrivateSpillStore({
          rootDir: path.join(tmpBase, "spill-fail"),
          maxInlineBytes: 256,
          maxInlineLines: 10,
          simulateWriteFailure: true
        })
      : spillStore;

    // 2. Replay operation identity through executeThroughWalSpine
    const replayRes = await executeThroughWalSpine({
      stateDb,
      spillStore: activeSpillStore,
      sessionId: "session_cache_f3",
      leafId: "leaf_cache_1",
      toolCallId,
      parentToolCallId: "parent_call_root",
      toolName: "test_cache_tool",
      mutabilityClass: "OPAQUE_EXTERNAL",
      args: { i },
      executeEffect: async () => {
        effectInvocations++;
        return { rawText: "NEW_EFFECT_SHOULD_NEVER_RUN" };
      }
    });

    // 3. Assertions
    assert.equal(replayRes.fromCache, true, `[${tc.name}] Must report fromCache === true`);
    assert.equal(effectInvocations, 1, `[${tc.name}] Effect must NOT be re-executed (count must remain 1)`);

    const aggregateReplayText = replayRes.content
      .filter((b): b is { type: "text"; text: string } => b.type === "text")
      .map((b) => b.text)
      .join("\n");
    const aggregateBytes = Buffer.byteLength(aggregateReplayText, "utf8");

    assert.ok(
      aggregateBytes < 4096,
      `[${tc.name}] Replayed content (${aggregateBytes} bytes) must be bounded, not 20,000 bytes!`
    );
    assert.ok(!aggregateReplayText.includes(oversizedText), `[${tc.name}] Original oversized text must not be delivered`);

    if (tc.expectImage) {
      const img = replayRes.content.find((b) => b.type === "image");
      assert.ok(img, `[${tc.name}] Image block must be preserved on cache replay`);
      assert.equal((img as any).data, dummyImage.data);
    }

    // Assert status and parent linkage remain intact in database
    const postRow = stateDb.getWalRow(idempotencyKey)!;
    assert.equal(postRow.status, tc.status, `[${tc.name}] Status must remain ${tc.status}`);
    assert.equal(postRow.parent_tool_call_id, "parent_call_root", `[${tc.name}] Parent linkage must be preserved`);

    // 4. Close and reopen database, repeat replay with stable identity
    stateDb.close();
    stateDb = new StateDb(dbPath, "power-loss-safe");

    const reopenedReplay = await executeThroughWalSpine({
      stateDb,
      spillStore: activeSpillStore,
      sessionId: "session_cache_f3",
      leafId: "leaf_cache_1",
      toolCallId,
      parentToolCallId: "parent_call_root",
      toolName: "test_cache_tool",
      mutabilityClass: "OPAQUE_EXTERNAL",
      args: { i },
      executeEffect: async () => {
        effectInvocations++;
        return { rawText: "NEW_EFFECT_SHOULD_NEVER_RUN" };
      }
    });

    assert.equal(reopenedReplay.fromCache, true, `[${tc.name}] Must report fromCache === true after restart`);
    assert.equal(effectInvocations, 1, `[${tc.name}] Effect must not run after restart (count must remain 1)`);
    assert.ok(Buffer.byteLength(reopenedReplay.finalText, "utf8") < 4096);
  }

  // --------------------------------------------------------------------------
  // Positive Controls
  // --------------------------------------------------------------------------
  // Control 1: Small cached result remains equivalent
  const initialSmall = await executeThroughWalSpine({
    stateDb,
    spillStore,
    sessionId: "session_cache_ctrl",
    leafId: "leaf_1",
    toolCallId: "call_small",
    toolName: "small_tool",
    mutabilityClass: "PURE_READ",
    args: {},
    executeEffect: async () => ({
      finalText: "small text",
      content: [{ type: "text", text: "small text" }]
    })
  });

  const smallReplay = await executeThroughWalSpine({
    stateDb,
    spillStore,
    sessionId: "session_cache_ctrl",
    leafId: "leaf_1",
    toolCallId: "call_small",
    toolName: "small_tool",
    mutabilityClass: "PURE_READ",
    args: {},
    executeEffect: async () => {
      throw new Error("Should not run");
    }
  });
  assert.equal(smallReplay.fromCache, true);
  assert.equal(smallReplay.finalText, "small text");

  // Control 2: OUTCOME_UNKNOWN remains locked
  const initialUnknown = await executeThroughWalSpine({
    stateDb,
    spillStore,
    sessionId: "session_cache_ctrl",
    leafId: "leaf_1",
    toolCallId: "call_unknown",
    toolName: "mut_tool",
    mutabilityClass: "OPAQUE_EXTERNAL",
    args: {},
    executeEffect: async () => ({
      rawText: "before lock"
    })
  });

  stateDb.db
    .prepare(
      `UPDATE wal_intents SET status = 'OUTCOME_UNKNOWN', error_text = 'DISK_MISMATCH', updated_at_ms = ? WHERE idempotency_key = ?`
    )
    .run(Date.now(), initialUnknown.idempotencyKey);

  await assert.rejects(
    () =>
      executeThroughWalSpine({
        stateDb,
        spillStore,
        sessionId: "session_cache_ctrl",
        leafId: "leaf_1",
        toolCallId: "call_unknown",
        toolName: "mut_tool",
        mutabilityClass: "OPAQUE_EXTERNAL",
        args: {},
        executeEffect: async () => {
          throw new Error("Should not run");
        }
      }),
    /OUTCOME_UNKNOWN/
  );

  stateDb.close();
  console.log("  [PASS] Finding 3: Pre-upgrade cache normalization and replay verified.");
}

// ============================================================================
// MAIN RUNNER
// ============================================================================
async function runAllBatch5Regressions(): Promise<void> {
  console.log("================================================================================");
  console.log("Running Apex Batch-5 Remediation Verification Suite");
  console.log("================================================================================");

  await runFinding1CheckpointCompletenessTests();
  await runFinding2StructuredContentBudgetTests();
  await runFinding3PreUpgradeCacheTests();

  console.log("================================================================================");
  console.log("ALL BATCH-5 REMEDIATION CANARIES PASSED CLEANLY!");
  console.log("================================================================================");
}

runAllBatch5Regressions().catch((err) => {
  console.error("\n[FAIL] Batch-5 suite encountered failure:\n", err);
  process.exit(1);
});
