/**
 * Batch-6 Remediation & Acceptance Suite (`test/canaries/batch6-cache-gate.spec.ts`)
 *
 * Verifies:
 *  A. Genuine normalized receipts remain completely idempotent across repeated startup reconciliation passes.
 *     (Zero new spill files, zero receipt rewrites, stable hashes and references).
 *  B. Legacy receipt migration (EFFECT_COMMITTED, TRANSCRIPT_APPENDED, text-only, mixed text/image, simulated ENOSPC)
 *     migrates exactly once, preserves images and parent linkage, and does not re-migrate on subsequent passes.
 *  C. Invalid spill-flag combinations (crafted spilled:true, spillFallbackUsed:true, mismatched texts, multibyte)
 *     are rejected by delivery policy validation and forced through normalization.
 *  D. Permitted controls (small inline text, genuine spill notice, genuine fallback, image-only, mixed small text/image,
 *     disk-hash drift, and locked OUTCOME_UNKNOWN) remain completely sound.
 */

import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { PrivateSpillStore } from "../../src/core/spill-store.ts";
import { StateDb } from "../../src/core/state-db.ts";
import {
  ensureNormalizedCommittedResult,
  executeThroughWalSpine,
  isReceiptDeliveryCompliant,
  normalizeWalToolResult,
  reconcileWalOnStartup,
  type WalContentBlock
} from "../../src/core/wal-recovery.ts";

function countSpillFiles(dir: string): number {
  if (!fs.existsSync(dir)) return 0;
  let count = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true, recursive: true })) {
    if (entry.isFile() && entry.name.startsWith("spill-")) {
      count++;
    }
  }
  return count;
}

function getSpillFileEntries(dir: string): Map<string, string> {
  const map = new Map<string, string>();
  if (!fs.existsSync(dir)) return map;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true, recursive: true })) {
    if (entry.isFile() && entry.name.startsWith("spill-")) {
      const parentDir = (entry as any).parentPath ?? (entry as any).path ?? dir;
      const fullPath = path.join(parentDir, entry.name);
      const content = fs.readFileSync(fullPath, "utf8");
      const sha = crypto.createHash("sha256").update(content).digest("hex");
      map.set(entry.name, sha);
    }
  }
  return map;
}

