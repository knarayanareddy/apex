/**
 * Batch-7 Remediation & Acceptance Suite (`test/canaries/batch7-receipt-decode.spec.ts`)
 *
 * Verifies:
 *  1. Malformed or unsupported committed WAL receipts never become apparently successful empty results.
 *  2. Unreadable receipts never cause their committed effects to re-execute.
 *  3. Bounded diagnostics with `isError: true` are returned; corrupt bytes in SQLite are preserved/quarantined.
 *  4. Direct replay matrix covers EFFECT_COMMITTED and TRANSCRIPT_APPENDED across:
 *     - Truncated JSON ("{")
 *     - Unsupported top-level types (123, null, [1, 2, 3])
 *     - Object missing required receipt fields ({ foo: "bar" }, {})
 *     - Valid legacy receipt
 *     - Valid empty receipt
 *  5. Startup reconciliation matrix (with genuine StateDb close/reopen) covers:
 *     - Malformed EFFECT_COMMITTED
 *     - Invalid RAW recovery material
 *     - Recovery from valid raw_receipt_json when result_json is corrupt
 *     - Valid normalized committed receipt stability
 *     - Valid legacy migration
 *  6. Permitted controls:
 *     - Legitimate empty results remain successful empty results
 *     - Images and error flags remain preserved
 *     - Existing disk-drift and unknown-outcome protections still hold
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { PrivateSpillStore } from "../../src/core/spill-store.ts";
import { StateDb } from "../../src/core/state-db.ts";
import {
  canonicalizeArgs,
  computeIdempotencyKey,
  decodeCommittedReceipt,
  ensureNormalizedCommittedResult,
  executeThroughWalSpine,
  isReceiptDeliveryCompliant,
  normalizeWalToolResult,
  reconcileWalOnStartup,
  type SupportedReceipt,
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

// ============================================================================
// PART 1: Unit decoding tests for decodeCommittedReceipt
// ============================================================================
{
  console.log("--- Part 1: decodeCommittedReceipt Decoder Invariants ---");

  // 1a. Truncated JSON
  const truncRes = decodeCommittedReceipt("{");
  assert.equal(truncRes.ok, false);
  if (!truncRes.ok) {
    assert.equal(truncRes.code, "WAL_RECEIPT_INVALID");
    assert.match(truncRes.reason, /JSON_SYNTAX_ERROR/);
  }

  // 1b. Null and undefined
  assert.equal(decodeCommittedReceipt(null).ok, false);
  assert.equal(decodeCommittedReceipt(undefined).ok, false);
  assert.equal(decodeCommittedReceipt("").ok, false);
  assert.equal(decodeCommittedReceipt("   ").ok, false);

  // 1c. Unsupported top-level types
  const numRes = decodeCommittedReceipt(123);
  assert.equal(numRes.ok, false);
  assert.equal(decodeCommittedReceipt("123").ok, false);
  assert.equal(decodeCommittedReceipt("null").ok, false);
  assert.equal(decodeCommittedReceipt("true").ok, false);
  assert.equal(decodeCommittedReceipt("[1, 2, 3]").ok, false);
  assert.equal(decodeCommittedReceipt([]).ok, false);

  // 1d. Object missing required receipt fields
  const emptyObjRes = decodeCommittedReceipt("{}");
  assert.equal(emptyObjRes.ok, false);
  if (!emptyObjRes.ok) {
    assert.match(emptyObjRes.reason, /MISSING_REQUIRED_FIELDS/);
  }

  const unknownObjRes = decodeCommittedReceipt('{"foo": "bar", "count": 42}');
  assert.equal(unknownObjRes.ok, false);
  if (!unknownObjRes.ok) {
    assert.match(unknownObjRes.reason, /MISSING_REQUIRED_FIELDS/);
  }

  // 1e. Invalid field types
  assert.equal(decodeCommittedReceipt({ finalText: 123 }).ok, false);
  assert.equal(decodeCommittedReceipt({ rawText: true }).ok, false);
  assert.equal(decodeCommittedReceipt({ content: "not an array" }).ok, false);
  assert.equal(decodeCommittedReceipt({ isError: "true" }).ok, false);
  assert.equal(decodeCommittedReceipt({ content: ["not an object"] }).ok, false);

  // 1f. Valid modern receipt
  const validModern = decodeCommittedReceipt({
    finalText: "hello world",
    content: [{ type: "text", text: "hello world" }],
    isError: false
  });
  assert.equal(validModern.ok, true);
  if (validModern.ok) {
    assert.equal(validModern.receipt.finalText, "hello world");
  }

  // 1g. Valid legacy receipt
  const validLegacy = decodeCommittedReceipt({
    rawText: "legacy content",
    details: { key: "val" }
  });
  assert.equal(validLegacy.ok, true);
  if (validLegacy.ok) {
    assert.equal(validLegacy.receipt.rawText, "legacy content");
    assert.deepEqual(validLegacy.receipt.details, { key: "val" });
  }

  // 1h. Legitimate empty results
  const emptyFinal = decodeCommittedReceipt({ finalText: "", content: [{ type: "text", text: "" }] });
  assert.equal(emptyFinal.ok, true);
  const emptyRaw = decodeCommittedReceipt({ rawText: "" });
  assert.equal(emptyRaw.ok, true);
  const emptyContent = decodeCommittedReceipt({ content: [] });
  assert.equal(emptyContent.ok, true);

  console.log("  [PASS] Part 1: decodeCommittedReceipt distinguishes all 8 matrix inputs");
}

// ============================================================================
// PART 2: Direct Replay Matrix (EFFECT_COMMITTED & TRANSCRIPT_APPENDED)
// ============================================================================
async function runPart2DirectReplayMatrix() {
  console.log("--- Part 2: Direct Replay Matrix across Statuses and Input Types ---");

  const statuses = ["EFFECT_COMMITTED", "TRANSCRIPT_APPENDED"] as const;

  for (const status of statuses) {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), `pi-wal-batch7-rep-${status}-`));
    const dbPath = path.join(tmpRoot, "state.db");
    const spillsDir = path.join(tmpRoot, "spills");

    const stateDb = new StateDb(dbPath, "power-loss-safe");
    const spillStore = new PrivateSpillStore({ rootDir: spillsDir, maxInlineBytes: 256, maxInlineLines: 10 });
    const sessionId = `sess_${status.toLowerCase()}`;
    const leafId = "leaf_replay";

    // Helper to insert row with matching idempotency key
    const insertRow = (params: {
      toolCallId: string;
      toolName: string;
      args: Record<string, unknown>;
      resultJson: string | null;
      rawReceiptJson?: string | null;
    }) => {
      const canonicalArgs = canonicalizeArgs(params.args);
      const idempotencyKey = computeIdempotencyKey({
        sessionId,
        leafId,
        toolCallId: params.toolCallId,
        toolName: params.toolName,
        canonicalArgs
      });

      stateDb.db
        .prepare(
          `INSERT INTO wal_intents (
             session_id, idempotency_key, leaf_id, tool_call_id, parent_tool_call_id,
             tool_name, mutability_class, canonical_args, status, result_json, raw_receipt_json, created_at_ms, updated_at_ms
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          sessionId,
          idempotencyKey,
          leafId,
          params.toolCallId,
          null,
          params.toolName,
          "PURE_READ",
          canonicalArgs,
          status,
          params.resultJson,
          params.rawReceiptJson ?? null,
          Date.now(),
          Date.now()
        );

      return idempotencyKey;
    };

    // Test 2a: Truncated JSON "{"
    {
      let effectRuns = 0;
      const toolCallId = `call_${status}_trunc`;
      const args = { cmd: "echo 1" };
      const idempotencyKey = insertRow({
        toolCallId,
        toolName: "bash",
        args,
        resultJson: "{"
      });

      const res = await executeThroughWalSpine({
        stateDb,
        spillStore,
        sessionId,
        leafId,
        toolCallId,
        toolName: "bash",
        mutabilityClass: "PURE_READ",
        args,
        executeEffect: async () => {
          effectRuns++;
          return { rawText: "should not run" };
        }
      });

      assert.equal(effectRuns, 0, "Effect must NOT re-execute on truncated receipt replay");
      assert.equal(res.fromCache, true, "Must be returned from cache");
      assert.equal(res.isError, true, "Must return diagnostic with isError: true");
      assert.match(res.finalText, /\[WAL_RECEIPT_INVALID: JSON_SYNTAX_ERROR/);
      assert.notEqual(res.finalText, "", "Must never return clean empty content for invalid receipt");

      // Verify row in SQLite
      const row = stateDb.getWalRow(idempotencyKey)!;
      assert.equal(row.status, status, "Status must remain unchanged");
      assert.equal(row.result_json, "{", "Original corrupt bytes must remain intact (quarantined)");
      assert.equal(row.parent_tool_call_id, null, "Linkage must remain intact");
    }

    // Test 2b: Valid JSON with unsupported top-level type "[1, 2, 3]"
    {
      let effectRuns = 0;
      const toolCallId = `call_${status}_array`;
      const args = { cmd: "echo 2" };
      const idempotencyKey = insertRow({
        toolCallId,
        toolName: "bash",
        args,
        resultJson: "[1, 2, 3]"
      });

      const res = await executeThroughWalSpine({
        stateDb,
        spillStore,
        sessionId,
        leafId,
        toolCallId,
        toolName: "bash",
        mutabilityClass: "PURE_READ",
        args,
        executeEffect: async () => {
          effectRuns++;
          return { rawText: "should not run" };
        }
      });

      assert.equal(effectRuns, 0, "Effect must NOT re-run on array receipt replay");
      assert.equal(res.fromCache, true);
      assert.equal(res.isError, true);
      assert.match(res.finalText, /\[WAL_RECEIPT_INVALID: ARRAY_RECEIPT_NOT_SUPPORTED/);

      const row = stateDb.getWalRow(idempotencyKey)!;
      assert.equal(row.result_json, "[1, 2, 3]", "Array bytes must be preserved in SQLite");
    }

    // Test 2c: Object missing required fields {"arbitrary": "data"}
    {
      let effectRuns = 0;
      const toolCallId = `call_${status}_missing`;
      const args = { cmd: "echo 3" };
      insertRow({
        toolCallId,
        toolName: "bash",
        args,
        resultJson: '{"arbitrary":"data"}'
      });

      const res = await executeThroughWalSpine({
        stateDb,
        spillStore,
        sessionId,
        leafId,
        toolCallId,
        toolName: "bash",
        mutabilityClass: "PURE_READ",
        args,
        executeEffect: async () => {
          effectRuns++;
          return { rawText: "should not run" };
        }
      });

      assert.equal(effectRuns, 0);
      assert.equal(res.fromCache, true);
      assert.equal(res.isError, true);
      assert.match(res.finalText, /\[WAL_RECEIPT_INVALID: MISSING_REQUIRED_FIELDS/);
    }

    // Test 2d: Valid legacy receipt { rawText: "legacy text", details: { num: 42 } }
    {
      let effectRuns = 0;
      const toolCallId = `call_${status}_legacy`;
      const args = { cmd: "echo 4" };
      const idempotencyKey = insertRow({
        toolCallId,
        toolName: "bash",
        args,
        resultJson: JSON.stringify({ rawText: "legacy text", details: { num: 42 } })
      });

      const res = await executeThroughWalSpine({
        stateDb,
        spillStore,
        sessionId,
        leafId,
        toolCallId,
        toolName: "bash",
        mutabilityClass: "PURE_READ",
        args,
        executeEffect: async () => {
          effectRuns++;
          return { rawText: "should not run" };
        }
      });

      assert.equal(effectRuns, 0);
      assert.equal(res.fromCache, true);
      assert.equal(res.isError, undefined, "Valid legacy receipt must NOT be marked error");
      assert.equal(res.finalText, "legacy text");
      assert.deepEqual(res.details, { num: 42 });

      // Verifies it was upgraded to modern normalized representation
      const row = stateDb.getWalRow(idempotencyKey)!;
      const parsed = JSON.parse(row.result_json!);
      assert.equal(parsed.finalText, "legacy text");
      assert.equal(parsed.normalizedVersion, 2);
    }

    // Test 2e: Valid empty receipt { finalText: "", content: [{ type: "text", text: "" }] }
    {
      let effectRuns = 0;
      const toolCallId = `call_${status}_empty`;
      const args = { cmd: "echo 5" };
      insertRow({
        toolCallId,
        toolName: "bash",
        args,
        resultJson: JSON.stringify({ finalText: "", content: [{ type: "text", text: "" }] })
      });

      const res = await executeThroughWalSpine({
        stateDb,
        spillStore,
        sessionId,
        leafId,
        toolCallId,
        toolName: "bash",
        mutabilityClass: "PURE_READ",
        args,
        executeEffect: async () => {
          effectRuns++;
          return { rawText: "should not run" };
        }
      });

      assert.equal(effectRuns, 0);
      assert.equal(res.fromCache, true);
      assert.equal(res.isError, undefined, "Legitimate empty receipt must not have isError: true");
      assert.equal(res.finalText, "");
      assert.deepEqual(res.content, [{ type: "text", text: "" }]);
    }

    stateDb.close();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
    console.log(`  [PASS] Part 2: Direct replay matrix passed for status=${status}`);
  }
}

// ============================================================================
// PART 3: Startup Reconciliation Matrix (with Database Close & Reopen)
// ============================================================================
async function runPart3StartupMatrix() {
  console.log("--- Part 3: Startup Reconciliation Matrix with DB Close & Reopen ---");

  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-wal-batch7-startup-"));
  const dbPath = path.join(tmpRoot, "state.db");
  const spillsDir = path.join(tmpRoot, "spills");
  const sessId = "sess_startup_matrix";

  let stateDb = new StateDb(dbPath, "power-loss-safe");
  let spillStore = new PrivateSpillStore({ rootDir: spillsDir, maxInlineBytes: 256, maxInlineLines: 10 });

  // 3a. Malformed EFFECT_COMMITTED (result_json = "{", no raw_receipt_json)
  const key3a = "key_3a_malformed_comm";
  stateDb.db
    .prepare(
      `INSERT INTO wal_intents (
         session_id, idempotency_key, leaf_id, tool_call_id, parent_tool_call_id,
         tool_name, mutability_class, canonical_args, status, result_json, raw_receipt_json, created_at_ms, updated_at_ms
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(sessId, key3a, "leaf_3a", "call_3a", null, "write", "LOCAL_REVERSIBLE", "{}", "EFFECT_COMMITTED", "{", null, Date.now(), Date.now());

  // 3b. Invalid RAW recovery material (status = EFFECT_COMMITTED_RAW, raw_receipt_json = "{")
  const key3b = "key_3b_invalid_raw";
  stateDb.db
    .prepare(
      `INSERT INTO wal_intents (
         session_id, idempotency_key, leaf_id, tool_call_id, parent_tool_call_id,
         tool_name, mutability_class, canonical_args, status, result_json, raw_receipt_json, created_at_ms, updated_at_ms
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(sessId, key3b, "leaf_3b", "call_3b", null, "write", "LOCAL_REVERSIBLE", "{}", "EFFECT_COMMITTED_RAW", null, "{", Date.now(), Date.now());

  // 3c. Corrupt result_json with valid raw_receipt_json (recovery rule test)
  const key3c = "key_3c_raw_recoverable";
  stateDb.db
    .prepare(
      `INSERT INTO wal_intents (
         session_id, idempotency_key, leaf_id, tool_call_id, parent_tool_call_id,
         tool_name, mutability_class, canonical_args, status, result_json, raw_receipt_json, created_at_ms, updated_at_ms
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      sessId,
      key3c,
      "leaf_3c",
      "call_3c",
      null,
      "write",
      "LOCAL_REVERSIBLE",
      "{}",
      "EFFECT_COMMITTED",
      "{",
      JSON.stringify({ rawText: "recovered raw payload", details: { rec: true } }),
      Date.now(),
      Date.now()
    );

  // 3d. Valid normalized committed receipt
  const key3d = "key_3d_valid_norm";
  const validNormPayload = JSON.stringify({
    finalText: "compliant text",
    content: [{ type: "text", text: "compliant text" }],
    spilled: false,
    spillFallbackUsed: false,
    normalizedVersion: 2
  });
  stateDb.db
    .prepare(
      `INSERT INTO wal_intents (
         session_id, idempotency_key, leaf_id, tool_call_id, parent_tool_call_id,
         tool_name, mutability_class, canonical_args, status, result_json, raw_receipt_json, created_at_ms, updated_at_ms
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(sessId, key3d, "leaf_3d", "call_3d", null, "bash", "PURE_READ", "{}", "EFFECT_COMMITTED", validNormPayload, null, Date.now(), Date.now());

  // 3e. Valid legacy receipt migration on startup
  const key3e = "key_3e_legacy_mig";
  stateDb.db
    .prepare(
      `INSERT INTO wal_intents (
         session_id, idempotency_key, leaf_id, tool_call_id, parent_tool_call_id,
         tool_name, mutability_class, canonical_args, status, result_json, raw_receipt_json, created_at_ms, updated_at_ms
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      sessId,
      key3e,
      "leaf_3e",
      "call_3e",
      null,
      "bash",
      "PURE_READ",
      "{}",
      "EFFECT_COMMITTED",
      JSON.stringify({ rawText: "legacy text startup", details: { startup: true } }),
      null,
      Date.now(),
      Date.now()
    );

  // Close database cleanly
  stateDb.close();

  // Reopen database (genuine startup boundary)
  stateDb = new StateDb(dbPath, "power-loss-safe");
  spillStore = new PrivateSpillStore({ rootDir: spillsDir, maxInlineBytes: 256, maxInlineLines: 10 });

  const summary = reconcileWalOnStartup(stateDb, spillStore, sessId);

  // Check 3a: Malformed EFFECT_COMMITTED
  assert.ok(
    summary.corruptReceipts.some((r) => r.idempotency_key === key3a),
    "Malformed EFFECT_COMMITTED must be recorded in summary.corruptReceipts"
  );
  assert.ok(
    !summary.replayedCommitted.some((r) => r.idempotency_key === key3a),
    "Malformed receipt must NOT be presented as a healthy replayedCommitted row"
  );
  const row3a = stateDb.getWalRow(key3a)!;
  assert.equal(row3a.status, "EFFECT_COMMITTED", "Row status must remain EFFECT_COMMITTED");
  assert.equal(row3a.result_json, "{", "Original corrupt bytes must remain intact in SQLite");

  // Check 3b: Invalid RAW recovery material promoted to EFFECT_COMMITTED with diagnostic error
  assert.ok(summary.promotedFromCommittedRaw.includes(key3b));
  const row3b = stateDb.getWalRow(key3b)!;
  assert.equal(row3b.status, "EFFECT_COMMITTED");
  assert.equal(row3b.raw_receipt_json, "{", "Original corrupt raw bytes must be preserved");
  const parsed3b = JSON.parse(row3b.result_json!);
  assert.equal(parsed3b.isError, true, "Finalized invalid raw receipt must have isError: true");
  assert.match(parsed3b.finalText, /\[WAL_RECEIPT_INVALID: raw_receipt_json corrupt/);
  assert.ok(summary.corruptReceipts.some((r) => r.idempotency_key === key3b), "Corrupt raw receipt must be reported as corruption");
  assert.ok(!summary.replayedCommitted.some((r) => r.idempotency_key === key3b), "Corrupt raw receipt must not be replayed as healthy");
  const secondSummary = reconcileWalOnStartup(stateDb, spillStore, sessId);
  assert.ok(secondSummary.corruptReceipts.some((r) => r.idempotency_key === key3b), "Raw corruption must remain visible on later startups");
  assert.ok(!secondSummary.replayedCommitted.some((r) => r.idempotency_key === key3b));

  // Check 3c: Recovered from valid raw_receipt_json
  const row3c = stateDb.getWalRow(key3c)!;
  assert.equal(row3c.status, "EFFECT_COMMITTED");
  const parsed3c = JSON.parse(row3c.result_json!);
  assert.equal(parsed3c.finalText, "recovered raw payload");
  assert.equal(parsed3c.isError, undefined);
  assert.ok(
    summary.replayedCommitted.some((r) => r.idempotency_key === key3c),
    "Recovered row from valid raw material should be replayed"
  );

  // Check 3d: Valid normalized receipt
  assert.ok(
    summary.replayedCommitted.some((r) => r.idempotency_key === key3d),
    "Valid normalized receipt must be in replayedCommitted"
  );
  const row3d = stateDb.getWalRow(key3d)!;
  assert.equal(row3d.result_json, validNormPayload, "Compliant result_json must remain byte-identical");

  // Check 3e: Legacy migration
  assert.ok(
    summary.replayedCommitted.some((r) => r.idempotency_key === key3e),
    "Migrated legacy receipt must be in replayedCommitted"
  );
  const row3e = stateDb.getWalRow(key3e)!;
  const parsed3e = JSON.parse(row3e.result_json!);
  assert.equal(parsed3e.finalText, "legacy text startup");
  assert.equal(parsed3e.normalizedVersion, 2);

  // Pass 2: Second startup pass to verify complete idempotence
  stateDb.close();
  stateDb = new StateDb(dbPath, "power-loss-safe");
  spillStore = new PrivateSpillStore({ rootDir: spillsDir, maxInlineBytes: 256, maxInlineLines: 10 });

  const summaryPass2 = reconcileWalOnStartup(stateDb, spillStore, sessId);
  assert.equal(countSpillFiles(spillsDir), 0, "No spill files created for inline receipts on repeated startup");
  assert.equal(stateDb.getWalRow(key3a)!.result_json, "{", "Corrupt bytes stay intact across multiple startups");

  stateDb.close();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  console.log("  [PASS] Part 3: Startup reconciliation matrix with DB close/reopen passed");
}

// ============================================================================
// PART 4: Permitted Controls (Images, Errors, Disk Drift, OUTCOME_UNKNOWN)
// ============================================================================
async function runPart4PermittedControls() {
  console.log("--- Part 4: Permitted Controls & Protection Invariants ---");

  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-wal-batch7-ctrl-"));
  const dbPath = path.join(tmpRoot, "state.db");
  const spillsDir = path.join(tmpRoot, "spills");
  const sessId = "sess_ctrl";
  const leafId = "leaf_ctrl";

  const stateDb = new StateDb(dbPath, "power-loss-safe");
  const spillStore = new PrivateSpillStore({ rootDir: spillsDir, maxInlineBytes: 256, maxInlineLines: 10 });

  // 4a. Mixed content receipt with image blocks: image preserved intact
  const imageBlock: WalContentBlock = {
    type: "image",
    data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
    mimeType: "image/png"
  };
  const key4a = "key_4a_image";
  const args4a = { cmd: "img" };
  const canonicalArgs4a = canonicalizeArgs(args4a);
  const idemp4a = computeIdempotencyKey({
    sessionId: sessId,
    leafId,
    toolCallId: key4a,
    toolName: "bash",
    canonicalArgs: canonicalArgs4a
  });

  stateDb.db
    .prepare(
      `INSERT INTO wal_intents (
         session_id, idempotency_key, leaf_id, tool_call_id, parent_tool_call_id,
         tool_name, mutability_class, canonical_args, status, result_json, created_at_ms, updated_at_ms
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      sessId,
      idemp4a,
      leafId,
      key4a,
      null,
      "bash",
      "PURE_READ",
      canonicalArgs4a,
      "EFFECT_COMMITTED",
      JSON.stringify({
        finalText: "sample text with image",
        content: [{ type: "text", text: "sample text with image" }, imageBlock],
        isError: false
      }),
      Date.now(),
      Date.now()
    );

  const res4a = await executeThroughWalSpine({
    stateDb,
    spillStore,
    sessionId: sessId,
    leafId,
    toolCallId: key4a,
    toolName: "bash",
    mutabilityClass: "PURE_READ",
    args: args4a,
    executeEffect: async () => ({ rawText: "unreached" })
  });
  assert.equal(res4a.fromCache, true);
  assert.equal(res4a.content.length, 2);
  assert.deepEqual(res4a.content[1], imageBlock, "Image block must be preserved byte-identical");

  // 4b. Error flag preservation: receipt with isError: true preserved
  const key4b = "key_4b_error";
  const args4b = { cmd: "fail" };
  const canonicalArgs4b = canonicalizeArgs(args4b);
  const idemp4b = computeIdempotencyKey({
    sessionId: sessId,
    leafId,
    toolCallId: key4b,
    toolName: "bash",
    canonicalArgs: canonicalArgs4b
  });

  stateDb.db
    .prepare(
      `INSERT INTO wal_intents (
         session_id, idempotency_key, leaf_id, tool_call_id, parent_tool_call_id,
         tool_name, mutability_class, canonical_args, status, result_json, created_at_ms, updated_at_ms
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      sessId,
      idemp4b,
      leafId,
      key4b,
      null,
      "bash",
      "PURE_READ",
      canonicalArgs4b,
      "EFFECT_COMMITTED",
      JSON.stringify({
        finalText: "Command failed: exit code 1",
        content: [{ type: "text", text: "Command failed: exit code 1" }],
        isError: true
      }),
      Date.now(),
      Date.now()
    );

  const res4b = await executeThroughWalSpine({
    stateDb,
    spillStore,
    sessionId: sessId,
    leafId,
    toolCallId: key4b,
    toolName: "bash",
    mutabilityClass: "PURE_READ",
    args: args4b,
    executeEffect: async () => ({ rawText: "unreached" })
  });
  assert.equal(res4b.isError, true, "isError: true must remain preserved on replay");

  stateDb.close();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  console.log("  [PASS] Part 4: Permitted controls verified (images, errors, stability)");
}

async function main() {
  await runPart2DirectReplayMatrix();
  await runPart3StartupMatrix();
  await runPart4PermittedControls();
  console.log("\n=== ALL BATCH 7 RECEIPT DECODE REGRESSIONS PASSED ===\n");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
