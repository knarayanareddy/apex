/**
 * Batch A Verification Suite (`test/canaries/batchA-receipt-corruption.spec.ts`)
 *
 * Covers:
 *  - A1: Missing, NULL, and empty RAW receipts on EFFECT_COMMITTED_RAW never fabricate clean success.
 *        Valid empty receipts succeed; invalid cases return bounded isError: true.
 *  - A2: Validate NULL/empty committed results during startup without truthiness skip.
 *        Direct replay and startup agree; corrupt rows quarantined; valid RAW repairs.
 *  - A3: Discriminated union validation for content blocks (text requires string, image requires data/mimeType).
 *  - A4: Redaction of corrupt input/secrets from diagnostics and logs (JSON_SYNTAX_ERROR).
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
  reconcileWalOnStartup,
  type SupportedReceipt,
  type WalContentBlock
} from "../../src/core/wal-recovery.ts";

// Helper to insert a wal row
function insertWalRow(params: {
  stateDb: StateDb;
  sessionId: string;
  leafId: string;
  toolCallId: string;
  parentToolCallId?: string | null;
  toolName?: string;
  mutabilityClass?: "PURE_READ" | "LOCAL_REVERSIBLE" | "LOCAL_IRREVERSIBLE";
  args?: Record<string, unknown>;
  status: string;
  rawReceiptJson?: string | null;
  resultJson?: string | null;
}) {
  const args = params.args ?? { cmd: "test" };
  const canonicalArgs = canonicalizeArgs(args);
  const idemp = computeIdempotencyKey({
    sessionId: params.sessionId,
    leafId: params.leafId,
    toolCallId: params.toolCallId,
    toolName: params.toolName ?? "bash",
    canonicalArgs
  });
  const now = Date.now();
  params.stateDb.db
    .prepare(
      `INSERT INTO wal_intents (
         session_id, idempotency_key, leaf_id, tool_call_id, parent_tool_call_id,
         tool_name, mutability_class, canonical_args, status, raw_receipt_json, result_json,
         created_at_ms, updated_at_ms
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      params.sessionId,
      idemp,
      params.leafId,
      params.toolCallId,
      params.parentToolCallId ?? null,
      params.toolName ?? "bash",
      params.mutabilityClass ?? "PURE_READ",
      canonicalArgs,
      params.status,
      params.rawReceiptJson ?? null,
      params.resultJson ?? null,
      now,
      now
    );
  return idemp;
}

// ============================================================================
// A1: Missing RAW receipts must not become clean empty success
// ============================================================================
async function testA1MissingRawReceipts() {
  console.log("--- A1: Missing RAW receipts on EFFECT_COMMITTED_RAW ---");

  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-wal-a1-"));
  const dbPath = path.join(tmpRoot, "state.db");
  const spillsDir = path.join(tmpRoot, "spills");
  const sessId = "sess_a1";
  const leafId = "leaf_a1";

  // Case 1: Direct replay of EFFECT_COMMITTED_RAW with raw_receipt_json = NULL
  {
    const stateDb = new StateDb(dbPath, "power-loss-safe");
    const spillStore = new PrivateSpillStore({ rootDir: spillsDir, maxInlineBytes: 256, maxInlineLines: 10 });
    let effectExecutions = 0;

    const idempNull = insertWalRow({
      stateDb,
      sessionId: sessId,
      leafId,
      toolCallId: "call_a1_null",
      status: "EFFECT_COMMITTED_RAW",
      rawReceiptJson: null
    });

    const res = await executeThroughWalSpine({
      stateDb,
      spillStore,
      sessionId: sessId,
      leafId,
      toolCallId: "call_a1_null",
      toolName: "bash",
      mutabilityClass: "PURE_READ",
      args: { cmd: "test" },
      executeEffect: async () => {
        effectExecutions++;
        return { rawText: "unreached" };
      }
    });

    assert.equal(effectExecutions, 0, "A1: Effect must never re-execute");
    assert.equal(res.isError, true, "A1: Missing NULL raw receipt must return isError: true");
    assert.match(res.finalText, /WAL_RECEIPT_INVALID/, "A1: Explicit bounded error required");
    assert.notEqual(res.finalText, "", "A1: Must never fabricate clean empty success");

    // Case 2: raw_receipt_json = "" (empty string)
    const idempEmptyStr = insertWalRow({
      stateDb,
      sessionId: sessId,
      leafId,
      toolCallId: "call_a1_empty_str",
      status: "EFFECT_COMMITTED_RAW",
      rawReceiptJson: ""
    });

    const resEmpty = await executeThroughWalSpine({
      stateDb,
      spillStore,
      sessionId: sessId,
      leafId,
      toolCallId: "call_a1_empty_str",
      toolName: "bash",
      mutabilityClass: "PURE_READ",
      args: { cmd: "test" },
      executeEffect: async () => {
        effectExecutions++;
        return { rawText: "unreached" };
      }
    });

    assert.equal(effectExecutions, 0, "A1: Effect must never re-execute");
    assert.equal(resEmpty.isError, true, "A1: Empty raw receipt must return isError: true");
    assert.match(resEmpty.finalText, /WAL_RECEIPT_INVALID/);

    // Case 3: Malformed RAW JSON
    const idempMalformed = insertWalRow({
      stateDb,
      sessionId: sessId,
      leafId,
      toolCallId: "call_a1_malformed",
      status: "EFFECT_COMMITTED_RAW",
      rawReceiptJson: "{"
    });

    const resMalformed = await executeThroughWalSpine({
      stateDb,
      spillStore,
      sessionId: sessId,
      leafId,
      toolCallId: "call_a1_malformed",
      toolName: "bash",
      mutabilityClass: "PURE_READ",
      args: { cmd: "test" },
      executeEffect: async () => {
        effectExecutions++;
        return { rawText: "unreached" };
      }
    });

    assert.equal(effectExecutions, 0, "A1: Effect must never re-execute");
    assert.equal(resMalformed.isError, true);
    assert.match(resMalformed.finalText, /JSON_SYNTAX_ERROR/);

    // Case 4 (Permitted Control): Valid encoded empty result
    const idempValidEmpty = insertWalRow({
      stateDb,
      sessionId: sessId,
      leafId,
      toolCallId: "call_a1_valid_empty",
      status: "EFFECT_COMMITTED_RAW",
      rawReceiptJson: JSON.stringify({ rawText: "" })
    });

    const resValidEmpty = await executeThroughWalSpine({
      stateDb,
      spillStore,
      sessionId: sessId,
      leafId,
      toolCallId: "call_a1_valid_empty",
      toolName: "bash",
      mutabilityClass: "PURE_READ",
      args: { cmd: "test" },
      executeEffect: async () => {
        effectExecutions++;
        return { rawText: "unreached" };
      }
    });

    assert.equal(effectExecutions, 0);
    assert.equal(resValidEmpty.isError, undefined, "A1: Valid encoded empty result must NOT be an error");
    assert.equal(resValidEmpty.finalText, "");

    // Case 5 (Permitted Control): Valid structured RAW result with image
    const validImageBlock: WalContentBlock = {
      type: "image",
      data: "aW1n",
      mimeType: "image/png"
    };
    const idempValidImage = insertWalRow({
      stateDb,
      sessionId: sessId,
      leafId,
      toolCallId: "call_a1_valid_img",
      status: "EFFECT_COMMITTED_RAW",
      rawReceiptJson: JSON.stringify({
        content: [{ type: "text", text: "captured screenshot" }, validImageBlock]
      })
    });

    const resValidImg = await executeThroughWalSpine({
      stateDb,
      spillStore,
      sessionId: sessId,
      leafId,
      toolCallId: "call_a1_valid_img",
      toolName: "bash",
      mutabilityClass: "PURE_READ",
      args: { cmd: "test" },
      executeEffect: async () => {
        effectExecutions++;
        return { rawText: "unreached" };
      }
    });

    assert.equal(effectExecutions, 0);
    assert.equal(resValidImg.isError, undefined);
    assert.equal(resValidImg.content.length, 2);
    assert.deepEqual(resValidImg.content[1], validImageBlock);

    stateDb.close();
  }

  // Now test startup reconciliation after closing and reopening DB
  {
    const stateDb = new StateDb(dbPath, "power-loss-safe");
    const spillStore = new PrivateSpillStore({ rootDir: spillsDir, maxInlineBytes: 256, maxInlineLines: 10 });

    // Insert new unpromoted rows to test startup reconciliation directly
    const keyStartupNull = insertWalRow({
      stateDb,
      sessionId: sessId,
      leafId,
      toolCallId: "call_a1_startup_null",
      status: "EFFECT_COMMITTED_RAW",
      rawReceiptJson: null
    });

    const keyStartupEmpty = insertWalRow({
      stateDb,
      sessionId: sessId,
      leafId,
      toolCallId: "call_a1_startup_empty",
      status: "EFFECT_COMMITTED_RAW",
      rawReceiptJson: ""
    });

    const summary = reconcileWalOnStartup(stateDb, spillStore, sessId);
    assert.ok(summary.promotedFromCommittedRaw.includes(keyStartupNull));
    assert.ok(summary.promotedFromCommittedRaw.includes(keyStartupEmpty));

    // The promoted rows must have been promoted to EFFECT_COMMITTED with isError: true
    const rowNull = stateDb.getWalRow(keyStartupNull)!;
    assert.equal(rowNull.status, "EFFECT_COMMITTED");
    const parsedNull = JSON.parse(rowNull.result_json!);
    assert.equal(parsedNull.isError, true);
    assert.match(parsedNull.finalText, /WAL_RECEIPT_INVALID/);

    const rowEmpty = stateDb.getWalRow(keyStartupEmpty)!;
    assert.equal(rowEmpty.status, "EFFECT_COMMITTED");
    const parsedEmpty = JSON.parse(rowEmpty.result_json!);
    assert.equal(parsedEmpty.isError, true);
    assert.match(parsedEmpty.finalText, /WAL_RECEIPT_INVALID/);

    stateDb.close();
  }

  fs.rmSync(tmpRoot, { recursive: true, force: true });
  console.log("  [PASS] A1 verified: Missing RAW receipts produce explicit errors and never fabricate success.");
}

// ============================================================================
// A2: Validate NULL/empty committed results during startup
// ============================================================================
async function testA2StartupCommittedValidation() {
  console.log("--- A2: Validate NULL/empty committed results during startup ---");

  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-wal-a2-"));
  const dbPath = path.join(tmpRoot, "state.db");
  const spillsDir = path.join(tmpRoot, "spills");
  const sessId = "sess_a2";
  const leafId = "leaf_a2";

  const stateDb = new StateDb(dbPath, "power-loss-safe");
  const spillStore = new PrivateSpillStore({ rootDir: spillsDir, maxInlineBytes: 256, maxInlineLines: 10 });

  // 1. Committed row with result_json = NULL and no raw recovery
  const keyNull = insertWalRow({
    stateDb,
    sessionId: sessId,
    leafId,
    toolCallId: "call_a2_null",
    status: "EFFECT_COMMITTED",
    resultJson: null
  });

  // 2. Committed row with result_json = "" (empty string) and no raw recovery
  const keyEmpty = insertWalRow({
    stateDb,
    sessionId: sessId,
    leafId,
    toolCallId: "call_a2_empty",
    status: "EFFECT_COMMITTED",
    resultJson: ""
  });

  // 3. Committed row with result_json = "{" and no raw recovery
  const keyMalformed = insertWalRow({
    stateDb,
    sessionId: sessId,
    leafId,
    toolCallId: "call_a2_malformed",
    status: "EFFECT_COMMITTED",
    resultJson: "{"
  });

  // 4. Committed row with result_json = NULL but valid raw_receipt_json (recovery control)
  const keyRecoverable = insertWalRow({
    stateDb,
    sessionId: sessId,
    leafId,
    toolCallId: "call_a2_recoverable",
    status: "EFFECT_COMMITTED",
    rawReceiptJson: JSON.stringify({ rawText: "recovered payload" }),
    resultJson: null
  });

  // 5. Normal valid committed row
  const keyValid = insertWalRow({
    stateDb,
    sessionId: sessId,
    leafId,
    toolCallId: "call_a2_valid",
    status: "EFFECT_COMMITTED",
    resultJson: JSON.stringify({ finalText: "valid result", content: [{ type: "text", text: "valid result" }] })
  });

  const summary = reconcileWalOnStartup(stateDb, spillStore, sessId);

  // Corrupt unrecoverable rows must be quarantined in corruptReceipts
  const corruptKeys = summary.corruptReceipts.map((r) => r.idempotency_key);
  assert.ok(corruptKeys.includes(keyNull), "A2: NULL result_json must be in corruptReceipts");
  assert.ok(corruptKeys.includes(keyEmpty), "A2: empty result_json must be in corruptReceipts");
  assert.ok(corruptKeys.includes(keyMalformed), "A2: malformed result_json must be in corruptReceipts");

  // Replayed healthy committed rows must NOT include corrupt rows
  const replayedKeys = summary.replayedCommitted.map((r) => r.idempotency_key);
  assert.ok(!replayedKeys.includes(keyNull), "A2: NULL row must not be in replayedCommitted");
  assert.ok(!replayedKeys.includes(keyEmpty), "A2: empty row must not be in replayedCommitted");
  assert.ok(!replayedKeys.includes(keyMalformed), "A2: malformed row must not be in replayedCommitted");

  // Valid and recovered rows must be in replayedCommitted
  assert.ok(replayedKeys.includes(keyValid), "A2: Valid row must be in replayedCommitted");
  assert.ok(replayedKeys.includes(keyRecoverable), "A2: Recovered row must be in replayedCommitted");

  // Verify the recoverable row was actually repaired in DB
  const repairedRow = stateDb.getWalRow(keyRecoverable)!;
  const repairedParsed = JSON.parse(repairedRow.result_json!);
  assert.equal(repairedParsed.finalText, "recovered payload");

  // Corrupt evidence remains in SQLite intact
  assert.equal(stateDb.getWalRow(keyMalformed)!.result_json, "{");

  stateDb.close();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  console.log("  [PASS] A2 verified: Startup status-driven validation handles NULL/empty/malformed rows cleanly.");
}

// ============================================================================
// A3: Validate content-block payloads
// ============================================================================
function testA3ContentBlockPayloads() {
  console.log("--- A3: Discriminated union validation for content blocks ---");

  // Valid text block
  assert.equal(decodeCommittedReceipt({ content: [{ type: "text", text: "ok" }] }).ok, true);
  assert.equal(decodeCommittedReceipt({ content: [{ type: "text", text: "" }] }).ok, true, "Empty text is valid");

  // Invalid text block (missing or non-string text)
  const invalidText1 = decodeCommittedReceipt({ content: [{ type: "text" }] });
  assert.equal(invalidText1.ok, false);
  if (!invalidText1.ok) assert.match(invalidText1.reason, /text block at index 0 requires string text/);

  const invalidText2 = decodeCommittedReceipt({ content: [{ type: "text", text: 1234 }] });
  assert.equal(invalidText2.ok, false);
  if (!invalidText2.ok) assert.match(invalidText2.reason, /text block at index 0 requires string text/);

  // Valid image block
  const validImage = decodeCommittedReceipt({
    content: [{ type: "image", data: "base64data", mimeType: "image/png" }]
  });
  assert.equal(validImage.ok, true);

  // Invalid image block (missing/empty data or mimeType)
  const invalidImg1 = decodeCommittedReceipt({ content: [{ type: "image", data: "", mimeType: "image/png" }] });
  assert.equal(invalidImg1.ok, false);
  if (!invalidImg1.ok) assert.match(invalidImg1.reason, /image block at index 0 requires non-empty data and mimeType/);

  const invalidImg2 = decodeCommittedReceipt({ content: [{ type: "image", data: "base64", mimeType: "" }] });
  assert.equal(invalidImg2.ok, false);

  const invalidImg3 = decodeCommittedReceipt({ content: [{ type: "image" }] });
  assert.equal(invalidImg3.ok, false);

  // Unsupported block discriminator
  const unsupportedType = decodeCommittedReceipt({ content: [{ type: "audio", url: "http://example.com" }] });
  assert.equal(unsupportedType.ok, false);
  if (!unsupportedType.ok) assert.match(unsupportedType.reason, /UNSUPPORTED_CONTENT_BLOCK_TYPE/);

  console.log("  [PASS] A3 verified: Content block payloads strictly validated against discriminated union.");
}

// ============================================================================
// A4: Stop echoing corrupt input in diagnostics
// ============================================================================
async function testA4NoSecretEchoInDiagnostics() {
  console.log("--- A4: Redaction of corrupt input/secrets from diagnostics ---");

  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-wal-a4-"));
  const dbPath = path.join(tmpRoot, "state.db");
  const spillsDir = path.join(tmpRoot, "spills");
  const sessId = "sess_a4";
  const leafId = "leaf_a4";

  const secretMarker = "SUPER_SECRET_TOKEN_DO_NOT_LEAK_998877";
  const malformedJsonWithSecret = `{"unclosed_secret": "${secretMarker}"`;

  // 1. Decoder check
  const decodeRes = decodeCommittedReceipt(malformedJsonWithSecret);
  assert.equal(decodeRes.ok, false);
  if (!decodeRes.ok) {
    assert.match(decodeRes.reason, /JSON_SYNTAX_ERROR/);
    assert.equal(decodeRes.reason.includes(secretMarker), false, "Decoder reason must not contain secret!");
  }

  // 2. ensureNormalizedCommittedResult check
  const stateDb = new StateDb(dbPath, "power-loss-safe");
  const spillStore = new PrivateSpillStore({ rootDir: spillsDir, maxInlineBytes: 256, maxInlineLines: 10 });

  const outcome = ensureNormalizedCommittedResult({
    receipt: malformedJsonWithSecret,
    spillStore,
    sessionId: sessId
  });
  assert.equal(outcome.invalid, true);
  assert.equal(outcome.result.isError, true);
  assert.equal(outcome.result.finalText.includes(secretMarker), false, "finalText must not contain secret!");
  const detailsStr = JSON.stringify(outcome.result.details ?? {});
  assert.equal(detailsStr.includes(secretMarker), false, "details must not contain secret!");

  // 3. Direct replay through WAL spine
  const keyA4 = insertWalRow({
    stateDb,
    sessionId: sessId,
    leafId,
    toolCallId: "call_a4_leak_test",
    status: "EFFECT_COMMITTED",
    resultJson: malformedJsonWithSecret
  });

  const replayRes = await executeThroughWalSpine({
    stateDb,
    spillStore,
    sessionId: sessId,
    leafId,
    toolCallId: "call_a4_leak_test",
    toolName: "bash",
    mutabilityClass: "PURE_READ",
    args: { cmd: "test" },
    executeEffect: async () => ({ rawText: "unreached" })
  });

  assert.equal(replayRes.isError, true);
  assert.equal(replayRes.finalText.includes(secretMarker), false, "Replay finalText must not leak secret!");
  assert.equal(JSON.stringify(replayRes.details ?? {}).includes(secretMarker), false, "Replay details must not leak secret!");

  // 4. Startup reconciliation check (intercept console.warn to verify logs don't leak secret)
  const warnedLogs: string[] = [];
  const origWarn = console.warn;
  console.warn = (...args: any[]) => {
    warnedLogs.push(args.map(String).join(" "));
    origWarn(...args);
  };

  try {
    reconcileWalOnStartup(stateDb, spillStore, sessId);
  } finally {
    console.warn = origWarn;
  }

  const allLogs = warnedLogs.join("\n");
  assert.equal(allLogs.includes(secretMarker), false, "Startup console.warn must not leak secret!");

  // Forensic raw bytes remain in DB
  const rawInDb = stateDb.getWalRow(keyA4)!.result_json;
  assert.equal(rawInDb, malformedJsonWithSecret, "Forensic bytes safely retained in SQLite");

  stateDb.close();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  console.log("  [PASS] A4 verified: Corrupt inputs and embedded secrets are never echoed in diagnostics or logs.");
}

async function main() {
  await testA1MissingRawReceipts();
  await testA2StartupCommittedValidation();
  testA3ContentBlockPayloads();
  await testA4NoSecretEchoInDiagnostics();
  console.log("\n=== ALL BATCH A RECEIPT CORRUPTION REMEDIATIONS PASSED CLEANLY ===\n");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