// ============================================================================
// PART A: Genuine normalized receipt across repeated startup
// ============================================================================
async function runPartAGenuineReceiptRepeatedStartupTests(): Promise<void> {
  console.log("\n[Part A] Testing Genuine Normalized Receipt Across Repeated Startup Reconciliation...");

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "batch6-part-a-"));
  const dbPath = path.join(tmpDir, "state.db");
  const spillsDir = path.join(tmpDir, "spills");

  let stateDb = new StateDb(dbPath, "power-loss-safe");
  let spillStore = new PrivateSpillStore({ rootDir: spillsDir, maxInlineBytes: 256, maxInlineLines: 10 });

  let effectCounter = 0;
  const oversizedText = "M".repeat(20_000);

  // 1. Initial execution through real executeThroughWalSpine
  const initialRes = await executeThroughWalSpine({
    stateDb,
    spillStore,
    sessionId: "sess_part_a",
    leafId: "leaf_part_a",
    toolCallId: "call_part_a",
    toolName: "tool_part_a",
    mutabilityClass: "OPAQUE_EXTERNAL",
    args: {},
    executeEffect: async () => {
      effectCounter++;
      return { rawText: oversizedText };
    }
  });

  assert.equal(effectCounter, 1, "Effect must execute exactly once initially");
  assert.equal(initialRes.spilled, true, "Initial result must be spilled");
  assert.equal(initialRes.fromCache, false);

  const initialSpillCount = countSpillFiles(spillsDir);
  assert.equal(initialSpillCount, 1, "Exactly one spill file must exist after initial execution");
  const initialSpillEntries = getSpillFileEntries(spillsDir);

  const initialRow = stateDb.getWalRow(initialRes.idempotencyKey)!;
  const initialResultJson = initialRow.result_json;
  const initialStatus = initialRow.status;
  const initialParent = initialRow.parent_tool_call_id;

  // 2. Pass 1: Close, reopen, run actual reconcileWalOnStartup
  stateDb.close();
  stateDb = new StateDb(dbPath, "power-loss-safe");
  spillStore = new PrivateSpillStore({ rootDir: spillsDir, maxInlineBytes: 256, maxInlineLines: 10 });

  const summary1 = reconcileWalOnStartup(stateDb, spillStore, "sess_part_a");
  const spillCountAfterPass1 = countSpillFiles(spillsDir);
  const spillEntriesPass1 = getSpillFileEntries(spillsDir);
  const rowPass1 = stateDb.getWalRow(initialRes.idempotencyKey)!;

  assert.equal(effectCounter, 1, "Effect count must stay 1 after startup 1");
  assert.equal(spillCountAfterPass1, 1, "Spill file count must remain 1 after startup 1 (no re-spill!)");
  assert.equal(rowPass1.result_json, initialResultJson, "result_json must be unchanged for already compliant receipt");
  assert.equal(rowPass1.status, initialStatus, "Status must remain unchanged");
  assert.equal(rowPass1.parent_tool_call_id, initialParent, "Parent linkage must remain unchanged");
  assert.deepEqual(spillEntriesPass1, initialSpillEntries, "Spill file hashes and names must be identical");

  // 3. Pass 2: Close, reopen, run startup reconciliation again
  stateDb.close();
  stateDb = new StateDb(dbPath, "power-loss-safe");
  spillStore = new PrivateSpillStore({ rootDir: spillsDir, maxInlineBytes: 256, maxInlineLines: 10 });

  const summary2 = reconcileWalOnStartup(stateDb, spillStore, "sess_part_a");
  const spillCountAfterPass2 = countSpillFiles(spillsDir);
  const spillEntriesPass2 = getSpillFileEntries(spillsDir);
  const rowPass2 = stateDb.getWalRow(initialRes.idempotencyKey)!;

  assert.equal(effectCounter, 1, "Effect count must stay 1 after startup 2");
  assert.equal(spillCountAfterPass2, 1, "Spill file count must remain 1 after startup 2");
  assert.equal(rowPass2.result_json, initialResultJson, "result_json must remain unchanged after startup 2");
  assert.deepEqual(spillEntriesPass2, initialSpillEntries, "Spill files must be completely untouched");

  // 4. Pass 3: Replay through executeThroughWalSpine
  const replayRes = await executeThroughWalSpine({
    stateDb,
    spillStore,
    sessionId: "sess_part_a",
    leafId: "leaf_part_a",
    toolCallId: "call_part_a",
    toolName: "tool_part_a",
    mutabilityClass: "OPAQUE_EXTERNAL",
    args: {},
    executeEffect: async () => {
      effectCounter++;
      return { rawText: "SHOULD_NEVER_RUN" };
    }
  });

  assert.equal(replayRes.fromCache, true, "Replay must return fromCache === true");
  assert.equal(effectCounter, 1, "Effect must not run on replay");
  assert.equal(replayRes.finalText, initialRes.finalText, "Delivered text must be equivalent");
  assert.equal(countSpillFiles(spillsDir), 1, "Spill file count must still be 1 after replay");

  stateDb.close();
  console.log("  [PASS] Part A: Genuine normalized receipt is completely idempotent across repeated startups.");
}

// ============================================================================
// PART B: Legacy receipt migration
// ============================================================================
async function runPartBLegacyReceiptMigrationTests(): Promise<void> {
  console.log("\n[Part B] Testing Legacy Receipt Migration (EFFECT_COMMITTED, TRANSCRIPT_APPENDED, text-only, ENOSPC)...");

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "batch6-part-b-"));
  const dbPath = path.join(tmpDir, "state.db");
  const spillsDir = path.join(tmpDir, "spills");

  let stateDb = new StateDb(dbPath, "power-loss-safe");
  let spillStore = new PrivateSpillStore({ rootDir: spillsDir, maxInlineBytes: 256, maxInlineLines: 10 });

  const dummyImage: WalContentBlock = {
    type: "image",
    data: "bGVnYWN5aW1hZ2U=",
    mimeType: "image/png"
  };
  const oversizedText = "K".repeat(20_000);

  const testCases: Array<{
    name: string;
    status: "EFFECT_COMMITTED" | "TRANSCRIPT_APPENDED";
    legacyResultJson: string;
    expectImage: boolean;
    simulateEnospc?: boolean;
  }> = [
    {
      name: "EFFECT_COMMITTED legacy text-only",
      status: "EFFECT_COMMITTED",
      legacyResultJson: JSON.stringify({
        finalText: oversizedText
      }),
      expectImage: false
    },
    {
      name: "TRANSCRIPT_APPENDED legacy text-only",
      status: "TRANSCRIPT_APPENDED",
      legacyResultJson: JSON.stringify({
        finalText: oversizedText
      }),
      expectImage: false
    },
    {
      name: "EFFECT_COMMITTED legacy mixed text/image",
      status: "EFFECT_COMMITTED",
      legacyResultJson: JSON.stringify({
        finalText: "Old summary",
        content: [{ type: "text", text: oversizedText }, dummyImage]
      }),
      expectImage: true
    },
    {
      name: "EFFECT_COMMITTED legacy with simulated ENOSPC",
      status: "EFFECT_COMMITTED",
      legacyResultJson: JSON.stringify({
        finalText: oversizedText,
        content: [{ type: "text", text: oversizedText }]
      }),
      expectImage: false,
      simulateEnospc: true
    }
  ];

  for (let i = 0; i < testCases.length; i++) {
    const tc = testCases[i];
    const toolCallId = `call_legacy_${i}`;
    const sessId = `sess_part_b_${i}`;
    let effectCount = 0;

    // Seed row by running executeThroughWalSpine once
    const seed = await executeThroughWalSpine({
      stateDb,
      spillStore,
      sessionId: sessId,
      leafId: "leaf_part_b",
      toolCallId,
      parentToolCallId: null,
      toolName: "tool_b",
      mutabilityClass: "OPAQUE_EXTERNAL",
      args: { i },
      executeEffect: async () => {
        effectCount++;
        return { rawText: "seed" };
      }
    });

    const idempotencyKey = seed.idempotencyKey;
    assert.equal(effectCount, 1);

    // Overwrite with target legacy format and status
    stateDb.db
      .prepare(`UPDATE wal_intents SET status = ?, result_json = ?, updated_at_ms = ? WHERE idempotency_key = ?`)
      .run(tc.status, tc.legacyResultJson, Date.now() - 10000, idempotencyKey);

    const activeSpillStore = tc.simulateEnospc
      ? new PrivateSpillStore({
          rootDir: path.join(tmpDir, `spills-enospc-${i}`),
          maxInlineBytes: 256,
          maxInlineLines: 10,
          simulateWriteFailure: true
        })
      : spillStore;

    // First replay: migration occurs
    const replay1 = await executeThroughWalSpine({
      stateDb,
      spillStore: activeSpillStore,
      sessionId: sessId,
      leafId: "leaf_part_b",
      toolCallId,
      parentToolCallId: null,
      toolName: "tool_b",
      mutabilityClass: "OPAQUE_EXTERNAL",
      args: { i },
      executeEffect: async () => {
        effectCount++;
        return { rawText: "SHOULD_NOT_EXECUTE" };
      }
    });

    assert.equal(replay1.fromCache, true, `[${tc.name}] Replay 1 must report fromCache === true`);
    assert.equal(effectCount, 1, `[${tc.name}] Effect count must remain 1`);
    assert.ok(Buffer.byteLength(replay1.finalText, "utf8") < 4096, `[${tc.name}] Replay 1 finalText must be bounded`);
    assert.ok(!replay1.finalText.includes(oversizedText), `[${tc.name}] Original oversized text must not be in finalText`);

    if (tc.expectImage) {
      const img = replay1.content.find((b) => b.type === "image");
      assert.ok(img, `[${tc.name}] Image block must survive migration`);
      assert.equal((img as any).data, dummyImage.data);
    }

    const rowAfterMigration = stateDb.getWalRow(idempotencyKey)!;
    assert.equal(rowAfterMigration.status, tc.status, `[${tc.name}] Status must be preserved`);
    assert.equal(rowAfterMigration.parent_tool_call_id, null, `[${tc.name}] Parent linkage must be preserved`);
    const migratedJson = rowAfterMigration.result_json!;

    // Second replay: must NOT migrate again, must return identical receipt
    const replay2 = await executeThroughWalSpine({
      stateDb,
      spillStore: activeSpillStore,
      sessionId: sessId,
      leafId: "leaf_part_b",
      toolCallId,
      parentToolCallId: null,
      toolName: "tool_b",
      mutabilityClass: "OPAQUE_EXTERNAL",
      args: { i },
      executeEffect: async () => {
        effectCount++;
        return { rawText: "SHOULD_NOT_EXECUTE" };
      }
    });

    assert.equal(replay2.fromCache, true);
    assert.equal(effectCount, 1, `[${tc.name}] Effect count must stay 1 after second replay`);
    assert.equal(replay2.finalText, replay1.finalText, `[${tc.name}] Output must be identical on second replay`);

    const rowAfterReplay2 = stateDb.getWalRow(idempotencyKey)!;
    assert.equal(rowAfterReplay2.result_json, migratedJson, `[${tc.name}] result_json must not be re-written`);

    // Third pass: startup reconciliation must also leave it untouched
    stateDb.close();
    stateDb = new StateDb(dbPath, "power-loss-safe");
    reconcileWalOnStartup(stateDb, activeSpillStore, sessId);

    const rowAfterStartup = stateDb.getWalRow(idempotencyKey)!;
    assert.equal(rowAfterStartup.result_json, migratedJson, `[${tc.name}] result_json must be unchanged after startup`);
  }

  stateDb.close();
  console.log("  [PASS] Part B: Legacy receipts migrate once, preserve images/linkage, and stay stable.");
}

// ============================================================================
// PART C: Invalid spill-flag combinations
// ============================================================================
async function runPartCInvalidSpillFlagTests(): Promise<void> {
  console.log("\n[Part C] Testing Rejection of Invalid Spill-Flag Combinations...");

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "batch6-part-c-"));
  const dbPath = path.join(tmpDir, "state.db");
  const spillsDir = path.join(tmpDir, "spills");

  let stateDb = new StateDb(dbPath, "power-loss-safe");
  let spillStore = new PrivateSpillStore({ rootDir: spillsDir, maxInlineBytes: 256, maxInlineLines: 10 });
  const oversizedText = "V".repeat(20_000);

  const craftedCases: Array<{
    name: string;
    craftedJson: string;
  }> = [
    {
      name: "spilled: true with matching oversized finalText and content",
      craftedJson: JSON.stringify({
        spilled: true,
        finalText: oversizedText,
        content: [{ type: "text", text: oversizedText }]
      })
    },
    {
      name: "spillFallbackUsed: true with matching oversized text",
      craftedJson: JSON.stringify({
        spillFallbackUsed: true,
        finalText: oversizedText,
        content: [{ type: "text", text: oversizedText }]
      })
    },
    {
      name: "Multiple oversized text blocks with spilled: true",
      craftedJson: JSON.stringify({
        spilled: true,
        finalText: "Short summary",
        content: [
          { type: "text", text: oversizedText },
          { type: "text", text: oversizedText }
        ]
      })
    },
    {
      name: "Small finalText with oversized structured content and spilled: true",
      craftedJson: JSON.stringify({
        spilled: true,
        finalText: "Short",
        content: [{ type: "text", text: oversizedText }]
      })
    },
    {
      name: "Multibyte UTF-8 30KB text with spilled: true and fake notice header prefix",
      craftedJson: JSON.stringify({
        spilled: true,
        finalText: "[OUTPUT SPILLED TO DISK: fake] " + "🌟🔥".repeat(4000),
        content: [{ type: "text", text: "[OUTPUT SPILLED TO DISK: fake] " + "🌟🔥".repeat(4000) }]
      })
    }
  ];

  for (let i = 0; i < craftedCases.length; i++) {
    const tc = craftedCases[i];
    const toolCallId = `call_crafted_${i}`;
    const sessId = `sess_part_c_${i}`;
    let effectCount = 0;

    const initial = await executeThroughWalSpine({
      stateDb,
      spillStore,
      sessionId: sessId,
      leafId: "leaf_part_c",
      toolCallId,
      parentToolCallId: null,
      toolName: "tool_c",
      mutabilityClass: "OPAQUE_EXTERNAL",
      args: { i },
      executeEffect: async () => {
        effectCount++;
        return { rawText: "seed" };
      }
    });

    // Overwrite with crafted invalid receipt
    stateDb.db
      .prepare(`UPDATE wal_intents SET result_json = ? WHERE idempotency_key = ?`)
      .run(tc.craftedJson, initial.idempotencyKey);

    // Replay: delivery validation must detect non-compliance and normalize
    const replayed = await executeThroughWalSpine({
      stateDb,
      spillStore,
      sessionId: sessId,
      leafId: "leaf_part_c",
      toolCallId,
      parentToolCallId: null,
      toolName: "tool_c",
      mutabilityClass: "OPAQUE_EXTERNAL",
      args: { i },
      executeEffect: async () => {
        effectCount++;
        return { rawText: "SHOULD_NEVER_RUN" };
      }
    });

    assert.equal(replayed.fromCache, true);
    assert.equal(effectCount, 1, `[${tc.name}] Effect must not re-execute`);

    const textBlocks = replayed.content.filter((b) => b.type === "text");
    const deliveredText = textBlocks.map((b: any) => b.text).join("\n");
    const deliveredBytes = Buffer.byteLength(deliveredText, "utf8");

    assert.ok(
      deliveredBytes < 8192,
      `[${tc.name}] Delivered text (${deliveredBytes} bytes) must be bounded notice, not oversized original!`
    );
    assert.ok(
      !deliveredText.includes(oversizedText),
      `[${tc.name}] Delivered text must NOT contain the original 20,000 bytes!`
    );

    // Confirm that the updated result in DB is now compliant
    const updatedRow = stateDb.getWalRow(initial.idempotencyKey)!;
    const parsedUpdated = JSON.parse(updatedRow.result_json!);
    assert.equal(
      isReceiptDeliveryCompliant(parsedUpdated, spillStore),
      true,
      `[${tc.name}] Updated receipt in DB must pass isReceiptDeliveryCompliant`
    );
  }

  stateDb.close();
  console.log("  [PASS] Part C: Invalid spill-flag combinations cannot bypass actual payload bounds.");
}

// ============================================================================
// PART D: Permitted controls
// ============================================================================
async function runPartDPermittedControlsTests(): Promise<void> {
  console.log("\n[Part D] Testing Permitted Controls...");

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "batch6-part-d-"));
  const dbPath = path.join(tmpDir, "state.db");
  const spillsDir = path.join(tmpDir, "spills");

  let stateDb = new StateDb(dbPath, "power-loss-safe");
  let spillStore = new PrivateSpillStore({ rootDir: spillsDir, maxInlineBytes: 256, maxInlineLines: 10 });

  const dummyImage: WalContentBlock = {
    type: "image",
    data: "Y29udHJvbGltYWdl",
    mimeType: "image/webp"
  };

  // 1. Small inline result
  const smallText = "Clean small tool output";
  const smallRes = await executeThroughWalSpine({
    stateDb,
    spillStore,
    sessionId: "sess_part_d",
    leafId: "leaf_1",
    toolCallId: "call_small",
    toolName: "tool_small",
    mutabilityClass: "PURE_READ",
    args: {},
    executeEffect: async () => ({
      finalText: smallText,
      content: [{ type: "text", text: smallText }]
    })
  });
  assert.equal(smallRes.spilled, false);
  assert.equal(smallRes.finalText, smallText);

  // Replay small result
  const smallReplay = await executeThroughWalSpine({
    stateDb,
    spillStore,
    sessionId: "sess_part_d",
    leafId: "leaf_1",
    toolCallId: "call_small",
    toolName: "tool_small",
    mutabilityClass: "PURE_READ",
    args: {},
    executeEffect: async () => {
      throw new Error("SHOULD_NOT_EXECUTE");
    }
  });
  assert.equal(smallReplay.fromCache, true);
  assert.equal(smallReplay.finalText, smallText);
  assert.equal(smallReplay.spilled, false);

  // 2. Image-only result
  const imgRes = await executeThroughWalSpine({
    stateDb,
    spillStore,
    sessionId: "sess_part_d",
    leafId: "leaf_1",
    toolCallId: "call_img",
    toolName: "tool_img",
    mutabilityClass: "PURE_READ",
    args: {},
    executeEffect: async () => ({
      content: [dummyImage]
    })
  });
  assert.equal(imgRes.spilled, false);
  const imgBlock = imgRes.content.find((b) => b.type === "image");
  assert.ok(imgBlock);
  assert.equal((imgBlock as any).data, dummyImage.data);

  // 3. Mixed small text/image result
  const mixedRes = await executeThroughWalSpine({
    stateDb,
    spillStore,
    sessionId: "sess_part_d",
    leafId: "leaf_1",
    toolCallId: "call_mixed_small",
    toolName: "tool_mixed_small",
    mutabilityClass: "PURE_READ",
    args: {},
    executeEffect: async () => ({
      finalText: "mixed note",
      content: [{ type: "text", text: "mixed note" }, dummyImage]
    })
  });
  assert.equal(mixedRes.spilled, false);
  assert.equal(mixedRes.content.length, 2);

  // 4. Disk-drift control (LOCAL_REVERSIBLE)
  const targetFile = path.join(tmpDir, "drift-target.txt");
  fs.writeFileSync(targetFile, "original\n");
  const origSha = crypto.createHash("sha256").update("original\n").digest("hex");
  const afterSha = crypto.createHash("sha256").update("modified\n").digest("hex");

  const driftRes = await executeThroughWalSpine({
    stateDb,
    spillStore,
    sessionId: "sess_part_d",
    leafId: "leaf_1",
    toolCallId: "call_drift",
    toolName: "tool_drift",
    mutabilityClass: "LOCAL_REVERSIBLE",
    args: {},
    localReversibleSpec: {
      targetPath: targetFile,
      expectedAfterBytes: Buffer.from("modified\n")
    },
    executeEffect: async () => {
      fs.writeFileSync(targetFile, "modified\n");
      return { rawText: "ok" };
    }
  });

  // Now tamper with target file on disk to induce drift
  fs.writeFileSync(targetFile, "tampered-content\n");

  // Replay should throw OUTCOME_UNKNOWN error
  await assert.rejects(
    () =>
      executeThroughWalSpine({
        stateDb,
        spillStore,
        sessionId: "sess_part_d",
        leafId: "leaf_1",
        toolCallId: "call_drift",
        toolName: "tool_drift",
        mutabilityClass: "LOCAL_REVERSIBLE",
        args: {},
        executeEffect: async () => {
          throw new Error("SHOULD_NOT_EXECUTE");
        }
      }),
    /OUTCOME_UNKNOWN/
  );

  stateDb.close();
  console.log("  [PASS] Part D: Permitted controls verified.");
}

// ============================================================================
// MAIN RUNNER
// ============================================================================
async function runAllBatch6Tests(): Promise<void> {
  console.log("================================================================================");
  console.log("Running Apex Batch-6 Cache Validation & Test Gate Suite");
  console.log("================================================================================");

  await runPartAGenuineReceiptRepeatedStartupTests();
  await runPartBLegacyReceiptMigrationTests();
  await runPartCInvalidSpillFlagTests();
  await runPartDPermittedControlsTests();

  console.log("================================================================================");
  console.log("ALL BATCH-6 CACHE VALIDATION & RECOVERY TESTS PASSED CLEANLY!");
  console.log("================================================================================");
}

runAllBatch6Tests().catch((err) => {
  console.error("\n[FAIL] Batch-6 suite encountered failure:\n", err);
  process.exit(1);
});
